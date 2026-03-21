"""
Recruitment Sync Service
========================
Pushes a completed candidate from the WhatsApp chatbot to the
recruitment system's /api/chatbot/intake endpoint.

Called when conversation_state transitions to STATE_APPLICATION_COMPLETE.

Usage (in chatbot.py):
    from app.services.recruitment_sync import recruitment_sync
    await recruitment_sync.push(candidate, db)
"""

import os
import logging
import asyncio
import hashlib
import uuid
import httpx
from typing import Optional, Dict, Any

from sqlalchemy.orm import Session
from app import crud
from app.config import settings
from app.utils.candidate_validator import validate_candidate

logger = logging.getLogger(__name__)

# ── Retry configuration ───────────────────────────────────────────
SYNC_MAX_RETRIES: int = 3
SYNC_RETRY_BASE_DELAY: float = 2.0   # seconds; doubles each attempt (2 → 4 → 8)

# ── Config ────────────────────────────────────────────────────────────────────
RECRUITMENT_API_URL = settings.recruitment_api_url
CHATBOT_API_KEY = settings.chatbot_api_key
SYNC_ENABLED = settings.recruitment_sync_enabled

INTAKE_ENDPOINT = f"{RECRUITMENT_API_URL}/api/chatbot/intake"
TIMEOUT_SECONDS = 10.0  # Reduced from 20s — sync is now awaited, so keep it snappy


def _generate_idempotency_key(phone: str, job_interest: str) -> str:
    """
    Generate a deterministic idempotency key based on candidate phone + job interest.
    This prevents duplicate candidates on retry.
    """
    raw = f"{phone}:{job_interest}".lower().strip()
    return hashlib.sha256(raw.encode()).hexdigest()[:32]


def _is_retryable_error(status_code: Optional[int], exception: Optional[Exception] = None) -> bool:
    """
    Distinguish retryable (5xx/timeout/connection) vs non-retryable (4xx validation) errors.
    """
    if exception and isinstance(exception, (httpx.ConnectError, httpx.TimeoutException)):
        return True
    if status_code is None:
        return True  # Connection failed, no status code
    if status_code >= 500:
        return True
    if status_code == 429:
        return True  # Rate limited — retry
    # 4xx errors are non-retryable (validation, auth, etc.)
    return False


class RecruitmentSyncService:
    """
    Service that pushes candidate data to the recruitment system
    after the chatbot completes its intake flow.
    """

    async def push(
        self,
        candidate,
        db: Session,
        cv_bytes: bytes = None,
        cv_filename: str = None,
        additional_doc_bytes: bytes = None,
        additional_doc_filename: str = None,
    ) -> bool:
        """
        Main entry point. Validates, builds payload, posts to recruitment system,
        and stores the returned candidate/application IDs back in the chatbot DB.

        cv_bytes / cv_filename: raw file content passed directly from the webhook
        handler so no disk re-read is needed (important on ephemeral Cloud Run).

        Returns True on success, False on failure.
        Never raises exceptions — failures are logged but do not crash the chatbot.
        """
        if not SYNC_ENABLED:
            logger.info("RECRUITMENT_SYNC_ENABLED=false — skipping push to recruitment system")
            return False

        try:
            extracted = candidate.extracted_data or {}

            # ── Ensure job_interest is populated ──────────────────────────
            # For ad-triggered flows, job_interest may not have been captured
            # as a separate intake field — resolve it from the job cache.
            if not extracted.get("job_interest"):
                from app.knowledge import get_job_cache
                matched_id = extracted.get("selected_job_id") or extracted.get("matched_job_id") or extracted.get("ad_job_id")
                if matched_id:
                    job_info = get_job_cache().get(str(matched_id))
                    if job_info and job_info.get("title"):
                        extracted = {**extracted, "job_interest": job_info["title"]}
                        logger.info(
                            f"job_interest resolved from job cache: "
                            f"'{job_info['title']}' for candidate {candidate.id}"
                        )

            # Resolve job interest safely
            candidate_job_interest = getattr(candidate, 'job_interest', None) or extracted.get('job_interest', '') or extracted.get('job_interest_stated', '') or "Not Specified"
            candidate_safe_name = candidate.name or "Unknown Candidate"

            # ── Step 1: Validate before pushing ───────────────────────────
            validation = validate_candidate(
                phone=candidate.phone_number,
                name=candidate_safe_name,
                email=candidate.email,
                job_interest=candidate_job_interest,
                preferred_language=getattr(candidate.language_preference, 'value', 'en'),
                experience_years=candidate.experience_years,
                extracted_data=extracted
            )

            if not validation.is_valid:
                logger.error(
                    f"Candidate {candidate.id} failed validation — NOT pushing to recruitment: "
                    f"{validation.errors}"
                )
                return False

            if validation.warnings:
                logger.warning(
                    f"Candidate {candidate.id} has validation warnings: {validation.warnings}"
                )

            # ── Step 2: Build payload ──────────────────────────────────────
            payload = self._build_payload(candidate, extracted, cv_bytes=cv_bytes, cv_filename=cv_filename)

            # ── Step 2b: Generate idempotency key ────────────────────────
            idempotency_key = _generate_idempotency_key(
                candidate.phone_number,
                candidate_job_interest,
            )

            phone_hash = hashlib.sha256(candidate.phone_number.encode()).hexdigest()[:8]

            # ── Step 2c: Resolve CV bytes for multipart upload ───────────
            resolved_cv_bytes, resolved_cv_name = self._resolve_cv_bytes(
                candidate, extracted, cv_bytes=cv_bytes, cv_filename=cv_filename,
            )

            # Compute SHA-256 checksum for integrity verification
            cv_checksum = None
            if resolved_cv_bytes:
                cv_checksum = hashlib.sha256(resolved_cv_bytes).hexdigest()
                payload["cv_file_name"] = resolved_cv_name
                logger.debug(
                    f"[sync:{phone_hash}] CV ready: {resolved_cv_name} "
                    f"({len(resolved_cv_bytes)} bytes, sha256={cv_checksum[:16]}...)"
                )

            # ── Step 3: POST to recruitment system ────────────────────────
            logger.info(
                f"[sync:{phone_hash}] Pushing candidate {candidate.id} to {INTAKE_ENDPOINT} "
                f"(idempotency_key={idempotency_key[:12]}...)"
            )

            use_multipart = (resolved_cv_bytes is not None) or (additional_doc_bytes is not None)

            # ─ Retry loop with exponential backoff ──────────────────────────
            response = None
            last_err: Optional[Exception] = None
            for attempt in range(1, SYNC_MAX_RETRIES + 1):
                try:
                    async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
                        headers = {
                            "x-chatbot-api-key": CHATBOT_API_KEY,
                            "x-idempotency-key": idempotency_key,
                        }
                        if cv_checksum:
                            headers["x-cv-checksum"] = cv_checksum

                        if use_multipart:
                            # Primary path: multipart/form-data (handles large CVs)
                            import json as _json
                            
                            # Using a list of tuples for multiple files to support multiple 'additional_files' if needed
                            files_list = []
                            if resolved_cv_bytes:
                                files_list.append((
                                    "cv_file", (resolved_cv_name, resolved_cv_bytes, "application/octet-stream")
                                ))
                            
                            if additional_doc_bytes:
                                files_list.append((
                                    "additional_files", (additional_doc_filename or "document.pdf", additional_doc_bytes, "application/octet-stream")
                                ))

                            # Send JSON payload as a form field
                            data = {"payload": _json.dumps(payload)}
                            response = await client.post(
                                INTAKE_ENDPOINT,
                                data=data,
                                files=files_list,
                                headers=headers,
                            )
                        else:
                            # Fallback: JSON-only (no CV or tiny payload)
                            response = await client.post(
                                INTAKE_ENDPOINT,
                                json=payload,
                                headers=headers,
                            )
                    if response.status_code in (200, 201, 409):
                        break  # success or known duplicate — no retry needed

                    if not _is_retryable_error(response.status_code):
                        # 4xx validation error — retrying won't help
                        logger.warning(
                            f"[sync:{phone_hash}] Non-retryable error {response.status_code}, "
                            f"aborting sync"
                        )
                        break

                    # 5xx or rate-limited — retry
                    logger.warning(
                        f"[sync:{phone_hash}] Attempt {attempt}/{SYNC_MAX_RETRIES}: "
                        f"status {response.status_code} — will retry"
                    )
                except (httpx.ConnectError, httpx.TimeoutException) as e:
                    last_err = e
                    logger.warning(
                        f"[sync:{phone_hash}] Attempt {attempt}/{SYNC_MAX_RETRIES}: "
                        f"connection error ({type(e).__name__}) — will retry"
                    )
                    response = None

                if attempt < SYNC_MAX_RETRIES:
                    delay = SYNC_RETRY_BASE_DELAY * (2 ** (attempt - 1))
                    await asyncio.sleep(delay)

            # If all retries failed with retryable errors, persist to pending_sync table
            if response is None or (response and _is_retryable_error(response.status_code)):
                err_msg = str(last_err) if last_err else (
                    f"HTTP {response.status_code}" if response else "no response"
                )
                self._save_pending_sync(candidate, payload, idempotency_key, err_msg, db)
                candidate.cv_sync_status = "failed"
                db.commit()
                logger.error(
                    f"[sync:{phone_hash}] FAILED after {SYNC_MAX_RETRIES} retries: {err_msg}. "
                    f"Saved to pending_sync for background retry."
                )
                return False

            # ── Step 4: Handle response ────────────────────────────────────
            if response.status_code in (200, 201):
                data = response.json()
                recruitment_candidate_id = data.get("candidate_id")
                recruitment_application_id = data.get("application_id")
                intake_status = data.get("status", "unknown")

                logger.info(
                    f"[sync:{phone_hash}] SUCCESS — candidate {candidate.id} → "
                    f"recruitment_id={recruitment_candidate_id}, "
                    f"application_id={recruitment_application_id}, "
                    f"status={intake_status}"
                )

                # Store recruitment IDs back in chatbot DB
                updated_data = {**extracted}
                updated_data["recruitment_candidate_id"] = recruitment_candidate_id
                updated_data["recruitment_application_id"] = recruitment_application_id
                updated_data["recruitment_sync_status"] = intake_status

                candidate.extracted_data = updated_data
                candidate.cv_sync_status = "synced" if resolved_cv_bytes else candidate.cv_sync_status
                db.commit()

                return True

            elif response.status_code == 409:
                # Duplicate — already exists, not really an error
                logger.info(
                    f"[sync:{phone_hash}] Candidate already exists in "
                    f"recruitment system (409 Conflict) — skipping"
                )
                return True

            elif response.status_code in (400, 422):
                logger.error(
                    f"[sync:{phone_hash}] VALIDATION ERROR (non-retryable): "
                    f"{response.status_code} — {response.text[:500]}"
                )
                return False

            else:
                logger.error(
                    f"[sync:{phone_hash}] FAILED: "
                    f"HTTP {response.status_code} — {response.text[:300]}"
                )
                return False

        except httpx.TimeoutException:
            logger.error(
                f"Recruitment sync TIMEOUT for candidate {candidate.id} — "
                f"recruitment system at {RECRUITMENT_API_URL} did not respond "
                f"within {TIMEOUT_SECONDS}s. Saving to pending_sync."
            )
            try:
                payload = self._build_payload(candidate, extracted, cv_bytes=cv_bytes, cv_filename=cv_filename)
                idem_key = _generate_idempotency_key(
                    candidate.phone_number,
                    extracted.get("job_interest", ""),
                )
                self._save_pending_sync(candidate, payload, idem_key, "Timeout", db)
            except Exception:
                pass
            return False
        except httpx.ConnectError:
            logger.error(
                f"Recruitment sync CONNECT ERROR for candidate {candidate.id} — "
                f"cannot reach {RECRUITMENT_API_URL}. Saving to pending_sync."
            )
            try:
                payload = self._build_payload(candidate, extracted, cv_bytes=cv_bytes, cv_filename=cv_filename)
                idem_key = _generate_idempotency_key(
                    candidate.phone_number,
                    extracted.get("job_interest", ""),
                )
                self._save_pending_sync(candidate, payload, idem_key, "ConnectError", db)
            except Exception:
                pass
            return False
        except Exception as e:
            logger.error(
                f"Recruitment sync UNEXPECTED ERROR for candidate {candidate.id}: {e}",
                exc_info=True
            )
            return False

    def _build_payload(
        self,
        candidate,
        extracted: Dict[str, Any],
        cv_bytes: bytes = None,
        cv_filename: str = None,
    ) -> Dict[str, Any]:
        """Assemble the complete payload dict for POST /api/chatbot/intake."""

        # Language — handle both string and enum.
        language = 'en'
        language_register = extracted.get("language_register") or None
        if hasattr(candidate, 'language_preference'):
            lang = candidate.language_preference
            language = lang.value if hasattr(lang, 'value') else str(lang)
        if language_register:
            language = language_register

        # Skills — list to comma-separated string
        skills = candidate.skills
        if isinstance(skills, list):
            skills = ', '.join(str(s) for s in skills)

        cv_file_path = getattr(candidate, 'resume_file_path', None) or extracted.get("resume_file_path")

        return {
            # Core identity
            "phone": candidate.phone_number,
            "name": candidate.name or "Unknown Candidate",
            "email": candidate.email,
            "preferred_language": language,
            "source": "whatsapp",

            # Profile
            "skills": skills or None,
            "experience_years": int(candidate.experience_years) if candidate.experience_years else None,
            "highest_qualification": getattr(candidate, 'highest_qualification', None),

            # Application context
            "job_interest": getattr(candidate, 'job_interest', None) or extracted.get("job_interest", "") or extracted.get("job_interest_stated", "") or "Not Specified",
            "destination_country": extracted.get("destination_country", ""),

            # Job assignment (from job-aware match or ad)
            "job_id": extracted.get("selected_job_id") or extracted.get("matched_job_id") or extracted.get("ad_job_id"),
            "ad_ref": extracted.get("ad_ref"),

            # CV data (base64 excluded — sent via multipart when possible)
            "cv_file_path": cv_file_path,
            "cv_file_name": cv_filename,
            "cv_raw_text": extracted.get("raw_cv_text"),
            "cv_parsed_data": {
                "language_register": language_register or language,
                **{
                    k: v for k, v in extracted.items()
                    if k not in {
                        "job_interest", "destination_country", "experience_years_stated",
                        "ad_ref", "ad_job_id", "ad_project_id", "ad_context",
                        "recruitment_candidate_id", "recruitment_application_id",
                        "recruitment_sync_status",
                        "selected_job_id", "selected_job_title",
                        "matched_job_id", "job_requirements",
                    }
                },
            },

            # Cross-system reference
            "chatbot_candidate_id": candidate.id,
        }

    def _resolve_cv_bytes(
        self,
        candidate,
        extracted: Dict[str, Any],
        cv_bytes: bytes = None,
        cv_filename: str = None,
    ) -> tuple:
        """
        Resolve CV raw bytes and filename from all available sources.
        Returns (bytes, filename) — either may be None.
        """
        cv_file_path = getattr(candidate, 'resume_file_path', None) or extracted.get("resume_file_path")
        file_bytes = cv_bytes
        file_name = cv_filename

        # Fast path: caller passed bytes directly
        if file_bytes:
            if not file_name:
                file_name = os.path.basename(cv_file_path) if cv_file_path else f"cv_{candidate.phone_number}.pdf"
            return file_bytes, file_name

        # Try reading from disk
        if cv_file_path and os.path.exists(cv_file_path):
            try:
                with open(cv_file_path, "rb") as f:
                    file_bytes = f.read()
                file_name = os.path.basename(cv_file_path)
                return file_bytes, file_name
            except Exception as e:
                logger.error(f"Error reading CV file '{cv_file_path}': {e}")

        # Fallback: scan uploads/cv_uploads/ directory
        try:
            from app.config import settings as _settings
            safe_phone = candidate.phone_number.replace("+", "").replace(" ", "").replace("-", "")
            cv_uploads_dir = os.path.join(_settings.upload_dir, "cv_uploads")
            if os.path.isdir(cv_uploads_dir):
                matches = sorted(
                    [f for f in os.listdir(cv_uploads_dir) if f.startswith(safe_phone)],
                    reverse=True,
                )
                if matches:
                    fallback_path = os.path.join(cv_uploads_dir, matches[0])
                    with open(fallback_path, "rb") as f:
                        file_bytes = f.read()
                    file_name = matches[0]
                    logger.info(f"CV fallback: loaded '{file_name}' for candidate {candidate.phone_number}")
                    return file_bytes, file_name
        except Exception as e:
            logger.error(f"CV fallback lookup error: {e}")

        return None, None

    def _save_pending_sync(self, candidate, payload: dict, idempotency_key: str, error_msg: str, db: Session) -> None:
        """
        Persist a failed sync attempt to the pending_sync table for background retry.
        Also marks the candidate's extracted_data with recruitment_sync_status=pending_retry.
        """
        try:
            from app.models import PendingSync

            # Upsert: if a pending_sync row for this idempotency_key already exists, update it
            existing = db.query(PendingSync).filter(
                PendingSync.idempotency_key == idempotency_key
            ).first()

            if existing:
                existing.attempts += 1
                existing.last_error = error_msg[:500]
                existing.payload = payload
            else:
                pending = PendingSync(
                    candidate_id=candidate.id,
                    idempotency_key=idempotency_key,
                    payload=payload,
                    attempts=1,
                    last_error=error_msg[:500],
                    status="pending",
                )
                db.add(pending)

            # Also mark on candidate
            extracted = dict(candidate.extracted_data or {})
            extracted["recruitment_sync_status"] = "pending_retry"
            candidate.extracted_data = extracted

            db.commit()
            logger.info(
                f"Pending sync saved for candidate {candidate.id} "
                f"(idempotency_key={idempotency_key[:12]}...)"
            )
        except Exception as e:
            logger.error(f"Failed to save pending sync state: {e}")

    async def retry_pending(self, db: Session) -> None:
        """
        Background worker: find pending_sync rows with status='pending'
        and attempt to push them again.  Called on startup and periodically.
        """
        try:
            from app.models import PendingSync
            MAX_PENDING_ATTEMPTS = 10

            pending_rows = (
                db.query(PendingSync)
                .filter(
                    PendingSync.status == "pending",
                    PendingSync.attempts < MAX_PENDING_ATTEMPTS,
                )
                .order_by(PendingSync.created_at.asc())
                .limit(50)
                .all()
            )

            if not pending_rows:
                return

            logger.info(f"Retrying {len(pending_rows)} pending sync(s)...")

            for row in pending_rows:
                try:
                    async with httpx.AsyncClient(timeout=TIMEOUT_SECONDS) as client:
                        response = await client.post(
                            INTAKE_ENDPOINT,
                            json=row.payload,
                            headers={
                                "x-chatbot-api-key": CHATBOT_API_KEY,
                                "x-idempotency-key": row.idempotency_key,
                            },
                        )

                    row.attempts += 1

                    if response.status_code in (200, 201, 409):
                        row.status = "success"
                        logger.info(
                            f"Pending sync SUCCESS for candidate {row.candidate_id} "
                            f"(attempt {row.attempts})"
                        )
                        # Update candidate sync status
                        from app.models import Candidate
                        cand = db.query(Candidate).get(row.candidate_id)
                        if cand:
                            extracted = dict(cand.extracted_data or {})
                            if response.status_code in (200, 201):
                                data = response.json()
                                extracted["recruitment_candidate_id"] = data.get("candidate_id")
                                extracted["recruitment_application_id"] = data.get("application_id")
                            extracted["recruitment_sync_status"] = "synced"
                            cand.extracted_data = extracted
                    elif not _is_retryable_error(response.status_code):
                        row.status = "failed"
                        row.last_error = f"Non-retryable: HTTP {response.status_code}"
                        logger.warning(
                            f"Pending sync PERMANENTLY FAILED for candidate {row.candidate_id}: "
                            f"HTTP {response.status_code}"
                        )
                    else:
                        row.last_error = f"HTTP {response.status_code}"
                        logger.warning(
                            f"Pending sync still failing for candidate {row.candidate_id}: "
                            f"HTTP {response.status_code} (attempt {row.attempts})"
                        )

                except (httpx.ConnectError, httpx.TimeoutException) as e:
                    row.attempts += 1
                    row.last_error = f"{type(e).__name__}: {e}"
                    logger.warning(
                        f"Pending sync retry connection error for candidate {row.candidate_id}: {e}"
                    )
                except Exception as e:
                    row.attempts += 1
                    row.last_error = str(e)[:500]
                    logger.error(f"Pending sync retry error: {e}")

                # Mark as permanently failed if max attempts reached
                if row.attempts >= MAX_PENDING_ATTEMPTS and row.status == "pending":
                    row.status = "failed"
                    logger.error(
                        f"Pending sync EXHAUSTED for candidate {row.candidate_id} "
                        f"after {row.attempts} attempts"
                    )

            db.commit()

        except Exception as e:
            logger.error(f"retry_pending error: {e}")


# Singleton instance used throughout the chatbot
recruitment_sync = RecruitmentSyncService()
