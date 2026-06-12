from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import uuid
from typing import Optional, Dict, Any

import httpx
from sqlalchemy.orm import Session

from app.config import settings
from app.models import PendingSync
from app.utils.phone import normalize_phone_or_raw

logger = logging.getLogger(__name__)

RECRUITMENT_API_URL = os.getenv("RECRUITMENT_API_URL", settings.recruitment_api_url)
# Rich intake endpoint: stores the CV to GCS (saveCVFile), persists parsed_data,
# merges age/height/skills/licenses/previous_employer into candidates.metadata,
# and handles additional documents + applications + general pool. The old
# /api/chatbot-sync/intake path stored non-retrievable local CV paths and dropped
# most details — see plan Phase A.
SYNC_ENDPOINT = os.getenv("RECRUITMENT_SYNC_ENDPOINT", "/api/chatbot/intake")
CHATBOT_API_KEY = os.getenv("CHATBOT_API_KEY", settings.chatbot_api_key or "")
SYNC_ENABLED = os.getenv(
    "RECRUITMENT_SYNC_ENABLED",
    "true" if settings.recruitment_sync_enabled else "false",
).lower() == "true"


class RecruitmentSyncService:
    def _resolve_job_interest(self, candidate) -> Optional[str]:
        extracted = candidate.extracted_data if isinstance(candidate.extracted_data, dict) else {}
        agent_state = candidate.agent_state if isinstance(candidate.agent_state, dict) else {}
        collected = agent_state.get("collected_data") if isinstance(agent_state.get("collected_data"), dict) else {}
        ad_context = agent_state.get("ad_context") if isinstance(agent_state.get("ad_context"), dict) else {}
        # Ad-flow candidates: the job they clicked on is stashed in
        # state["ad_context"]["job_title"], not in extracted/collected. Without
        # this fallback, _resolve_job_interest returns None and push() bails
        # out with "Sync deferred — job_role not yet collected" — exactly the
        # path that left CV Manager rows empty even though the candidate
        # finished the conversation and saw "application submitted".
        return (
            extracted.get("job_interest")
            or extracted.get("job_role")
            or collected.get("job_role")
            or ad_context.get("job_title")
        )

    def _build_payload(self, candidate, force_general_pool: bool = False) -> Dict[str, Any]:
        extracted = candidate.extracted_data if isinstance(candidate.extracted_data, dict) else {}
        agent_state = candidate.agent_state if isinstance(candidate.agent_state, dict) else {}
        collected = agent_state.get("collected_data") if isinstance(agent_state.get("collected_data"), dict) else {}

        preferred_language = (
            extracted.get("language_register")
            or agent_state.get("locked_language")
            or getattr(candidate.language_preference, "value", None)
        )
        job_interest = self._resolve_job_interest(candidate) or "General"

        # Pull country from collected_data or extracted CV data
        country = collected.get("country") or extracted.get("country")

        # Build skills list — prefer list from collected_data, fall back to candidate.skills text
        skills_list = collected.get("skills")
        if not isinstance(skills_list, list):
            skills_list = []
        if not skills_list and candidate.skills:
            if isinstance(candidate.skills, str):
                skills_list = [s.strip() for s in candidate.skills.split(",") if s.strip()]

        payload: Dict[str, Any] = {
            "phone": normalize_phone_or_raw(candidate.phone_number),
            "name": candidate.name or "Pending AI Extraction",
            # Allow None so backend can distinguish "unknown" from "genuinely 0 years"
            "experience_years": candidate.experience_years,
            "job_interest": job_interest,
            "job_role": job_interest,  # alias for backends that expect job_role
        }

        if country:
            payload["country"] = country
            payload["destination_country"] = country  # alias used by CV manager
        if candidate.email:
            payload["email"] = candidate.email
        if skills_list:
            payload["skills"] = skills_list[:20]
        if preferred_language:
            payload["preferred_language"] = preferred_language

        # Demographic data — the backend reads these into candidates.metadata
        # so the CV Manager can show age/height without a separate fetch.
        # Send both at top level AND nested under cv_parsed_data so older /
        # newer backend variants both pick them up.
        age_val = getattr(candidate, "age", None)
        if age_val is None and isinstance(collected.get("age"), (int, float)):
            age_val = int(collected["age"])
        height_val = collected.get("height_cm") or extracted.get("height_cm")
        try:
            height_val = int(height_val) if height_val is not None else None
        except (TypeError, ValueError):
            height_val = None

        # Gender — the backend matcher uses this as a HARD filter so a
        # gendered vacancy (e.g. "female") never matches the wrong candidate
        # (B013). Normalise the various spellings to canonical male/female.
        gender_raw = (
            getattr(candidate, "gender", None)
            or collected.get("gender")
            or extracted.get("gender")
        )
        gender_val = None
        if isinstance(gender_raw, str):
            g = gender_raw.strip().lower()
            if g in ("m", "male", "man", "boy"):
                gender_val = "male"
            elif g in ("f", "female", "woman", "girl"):
                gender_val = "female"

        # Seed from the full CV extraction blob (work_history, certifications,
        # languages, current_company, qualification, ai_insights) so the CV
        # Manager shows the complete parse. Chat-collected fields overlay below.
        cv_full = agent_state.get("cv_parsed_data") or extracted.get("cv_parsed_data")
        cv_parsed: Dict[str, Any] = dict(cv_full) if isinstance(cv_full, dict) else {}
        if age_val is not None:
            payload["age"] = age_val
            cv_parsed["age"] = age_val
        if height_val is not None:
            payload["height_cm"] = height_val
            cv_parsed["height_cm"] = height_val
        # Fall back to the full CV-parse blob (ExtractedProfile.to_dict carries a
        # flat `gender`) if chat/collected fields didn't surface gender.
        if gender_val is None and isinstance(cv_parsed.get("gender"), str):
            g2 = cv_parsed["gender"].strip().lower()
            if g2 in ("m", "male", "man", "boy"):
                gender_val = "male"
            elif g2 in ("f", "female", "woman", "girl"):
                gender_val = "female"
        if gender_val is not None:
            payload["gender"] = gender_val
            cv_parsed["gender"] = gender_val
        if candidate.experience_years is not None:
            cv_parsed["total_experience_years"] = candidate.experience_years
        if skills_list:
            cv_parsed["technical_skills"] = skills_list[:20]
        if preferred_language:
            cv_parsed["language_register"] = preferred_language
        # Surface CV mismatches if the parser produced them
        mismatches = extracted.get("mismatches")
        if isinstance(mismatches, list) and mismatches:
            cv_parsed["mismatches"] = mismatches

        # Per-job collected fields — anything the ad-intake state machine
        # asked the candidate for, beyond the core name/age/email/experience.
        # Backend (chatbot-intake.js) merges these into candidates.metadata so
        # recruiters see the full profile in CV Manager. Send at top level AND
        # under cv_parsed_data so older / newer backend variants both pick up.
        for field in (
            "passport_number",
            "nic",
            "date_of_birth",
            "dob",
            "english_proficiency",
            "phone_alternative",
            "licenses",
            "previous_employer",
        ):
            val = collected.get(field)
            if val in (None, "", []):
                val = extracted.get(field)
            if val in (None, "", []):
                continue
            payload[field] = val
            cv_parsed[field] = val

        if cv_parsed:
            payload["cv_parsed_data"] = cv_parsed

        # Ad-attribution: when the candidate arrived from a FB/IG job ad, surface
        # both the ad_ref (so backend tracking knows the source link) and the
        # resolved job_id (so the backend creates an applications row linking
        # this candidate to the specific job they clicked).
        ad_ref = extracted.get("ad_ref")
        ad_job_id = (
            extracted.get("ad_job_id")
            or agent_state.get("active_job_id")
        )
        if ad_ref:
            payload["ad_ref"] = ad_ref
        if ad_job_id:
            payload["job_id"] = ad_job_id
            payload["ad_job_id"] = ad_job_id  # alias for backends that key on ad_job_id

        # General-pool routing: when the chatbot saves a lead with no matching
        # job, it sets remarks + preferences_log + general_pool_optin in state.
        # Send those through so the backend stores them on the candidate row
        # and copies them into the general_pool metadata.
        remarks = agent_state.get("remarks")
        if remarks:
            payload["remarks"] = remarks
        prefs_log = agent_state.get("preferences_log")
        if isinstance(prefs_log, list) and prefs_log:
            payload["preferences_log"] = prefs_log
        if collected.get("general_pool_optin") or force_general_pool:
            payload["is_general_pool"] = True

        return payload

    def _resolve_cv_path(self, candidate, cv_path: Optional[str]) -> Optional[str]:
        return cv_path or getattr(candidate, "resume_file_path", None)

    def _build_headers(self) -> Dict[str, str]:
        headers: Dict[str, str] = {}
        if CHATBOT_API_KEY:
            headers["x-chatbot-api-key"] = CHATBOT_API_KEY
        headers["x-trace-id"] = str(uuid.uuid4())[:8]
        return headers

    def _idempotency_key(self, payload: Dict[str, Any]) -> str:
        # Key on phone only — full-payload hashing caused new keys whenever
        # mutable fields like name changed mid-conversation, producing duplicate
        # CRM records for the same candidate.
        phone = payload.get("phone", "unknown")
        raw = f"phone:{phone}:v1"
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    async def _post_payload(self, payload: Dict[str, Any], cv_path: Optional[str]) -> tuple[bool, Optional[str]]:
        url = f"{RECRUITMENT_API_URL}{SYNC_ENDPOINT}"
        data = {"payload": json.dumps(payload)}
        headers = self._build_headers()

        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                if cv_path and os.path.exists(cv_path):
                    # Read file fully into memory before the async post so the
                    # context manager does not close the handle mid-upload.
                    with open(cv_path, "rb") as fh:
                        file_bytes = fh.read()
                    mime = "application/pdf"
                    if cv_path.lower().endswith((".jpg", ".jpeg", ".png")):
                        mime = "image/jpeg"
                    elif cv_path.lower().endswith(".docx"):
                        mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                    files = {
                        "cv_file": (os.path.basename(cv_path), file_bytes, mime)
                    }
                    response = await client.post(url, data=data, files=files, headers=headers)
                else:
                    response = await client.post(url, data=data, headers=headers)

            if response.status_code in (200, 201):
                return True, None
            return False, f"status {response.status_code}: {response.text[:200]}"
        except Exception as exc:
            return False, str(exc)

    async def push_profile_photo(
        self,
        candidate,
        photo_bytes: bytes,
        mime_type: str = "image/jpeg",
        filename: str = "photo.jpg",
    ) -> bool:
        """Push a chatbot-detected person-photo to the backend as the candidate's
        profile picture (#6). The backend uploads it to GCS and sets
        candidates.photo_url + photo_source='auto', skipping if a recruiter has
        manually set+locked the avatar. Best-effort: logs and swallows errors so
        a failed avatar push never breaks the media-handling flow."""
        if not photo_bytes:
            return False
        phone = getattr(candidate, "phone_number", None)
        if not phone:
            return False
        url = f"{RECRUITMENT_API_URL}/api/chatbot/set-profile-photo"
        payload = {
            "phone": phone,
            "base64": base64.b64encode(photo_bytes).decode("ascii"),
            "mime_type": mime_type,
            "filename": filename,
        }
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                response = await client.post(url, json=payload, headers=self._build_headers())
            if response.status_code in (200, 201):
                return True
            logger.warning("profile-photo push: status %s %s", response.status_code, response.text[:160])
            return False
        except Exception as exc:
            logger.warning("profile-photo push failed: %s", exc)
            return False

    def _queue_pending(
        self,
        db: Optional[Session],
        candidate_id: int,
        payload: Dict[str, Any],
        cv_path: Optional[str],
        error: Optional[str],
    ) -> None:
        if db is None:
            return

        queued_payload = {"payload": payload, "cv_path": cv_path}
        key = self._idempotency_key(queued_payload)
        existing = db.query(PendingSync).filter(PendingSync.idempotency_key == key).first()
        if existing:
            existing.status = "pending"
            existing.last_error = error
            existing.attempts = int(existing.attempts or 0) + 1
            db.commit()
            return

        record = PendingSync(
            candidate_id=candidate_id,
            idempotency_key=key,
            payload=queued_payload,
            attempts=1,
            last_error=error,
            status="pending",
        )
        db.add(record)
        db.commit()

    async def push(
        self,
        candidate,
        db: Optional[Session] = None,
        cv_path: Optional[str] = None,
    ) -> bool:
        """Send candidate data and (optionally) the CV file to the CRM."""
        if not SYNC_ENABLED:
            return False

        # Partial-lead policy: save the candidate as soon as we have a NAME so
        # name/age/email/CV are never lost, then enrich on later syncs (push is
        # idempotent on phone). If the job interest is still unknown — and the
        # candidate isn't an ad/general-pool flow — save them as a general-pool
        # lead (backend routes is_general_pool=true → status 'future_pool') so a
        # recruiter can follow up rather than the data being dropped entirely.
        job_interest = self._resolve_job_interest(candidate)
        agent_state = candidate.agent_state if isinstance(candidate.agent_state, dict) else {}
        collected = agent_state.get("collected_data") if isinstance(agent_state.get("collected_data"), dict) else {}
        extracted = candidate.extracted_data if isinstance(candidate.extracted_data, dict) else {}
        is_general_pool = bool(collected.get("general_pool_optin"))
        has_ad_job = bool(extracted.get("ad_job_id") or agent_state.get("active_job_id"))
        job_unknown = (not job_interest or job_interest.strip().lower() in ("general", ""))

        # Need at least a name to make a useful CRM lead. Without one there's
        # nothing worth saving yet — defer to a later turn.
        has_name = bool((candidate.name or "").strip()) or bool(str(collected.get("name") or "").strip())
        if not has_name:
            logger.info(
                "Sync deferred for %s — no name captured yet", candidate.phone_number
            )
            return False

        # CV is the hard gate for general-pool routing: the backend moves
        # is_general_pool=true leads to status 'future_pool', but a lead with no
        # CV on file must stay 'New' (it can't satisfy the New→Screening CV gate).
        # Only force the general pool for a partial/unknown-job lead once a CV
        # actually exists — via the cv_uploaded signal (state/collected), the
        # persisted resume_file_path, or the cv_path being uploaded on this push.
        has_cv = (
            bool(agent_state.get("cv_uploaded"))
            or bool(collected.get("cv_uploaded"))
            or bool(collected.get("cv"))
            or bool(getattr(candidate, "resume_file_path", None))
            or bool(cv_path)
        )

        force_general_pool = (
            job_unknown and not is_general_pool and not has_ad_job and has_cv
        )
        if force_general_pool:
            logger.info(
                "Partial-lead sync for %s — job unknown, CV on file, saving to general pool",
                candidate.phone_number,
            )

        payload = self._build_payload(candidate, force_general_pool=force_general_pool)
        resolved_cv = self._resolve_cv_path(candidate, cv_path)
        ok, error = await self._post_payload(payload, resolved_cv)

        if ok:
            if db is not None:
                candidate.cv_sync_status = "synced"
                db.commit()
            logger.info(
                "Recruitment sync succeeded for %s job_role=%s",
                candidate.phone_number,
                payload.get("job_interest"),
            )
            return True

        if db is not None:
            candidate.cv_sync_status = "failed"
            db.commit()
        self._queue_pending(db, candidate.id, payload, resolved_cv, error)
        logger.warning("Recruitment sync failed for %s: %s", candidate.phone_number, error)
        return False

    async def retry_pending(self, db: Session) -> None:
        if not SYNC_ENABLED:
            return

        pending_items = (
            db.query(PendingSync)
            .filter(PendingSync.status == "pending")
            .order_by(PendingSync.created_at.asc())
            .limit(25)
            .all()
        )

        for item in pending_items:
            payload = item.payload.get("payload") if isinstance(item.payload, dict) else None
            cv_path = item.payload.get("cv_path") if isinstance(item.payload, dict) else None
            if not payload:
                item.status = "failed"
                item.last_error = "missing payload"
                db.commit()
                continue

            ok, error = await self._post_payload(payload, cv_path)
            if ok:
                item.status = "success"
                item.last_error = None
            else:
                item.attempts = int(item.attempts or 0) + 1
                item.last_error = error
                if item.attempts >= 5:
                    item.status = "failed"
            db.commit()


recruitment_sync = RecruitmentSyncService()
