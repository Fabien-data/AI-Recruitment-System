"""
Chatbot Engine — Dewan Consultants Receptionist Flow
=====================================================
Guides candidates through a structured intake:
  1. Welcome & confirm intent to apply
  2. Ask: What job/role?
  3. Ask: Which country?
  4. Ask: Years of experience?
  5. Ask: Please send your CV
  6. Process CV → fill gaps → complete application

Stores intake answers in candidate.extracted_data JSON (no migration needed).
"""

import logging
import re
import random
import asyncio
import json
import base64
import httpx
from typing import Optional, Dict, Any, Union

from sqlalchemy.orm import Session

from app.config import settings
from app.nlp.language_detector import (
    detect_language, is_greeting, detect_language_switch_request
)
from app.nlp.sentiment_analyzer import analyze_sentiment, get_de_escalation
from app.cv_parser.text_extractor import text_extractor, CVData
from app.cv_parser.document_processor import get_document_processor
from app.cv_parser.intelligent_extractor import ExtractedCVData
from app.llm.rag_engine import rag_engine
from app.llm.prompt_templates import PromptTemplates
from app.utils.file_handler import file_manager
from app import crud
from app.schemas import ConversationCreate, CandidateUpdate, MessageTypeEnum
from app.database import SessionLocal
from app.services.ad_context_service import ad_context_service
from app.services.recruitment_sync import recruitment_sync
from app.services.vacancy_service import vacancy_service
from app.utils.meta_client import meta_client
from app.knowledge import get_job_cache, refresh_job_cache


logger = logging.getLogger(__name__)


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _first_name(full_name: Optional[str]) -> str:
    if not full_name:
        return ""
    return full_name.strip().split()[0]


def _pick(options: list) -> str:
    return random.choice(options)


# ─── Intent / keyword detection ──────────────────────────────────────────────

_APPLY_RE = re.compile(
    r'\b(yes|yeah|yep|yup|sure|ok|okay|apply|want to apply|interested|'
    r'ready|let\'?s go|start|begin|'
    # Sinhala script
    r'ඔව්|හරි|ආව|apply කරන්|කැමතියි|ඕනෑ|'
    # Tamil script
    r'ஆம்|சரி|விண்ணப்பிக்க|ஆர்வம்|'
    # Singlish (romanized Sinhala) -- from word list
    r'ow|hari|kemathi|honda|niyamai|puluwan|karanna|applay|'
    r'apply karanna|wadeema hadanna|wadeema ganna|'
    # Tanglish (romanized Tamil)
    r'aama|seri|sari|aam|pannalaam|pogalam|pannuven|'
    r'apply pannuren|apply panren|submit pannuren)\b',
    re.IGNORECASE
)

_NO_RE = re.compile(
    r'\b(no|nope|not now|later|maybe later|'
    # Sinhala script
    r'නෑ|ඒ නෑ|එපා|'
    # Tamil script
    r'இல்லை|வேண்டாம்|'
    # Singlish
    r'nehe|neha|epa|epaa|naha|behe|'
    # Tanglish
    r'illai|illada|illa|ille|venaam|vendaam|venam)\b',
    re.IGNORECASE
)

_QUESTION_RE = re.compile(
    r'\b(what|how|tell me|info|about|when|salary|visa|process|requirement|'
    r'where|vacancy|job|position|benefit|'
    # Tamil script
    r'மோகந|'
    # Sinhala script
    r'මොකද|කොහොமද|ගැන|'
    # Singlish question words -- from word list
    r'mokakda|mona|kohe|monawada|kohomada|kiyannada|'
    # Tanglish question words
    r'enna|yenna|epdi|eppo|evvalo|yaaru)\b',
    re.IGNORECASE
)

_NO_CV_RE = re.compile(
    r"("
    r"\b(no|dont|don't|do not|without|haven't|have not|cant|can't)\b.{0,16}\b(cv|resume|document|pdf|word)\b|"
    r"\b(cv|resume)\b.{0,16}\b(no|dont|don't|do not|without|nehe|naha|nathi|illa|illai)\b|"
    r"\bcv\s*(nehe|naha|nathi|illa|illai)\b"
    r")",
    re.IGNORECASE,
)


def _is_apply_intent(text: str) -> bool:
    return bool(_APPLY_RE.search(text))


def _is_no_intent(text: str) -> bool:
    return bool(_NO_RE.search(text))


def _is_question(text: str) -> bool:
    return bool(_QUESTION_RE.search(text)) or '?' in text


def _is_no_cv_message(text: str) -> bool:
    return bool(_NO_CV_RE.search(text))


def _is_vacancy_question(text: str) -> bool:
    """True when user explicitly asks about available vacancies / job listings."""
    t = text.lower()
    vacancy_keywords = [
        'vacanc', 'opening', 'available job', 'what job', 'which job',
        'job list', 'any job', 'what position', 'what role',
        'current job', 'job available', 'show job', 'list job',
        # additional patterns
        'job vacancies', 'vacancies available', 'available vacancies',
        'jobs available', 'show me jobs', 'list of job', 'any vacancy',
        # Sinhala script
        'රැකියා', 'කාලියි', 'vacancies',
        # Tamil script
        'காலியிட', 'வேலை வாய்ப்பு', 'வேலைகள்',
        # Romanized Tamil (Tanglish) — "enna" = what, "irriki/irukku" = there are
        'enna job', 'enna enna job', 'job enna', 'position enna',
        'job irriki', 'job irukku', 'job iruku', 'job ulladha', 'job ullada',
        'job irunthal', 'velai irriki', 'velai irukku', 'evvalo job',
        'paniyidam', 'paniyidangal', 'veli naadu job', 'job tharanga',
        # Romanized Sinhala (Singlish) — "mokakda" = what, "thiyanawa" = there is
        'mokakda job', 'job mokakda', 'job thiyanawada', 'job tiyenawada',
        'ewanda job', 'job ewanda', 'job karanna', 'job list karanna',
        'kadaima job', 'job avida',
    ]
    if any(kw in t for kw in vacancy_keywords):
        return True
    # "what are the jobs" / "what jobs" / "what vacancies"
    if re.search(r'what\s+(are\s+)?(the\s+)?(job|vacanc|position|role|opening)', t):
        return True
    # "what are the vacancies" / "what vacancies are there"
    if re.search(r'what\s+.*\bvacancies?\b', t):
        return True
    # Romanized Tamil: "enna + <something> + irriki/irukku" pattern
    if re.search(r'\benna\b.{0,30}\b(irriki|irukku|iruku|ullada|ulladha)\b', t):
        return True
    # Romanized Sinhala: "mokakda" or "mona" near "job" or "position"
    if re.search(r'\b(mokakda|mona|ewe)\b.{0,20}\b(job|vacanci|position|role)\b', t):
        return True
    return False


def _normalize_text(text: str) -> str:
    """Collapse spaces and strip for friendlier parsing."""
    if not text:
        return ""
    return " ".join(text.strip().split())


# Words that might mean years (for typo-tolerant experience parsing)
_NUMBER_WORDS = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
    "එක": 1, "දෙක": 2, "තුන": 3, "හතර": 4, "පහ": 5,
    "ஒன்று": 1, "இரண்டு": 2, "மூன்று": 3, "நான்கு": 4, "ஐந்து": 5,
}


def _extract_years(text: str) -> Optional[int]:
    """Pull a number of years from a free-text response. Tolerates number words."""
    text = _normalize_text(text)
    match = re.search(r'\b(\d+)\s*(?:years?|yrs?|வருடம்|ஆண்டுகள்|අවුරුදු)?\b', text, re.IGNORECASE)
    if match:
        try:
            return int(match.group(1))
        except ValueError:
            return None
    for word, num in _NUMBER_WORDS.items():
        if re.search(r'\b' + re.escape(word) + r'\b', text, re.IGNORECASE):
            return num
    return None


# ─── Main Engine ─────────────────────────────────────────────────────────────

_COUNTRY_MASTER_MAP = {
    # ── UAE / Dubai ──────────────────────────────────────────────────────────
    'dubai': 'United Arab Emirates', 'uae': 'United Arab Emirates',
    'abu dhabi': 'United Arab Emirates', 'abudhabi': 'United Arab Emirates',
    'sharjah': 'United Arab Emirates', 'ajman': 'United Arab Emirates',
    'dubei': 'United Arab Emirates', 'dubayi': 'United Arab Emirates',
    'dubay': 'United Arab Emirates', 'di bai': 'United Arab Emirates',
    # ── Kuwait ───────────────────────────────────────────────────────────────
    'kuwait': 'Kuwait', 'kuwet': 'Kuwait', 'kuwit': 'Kuwait',
    'kuweiti': 'Kuwait', 'kuwethi': 'Kuwait', 'kuwaiti': 'Kuwait',
    'කුවේට්': 'Kuwait', 'குவைத்': 'Kuwait',
    # ── Qatar ────────────────────────────────────────────────────────────────
    'qatar': 'Qatar', 'qathar': 'Qatar', 'katar': 'Qatar',
    'doha': 'Qatar', 'කටාර්': 'Qatar', 'கத்தார்': 'Qatar',
    # ── Saudi Arabia ─────────────────────────────────────────────────────────
    'saudi': 'Saudi Arabia', 'saudi arabia': 'Saudi Arabia',
    'sowdi': 'Saudi Arabia', 'sowdiya': 'Saudi Arabia', 'saudia': 'Saudi Arabia',
    'ksa': 'Saudi Arabia', 'riyadh': 'Saudi Arabia', 'jeddah': 'Saudi Arabia',
    'mecca': 'Saudi Arabia', 'medina': 'Saudi Arabia',
    'සෞදි': 'Saudi Arabia', 'சவுதி': 'Saudi Arabia',
    # ── Oman ─────────────────────────────────────────────────────────────────
    'oman': 'Oman', 'ommaan': 'Oman', 'omman': 'Oman', 'muscat': 'Oman',
    'oman la': 'Oman',
    # ── Malaysia ─────────────────────────────────────────────────────────────
    'malaysia': 'Malaysia', 'malasiya': 'Malaysia', 'maleshiya': 'Malaysia',
    'malesia': 'Malaysia', 'melesia': 'Malaysia',
    'மலேஷியா': 'Malaysia', 'மலேசியா': 'Malaysia', 'මැලේසියා': 'Malaysia',
    # ── Bahrain ──────────────────────────────────────────────────────────────
    'bahrain': 'Bahrain', 'barain': 'Bahrain', 'bahren': 'Bahrain', 'manama': 'Bahrain',
    # ── Singapore ────────────────────────────────────────────────────────────
    'singapore': 'Singapore', 'singappuru': 'Singapore', 'singapura': 'Singapore',
    'சிங்கப்பூர்': 'Singapore',
    # ── Other destinations ───────────────────────────────────────────────────
    'romania': 'Romania', 'poland': 'Poland', 'maldives': 'Maldives',
    'maldivs': 'Maldives', 'male': 'Maldives',
    'japan': 'Japan', 'jordan': 'Jordan', 'urdon': 'Jordan', 'amman': 'Jordan',
    # ── ANY / flexible ───────────────────────────────────────────────────────
    'anywhere': 'ANY', 'any': 'ANY', 'open to anything': 'ANY',
    'nothing specific': 'ANY', 'onama ratak': 'ANY', 'entha nadum': 'ANY',
    'any country': 'ANY', 'i dont mind': 'ANY', 'dont mind': 'ANY',
    'middle east': 'ANY', 'gulf': 'ANY',
    # ── Button IDs ───────────────────────────────────────────────────────────
    'other': 'ANY', 'other 🌍': 'ANY', 'country_other': 'ANY',
    'country_uae': 'United Arab Emirates', 'country_saudi': 'Saudi Arabia',
}

class ChatbotEngine:
    """
    Dewan Consultants receptionist chatbot.
    Follows a structured intake flow collecting job, country, experience, then CV.
    """

    # ─────────────────────────────────────────────────────────────────────────
    # CONVERSATION STATES
    # ─────────────────────────────────────────────────────────────────────────
    STATE_INITIAL             = "initial"
    STATE_AWAITING_LANGUAGE_SELECTION = "awaiting_language_selection"
    STATE_AWAITING_JOB        = "awaiting_job_interest"
    STATE_AWAITING_COUNTRY    = "awaiting_destination_country"
    STATE_AWAITING_JOB_SELECTION = "awaiting_job_selection"
    STATE_AWAITING_EXPERIENCE = "awaiting_experience"
    STATE_COLLECTING_JOB_REQS = "collecting_job_requirements"
    STATE_AWAITING_CV         = "awaiting_cv"
    STATE_PROCESSING_CV       = "processing_cv"
    STATE_COLLECTING_INFO     = "collecting_info"
    STATE_ANSWERING_QUESTIONS = "answering_questions"
    STATE_APPLICATION_COMPLETE = "application_complete"
    STATE_HUMAN_HANDOFF       = "human_handoff"
    GIBBERISH_FALLBACK_MESSAGE = PromptTemplates.GIBBERISH_FALLBACK['singlish']  # kept for backward compat

    def __init__(self):
        self.company_name = settings.company_name

    def _get_state_question_retry_count(self, candidate, state: str) -> int:
        data = candidate.extracted_data or {}
        retry_map = data.get("question_retry_count", {})
        if isinstance(retry_map, dict):
            return int(retry_map.get(state, 0) or 0)
        return 0

    def _set_state_question_retry_count(self, db: Session, candidate, state: str, value: int) -> None:
        data = candidate.extracted_data or {}
        retry_map = data.get("question_retry_count", {})
        if not isinstance(retry_map, dict):
            retry_map = {}
        retry_map[state] = max(0, int(value))
        data["question_retry_count"] = retry_map
        data["question_retries"] = max(0, int(value))
        candidate.extracted_data = data
        if hasattr(candidate, "question_retries"):
            candidate.question_retries = max(0, int(value))
        db.commit()

    def _increment_state_question_retry_count(self, db: Session, candidate, state: str) -> int:
        retries = self._get_state_question_retry_count(candidate, state) + 1
        self._set_state_question_retry_count(db, candidate, state, retries)
        return retries

    def _reset_state_question_retry_count(self, db: Session, candidate, state: str) -> None:
        self._set_state_question_retry_count(db, candidate, state, 0)

    def _get_question_retries(self, candidate) -> int:
        return self._get_state_question_retry_count(candidate, candidate.conversation_state)

    def _set_question_retries(self, db: Session, candidate, value: int) -> None:
        self._set_state_question_retry_count(db, candidate, candidate.conversation_state, value)

    def _increment_question_retries(self, db: Session, candidate) -> int:
        return self._increment_state_question_retry_count(db, candidate, candidate.conversation_state)

    def _reset_question_retries(self, db: Session, candidate) -> None:
        self._reset_state_question_retry_count(db, candidate, candidate.conversation_state)

    def _current_goal_for_state(self, state: str) -> str:
        return PromptTemplates.CURRENT_GOAL_MAP.get(
            state,
            PromptTemplates.CURRENT_GOAL_MAP.get('awaiting_job_interest', 'Collect the required intake detail from the candidate')
        )

    def _country_buttons_payload(self, language: str, body_prefix: str = "") -> Dict[str, Any]:
        country_q = PromptTemplates.get_intake_question('destination_country', language)
        body = f"{body_prefix}\n\n{country_q}".strip() if body_prefix else country_q
        return {
            "type": "buttons",
            "body_text": body,
            "buttons": [
                {"id": "country_uae", "title": "UAE 🇦🇪"},
                {"id": "country_saudi", "title": "Saudi 🇸🇦"},
                {"id": "country_other", "title": "Other 🌍"},
            ],
        }

    async def _apply_two_strike_auto_advance(self, db: Session, candidate, state: str, language: str) -> Optional[Union[str, Dict[str, Any]]]:
        retries = self._increment_state_question_retry_count(db, candidate, state)
        if retries < 2:
            return None

        data = candidate.extracted_data or {}
        self._reset_state_question_retry_count(db, candidate, state)

        if state == self.STATE_AWAITING_JOB:
            data['job_interest'] = "Unknown"
            candidate.extracted_data = data
            db.commit()
            crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_COUNTRY)
            return self._country_buttons_payload(language)

        if state == self.STATE_AWAITING_COUNTRY:
            data['destination_country'] = "Unknown"
            candidate.extracted_data = data
            db.commit()
            crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_EXPERIENCE)
            return self._experience_buttons_payload(language)

        if state == self.STATE_AWAITING_EXPERIENCE:
            data['experience_years_stated'] = "Unknown"
            candidate.extracted_data = data
            if hasattr(candidate, "experience_years"):
                candidate.experience_years = None
            db.commit()
            crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_CV)
            return PromptTemplates.get_intake_question('cv_upload', language)

        return None

    def _experience_buttons_payload(self, language: str) -> Dict[str, Any]:
        body = PromptTemplates.get_intake_question('experience_years', language)
        return {
            "type": "buttons",
            "body_text": body,
            "buttons": [
                {"id": "exp_1_2", "title": "1-2 Years"},
                {"id": "exp_3_5", "title": "3-5 Years"},
                {"id": "exp_5_plus", "title": "Over 5 Years"},
            ],
        }

    def _build_job_picker_list_message(self, language: str) -> Optional[Dict[str, Any]]:
        cache = get_job_cache() or {}
        active_jobs = [job for job in cache.values() if job.get("status") == "active"]
        if not active_jobs:
            return None

        category_display = {
            "construction": "👷‍♂️ Construction",
            "cleaning": "🧹 Cleaning",
            "driver": "🚗 Driver",
            "healthcare": "🏥 Healthcare",
            "factory": "🏭 Factory",
            "hospitality": "🍽️ Hospitality",
            "security": "🛡️ Security",
        }

        sections_by_category: Dict[str, list] = {}
        total_rows = 0
        for job in active_jobs:
            if total_rows >= 10:
                break
            title = str(job.get("title") or "").strip()
            if not title:
                continue
            raw_category = str(job.get("category") or "Other Jobs").strip() or "Other Jobs"
            category = category_display.get(raw_category.lower(), raw_category)
            row_id = str(job.get("id") or f"job_{total_rows}")
            location = str(job.get("country") or "")
            salary = str(job.get("salary") or "")
            desc_parts = [p for p in (location, salary) if p]
            row = {
                "id": row_id,
                "title": title[:24],
                "description": " | ".join(desc_parts)[:72],
            }
            sections_by_category.setdefault(category, []).append(row)
            total_rows += 1

        if not sections_by_category:
            return None

        sections = [
            {"title": category[:24], "rows": rows[:10]}
            for category, rows in sections_by_category.items()
        ][:10]

        body_text = {
            "en": "Please pick a vacancy from the list below 👇",
            "si": "කරුණාකර පහත ලැයිස්තුවෙන් රැකියාවක් තෝරන්න 👇",
            "ta": "தயவு செய்து கீழே உள்ள பட்டியலில் ஒரு வேலை தேர்ந்தெடுக்கவும் 👇",
            "singlish": "Pahalin list eken vacancy ekak select karanna 👇",
            "tanglish": "Kizha irukka list-la oru vacancy select pannunga 👇",
        }.get(language, "Please pick a vacancy from the list below 👇")

        return {
            "type": "list",
            "body_text": body_text,
            "button_label": "View Jobs",
            "sections": sections,
        }

    def _with_audio_ack(self, response: Union[str, Dict[str, Any]], is_audio: bool) -> Union[str, Dict[str, Any]]:
        if not is_audio:
            return response
        prefix = "🎧 I listened to your voice message! "
        if isinstance(response, dict):
            payload = dict(response)
            body_text = str(payload.get("body_text") or "")
            payload["body_text"] = f"{prefix}{body_text}" if body_text else prefix.strip()
            return payload
        if isinstance(response, str) and response.strip():
            return f"{prefix}{response}"
        return response

    async def _notify_human_handoff(self, candidate, reason: str = "confusion_streak") -> None:
        webhook_url = getattr(settings, "human_handoff_webhook_url", None)
        if not webhook_url:
            return
        payload = {
            "candidate_id": candidate.id,
            "phone": candidate.phone_number,
            "name": candidate.name,
            "reason": reason,
            "state": self.STATE_HUMAN_HANDOFF,
        }
        try:
            async with httpx.AsyncClient() as client:
                await client.post(webhook_url, json=payload, timeout=8.0)
        except Exception as exc:
            logger.warning(f"Human handoff webhook failed: {exc}")

    def _dispatch_recruitment_sync_background(
        self,
        candidate_id: int,
        cv_bytes: bytes = None,
        cv_filename: str = None,
        additional_doc_bytes: bytes = None,
        additional_doc_filename: str = None,
        reason: str = "",
    ) -> None:
        """
        Fire-and-forget sync task.
        Uses a fresh DB session so webhook/request-scoped sessions are never reused.
        """
        try:
            task = asyncio.create_task(
                self._run_recruitment_sync_background(
                    candidate_id=candidate_id,
                    cv_bytes=cv_bytes,
                    cv_filename=cv_filename,
                    additional_doc_bytes=additional_doc_bytes,
                    additional_doc_filename=additional_doc_filename,
                    reason=reason,
                )
            )

            def _log_task_exception(t: asyncio.Task) -> None:
                try:
                    _ = t.result()
                except Exception as task_err:
                    logger.error(
                        f"Background recruitment sync crashed for candidate {candidate_id}"
                        f" ({reason or 'no-reason'}): {task_err}",
                        exc_info=True,
                    )

            task.add_done_callback(_log_task_exception)
        except Exception as dispatch_err:
            logger.error(
                f"Failed to dispatch background recruitment sync for candidate {candidate_id}"
                f" ({reason or 'no-reason'}): {dispatch_err}",
                exc_info=True,
            )

    async def _run_recruitment_sync_background(
        self,
        candidate_id: int,
        cv_bytes: bytes = None,
        cv_filename: str = None,
        additional_doc_bytes: bytes = None,
        additional_doc_filename: str = None,
        reason: str = "",
    ) -> None:
        db_bg = SessionLocal()
        try:
            candidate_bg = crud.get_candidate_by_id(db_bg, candidate_id)
            if not candidate_bg:
                logger.warning(
                    f"Background recruitment sync skipped: candidate {candidate_id} not found"
                    f" ({reason or 'no-reason'})"
                )
                return

            await recruitment_sync.push(
                candidate_bg,
                db_bg,
                cv_bytes=cv_bytes,
                cv_filename=cv_filename,
                additional_doc_bytes=additional_doc_bytes,
                additional_doc_filename=additional_doc_filename,
            )
            db_bg.commit()
        except Exception as sync_err:
            db_bg.rollback()
            logger.error(
                f"Background recruitment sync failed for candidate {candidate_id}"
                f" ({reason or 'no-reason'}): {sync_err}",
                exc_info=True,
            )
        finally:
            db_bg.close()

    # ─── Public entry point ───────────────────────────────────────────────────

    async def process_message(
        self,
        db: Session,
        phone_number: str,
        message_text: Optional[str] = None,
        media_content: Optional[bytes] = None,
        media_type: Optional[str] = None,
        media_filename: Optional[str] = None,
        media_url: Optional[str] = None,
        source_message_type: Optional[str] = None,
    ) -> Union[str, Dict[str, Any]]:
        language = "en"
        try:
            candidate = crud.get_or_create_candidate(db, phone_number)
            candidate._phone_number = phone_number  # store for interactive msg calls
            language = self._effective_language(candidate)

            # ── Human Agent Handoff Guard ─────────────────────────────────────
            # If an agent has taken over this conversation, the bot stays silent.
            # The agent responds directly via the recruitment dashboard.
            try:
                from app.webhooks import is_human_controlled
                if is_human_controlled(phone_number):
                    logger.info(f"⏸ Bot silent: {phone_number} is under human control")
                    return ""  # Return empty — webhooks.py will NOT send a WhatsApp reply
            except Exception:
                # Fallback: check candidate's extracted_data for persisted flag
                _cd = candidate.extracted_data or {}
                if _cd.get("is_human_handoff"):
                    logger.info(f"⏸ Bot silent (DB flag): {phone_number} under human control")
                    return ""

            if media_content and media_type in ("document", "image"):
                current_state = candidate.conversation_state
                # If the application is already complete, this is an additional document
                if current_state == self.STATE_APPLICATION_COMPLETE:
                    return await self._handle_additional_document(
                        db, candidate, media_content, media_filename
                    )
                # Otherwise, if they provide a CV at ANY point during onboarding, 
                # process it immediately to extract what we can, instead of forcing manual Q&A.
                else:
                    fallback_filename = media_filename or (
                        f"upload_{candidate.id}.jpg" if media_type == "image" else f"upload_{candidate.id}.pdf"
                    )
                    return await self._handle_cv_upload(
                        db, candidate, media_content, fallback_filename, media_url=media_url
                    )

            if message_text:
                is_audio = source_message_type == "audio"
                if message_text == "AUDIO_UNREADABLE_FALLBACK":
                    noisy_audio_msg = (
                        "It's a bit noisy on your end and I couldn't catch that clearly! 😅 "
                        "Could you click one of the buttons below or type a short reply?"
                    )
                    state_prompt: Union[str, Dict[str, Any]]
                    if candidate.conversation_state == self.STATE_AWAITING_EXPERIENCE:
                        state_prompt = self._experience_buttons_payload(language)
                    elif candidate.conversation_state == self.STATE_AWAITING_JOB:
                        state_prompt = self._build_job_picker_list_message(language) or self._get_next_intake_question(candidate, language)
                    elif candidate.conversation_state == self.STATE_AWAITING_COUNTRY:
                        state_prompt = self._country_buttons_payload(language)
                    else:
                        state_prompt = self._get_next_intake_question(candidate, language)

                    if isinstance(state_prompt, dict):
                        state_prompt = dict(state_prompt)
                        reprompt_text = str(state_prompt.get("body_text") or "")
                        state_prompt["body_text"] = f"{noisy_audio_msg}\n\n{reprompt_text}" if reprompt_text else noisy_audio_msg
                        return state_prompt
                    return f"{noisy_audio_msg}\n\n{state_prompt}" if state_prompt else noisy_audio_msg

                response = await self._handle_text_message(
                    db,
                    candidate,
                    message_text,
                    phone_number,
                    source_message_type=source_message_type,
                )
                return self._with_audio_ack(response, is_audio)

            return self._default_response(db, candidate)

        except Exception as e:
            try:
                db.rollback()
            except Exception:
                pass
            logger.error(f"Error processing message from {phone_number}: {e}", exc_info=True)
            return self._error_response(language)

    # ─── Intake next-question helper ──────────────────────────────────────────

    async def _process_early_cv(self, db, candidate, ack_prefix: str) -> Optional[str]:
        """If an early CV was saved, read it from disk and process immediately.
        Returns the response string, or None if no early CV exists."""
        data = candidate.extracted_data or {}
        early_path = data.get("early_cv_path")
        early_name = data.get("early_cv_filename", "cv.pdf")
        if not early_path:
            return None
        try:
            with open(early_path, "rb") as f:
                file_content = f.read()
            processing_msg = {
                'en': "Now let me review the CV you sent earlier...",
                'si': "දැන් ඔබ කලින් යැව්ව CV එක බලන්නම්...",
                'ta': "இப்போது நீங்கள் முன்னர் அனுப்பிய CV-ஐ பார்க்கிறேன்...",
                'singlish': "OK now let me check the CV you sent earlier...",
                'tanglish': "OK ippo neenga munna anuppuna CV paarkiren...",
            }
            language = self._effective_language(candidate)
            msg = processing_msg.get(language, processing_msg['en'])
            cv_result = await self._handle_cv_upload(db, candidate, file_content, early_name)
            return f"{ack_prefix}{msg}\n\n{cv_result}"
        except FileNotFoundError:
            logger.warning(f"Early CV file missing: {early_path}")
            return None
        except Exception as e:
            logger.warning(f"Early CV processing failed: {e}")
            return None

    def _get_next_intake_question(self, candidate, language: str) -> str:
        """Return the next intake question based on current state."""
        state = candidate.conversation_state
        if state == self.STATE_INITIAL:
            return PromptTemplates.get_language_selection()
        elif state == self.STATE_AWAITING_LANGUAGE_SELECTION:
            return PromptTemplates.get_language_selection()
        elif state == self.STATE_AWAITING_JOB:
            return PromptTemplates.get_intake_question('job_interest', language)
        elif state == self.STATE_AWAITING_COUNTRY:
            return PromptTemplates.get_intake_question('destination_country', language)
        elif state == self.STATE_AWAITING_JOB_SELECTION:
            prompts = {
                'en': "Reply with 1, 2, or 3 to select a job, or type Skip.",
                'si': "රැකියාව තේරීමට 1, 2, හෝ 3 reply කරන්න, නැත්නම් Skip කියන්න.",
                'ta': "வேலை தேர்வு செய்ய 1, 2, அல்லது 3 அனுப்பவும், இல்லை என்றால் Skip என்று எழுதவும்.",
                'singlish': "Job select karanna 1, 2, 3 reply karanna, nathnam Skip kiyanna.",
                'tanglish': "Job select panna 1, 2, 3 anuppunga, illa na Skip sollunga.",
            }
            return prompts.get(language, prompts['en'])
        elif state == self.STATE_AWAITING_EXPERIENCE:
            return PromptTemplates.get_intake_question('experience_years', language)
        elif state == self.STATE_COLLECTING_JOB_REQS:
            data = candidate.extracted_data or {}
            pending = data.get('pending_job_reqs', [])
            if pending:
                return f"Could you also tell me your {pending[0].replace('_', ' ')}?"
        return ""

    # ─── Smart multi-entity state skipping ───────────────────────────────────

    async def _try_multi_entity_skip(
        self,
        db: Session,
        candidate,
        language: str,
        state: str,
        entities: Dict[str, Any],
        classified: Optional[Dict[str, Any]] = None,
    ) -> Optional[str]:
        """
        If the LLM extracted multiple intake entities in one message, save them all
        and skip directly to the next unanswered question.

        Returns:
            Response string if we skipped at least one state, or None to fall through
            to the normal _route_by_state handler.
        """
        job_roles     = entities.get("job_roles") or []
        countries     = entities.get("countries") or []
        exp_years     = entities.get("experience_years")  # int or None

        # Count how many meaningful entities we have
        has_job     = bool(job_roles)
        has_country = bool(countries)
        has_exp     = exp_years is not None

        # Require at least 2 entities to activate skipping (single-entity messages
        # are better handled by the normal per-state validators).
        if sum([has_job, has_country, has_exp]) < 2:
            return None

        data = candidate.extracted_data or {}
        already_has_job     = bool(data.get("job_interest"))
        already_has_country = bool(data.get("destination_country"))
        already_has_exp     = data.get("experience_years_stated") is not None

        # Determine which fields we're actually filling in on this call
        saving_something = False

        if has_job and not already_has_job:
            job_value = str(job_roles[0]).strip().title()
            self._save_intake(db, candidate, "job_interest", job_value)
            # Try to match a real job from cache
            matched = self._match_job_from_text(job_value)
            if matched:
                job_id, job_info = matched
                d2 = candidate.extracted_data or {}
                d2["matched_job_id"] = job_id
                req = job_info.get("requirements")
                d2["job_requirements"] = dict(req) if isinstance(req, dict) else {}
                candidate.extracted_data = d2
                db.commit()
            saving_something = True

        if has_country and not already_has_country:
            country_value = str(countries[0]).strip()
            self._save_intake(db, candidate, "destination_country", country_value)
            saving_something = True

        if has_exp and not already_has_exp:
            self._save_intake(db, candidate, "experience_years_stated", str(exp_years))
            try:
                candidate.experience_years = int(exp_years)
                db.commit()
            except Exception:
                pass
            saving_something = True

        if not saving_something:
            # All entities were already saved — nothing to skip
            return None

        # Reload fresh data after saves
        data = candidate.extracted_data or {}
        has_job_now     = bool(data.get("job_interest"))
        has_country_now = bool(data.get("destination_country"))
        has_exp_now     = data.get("experience_years_stated") is not None

        # Determine next state and question
        if not has_job_now:
            crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_JOB)
            return PromptTemplates.get_intake_question("job_interest", language)

        if not has_country_now:
            crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_COUNTRY)
            job_name  = data.get("job_interest", "")
            ack = self._build_job_ack(job_name, language) if job_name else ""
            return self._country_buttons_payload(language, body_prefix=ack.strip())

        if not has_exp_now:
            crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_EXPERIENCE)
            exp_q    = PromptTemplates.get_intake_question("experience_years", language)
            country  = data.get("destination_country", "")
            ack      = self._build_country_ack(country, language) if country else ""
            return f"{ack}{exp_q}"

        # All three collected — try early CV or go to CV state
        crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_CV)
        early_result = await self._process_early_cv(db, candidate, "")
        if early_result:
            return early_result
        cv_q = PromptTemplates.get_intake_question("cv_upload", language)
        # Build a combined ack of all collected info
        job     = data.get("job_interest", "")
        country = data.get("destination_country", "")
        years   = data.get("experience_years_stated", "")
        acks = {
            "en":       f"Great! I have noted:\n• Job: *{job}*\n• Country: *{country}*\n• Experience: *{years} years*\n\n{cv_q}",
            "si":       f"හොඳයි! ගොළු කළා:\n• රැකියාව: *{job}*\n• රට: *{country}*\n• අත්දැකීම: *{years} years*\n\n{cv_q}",
            "ta":       f"சரி! குறித்துக்கொண்டேன்:\n• வேலை: *{job}*\n• நாடு: *{country}*\n• அனுபவம்: *{years} years*\n\n{cv_q}",
            "singlish": f"Niyamai! Dannawa:\n• Job: *{job}*\n• Country: *{country}*\n• Experience: *{years} years*\n\n{cv_q}",
            "tanglish": f"Seri! Note panninen:\n• Job: *{job}*\n• Country: *{country}*\n• Experience: *{years} years*\n\n{cv_q}",
        }
        return acks.get(language, acks["en"])

    # ─── Fast-path trivial input classifier ──────────────────────────────────

    @staticmethod
    def _fast_classify(text: str, state: str) -> Optional[Dict]:

        """
        Skip LLM for trivial inputs. Returns a minimal classified dict or None.
        Called BEFORE rag_engine.classify_message_async() — saves 600-1500ms
        for ~65% of all incoming messages.
        """
        stripped = text.strip().lower()
        _empty_entities = {'job_roles': [], 'countries': [], 'skills': [], 'experience_years': None}

        # ── Numeric / word language selections in initial/language states ─────
        if state in ('initial', 'awaiting_language_selection'):
            _lang_map = {
                '1': 'en', 'one': 'en', 'english': 'en', 'eng': 'en',
                '2': 'si', 'two': 'si', 'sinhala': 'si', 'sinhalese': 'si',
                '3': 'ta', 'three': 'ta', 'tamil': 'ta', 'tamizh': 'ta',
                'thamizh': 'ta',
            }
            if stripped in _lang_map:
                return {
                    'intent': 'language_selection',
                    'language': _lang_map[stripped],
                    'extracted_value': stripped,
                    'confidence': 1.0,
                    'entities': _empty_entities,
                }

        # ── Universal yes/no fast-path ────────────────────────────────────────
        YES_TOKENS = {
            'yes', 'yeah', 'yep', 'yup', 'ok', 'okay', 'sure', 'alright',
            # Sinhala script
            'හා', 'ඔව්', 'හරි',
            # Tamil script
            'ஆம்', 'சரி',
            # Singlish
            'haan', 'ho', 'hari', 'niyamai',
            # Tanglish
            'aama', 'seri', 'sari', 'ok-ah', 'seri-ah', 'okay-ah',
        }
        NO_TOKENS = {
            'no', 'nope', 'nah', 'never', 'not now', 'later',
            # Sinhala script
            'නැ', 'නෑ', 'එපා',
            # Tamil script
            'இல்லை', 'வேண்டாம்',
            # Singlish / Tanglish
            'illai', 'illada', 'epa', 'na', 'nah', 'illa',
        }
        if stripped in YES_TOKENS:
            # Detect language from which token matched for proper template routing
            _si_yes = {'හා', 'ඔව්', 'හරි'}
            _ta_yes = {'ஆம்', 'சரி'}
            _singlish_yes = {'haan', 'ho', 'hari', 'niyamai'}
            _tanglish_yes = {'aama', 'seri', 'sari', 'ok-ah', 'seri-ah', 'okay-ah'}
            if stripped in _si_yes:
                _lang = 'si'
            elif stripped in _ta_yes:
                _lang = 'ta'
            elif stripped in _singlish_yes:
                _lang = 'singlish'
            elif stripped in _tanglish_yes:
                _lang = 'tanglish'
            else:
                _lang = 'en'
            return {
                'intent': 'apply_intent', 'language': _lang,
                'extracted_value': 'yes', 'confidence': 1.0,
                'entities': _empty_entities,
            }
        if stripped in NO_TOKENS:
            _si_no = {'නැ', 'නෑ', 'එපා'}
            _ta_no = {'இல்லை', 'வேண்டாம்'}
            _singlish_no = {'epa', 'nah'}
            _tanglish_no = {'illai', 'illada', 'illa', 'na'}
            if stripped in _si_no:
                _lang = 'si'
            elif stripped in _ta_no:
                _lang = 'ta'
            elif stripped in _singlish_no:
                _lang = 'singlish'
            elif stripped in _tanglish_no:
                _lang = 'tanglish'
            else:
                _lang = 'en'
            return {
                'intent': 'no_intent', 'language': _lang,
                'extracted_value': 'no', 'confidence': 1.0,
                'entities': _empty_entities,
            }

        # ── Greetings (all 5 registers) ───────────────────────────────────────
        _GREETING_TOKENS = {
            # English
            'hi': 'en', 'hello': 'en', 'hey': 'en', 'good morning': 'en',
            'good evening': 'en', 'good afternoon': 'en',
            # Sinhala script
            'ආයුබෝවන්': 'si', 'ආයුබෝ': 'si', 'සුභ': 'si',
            # Singlish (Romanized Sinhala)
            'ayubowan': 'singlish', 'ayubo': 'singlish', 'kohomada': 'singlish',
            'kohomad': 'singlish', 'suba udessa': 'singlish',
            # Tamil script
            'வணக்கம்': 'ta',
            # Tanglish (Romanized Tamil)
            'vanakkam': 'tanglish', 'vanakam': 'tanglish',
        }
        if stripped in _GREETING_TOKENS:
            return {
                'intent': 'greeting', 'language': _GREETING_TOKENS[stripped],
                'extracted_value': stripped, 'confidence': 1.0,
                'entities': _empty_entities,
            }

        # ── Common job titles (en/si/ta/singlish/tanglish) ────────────────────
        _JOB_TOKEN_MAP = {
            # English — trades & labour
            'driver': ('driver', 'en'), 'drivers': ('driver', 'en'),
            'heavy driver': ('heavy driver', 'en'), 'light driver': ('light driver', 'en'),
            'forklift operator': ('forklift operator', 'en'), 'forklift': ('forklift operator', 'en'),
            'nurse': ('nurse', 'en'), 'nurses': ('nurse', 'en'),
            'caregiver': ('caregiver', 'en'), 'care giver': ('caregiver', 'en'),
            'cook': ('cook', 'en'), 'chef': ('cook', 'en'), 'head chef': ('chef', 'en'),
            'security': ('security guard', 'en'), 'security guard': ('security guard', 'en'),
            'security officer': ('security guard', 'en'),
            'cleaner': ('cleaner', 'en'), 'housemaid': ('housemaid', 'en'),
            'housekeeper': ('housemaid', 'en'), 'domestic worker': ('housemaid', 'en'),
            'electrician': ('electrician', 'en'), 'welder': ('welder', 'en'),
            'plumber': ('plumber', 'en'), 'mason': ('mason', 'en'),
            'carpenter': ('carpenter', 'en'), 'ac mechanic': ('ac mechanic', 'en'),
            'ac technician': ('ac technician', 'en'), 'ac tech': ('ac technician', 'en'),
            'factory worker': ('factory worker', 'en'), 'factory': ('factory worker', 'en'),
            'production worker': ('factory worker', 'en'),
            'helper': ('helper', 'en'), 'general helper': ('helper', 'en'),
            'mechanic': ('mechanic', 'en'), 'technician': ('technician', 'en'),
            'painter': ('painter', 'en'), 'steel fixer': ('steel fixer', 'en'),
            'scaffolder': ('scaffolder', 'en'),
            # English — hospitality & service
            'waiter': ('waiter', 'en'), 'waitress': ('waiter', 'en'),
            'steward': ('steward', 'en'), 'room boy': ('room boy', 'en'),
            'office boy': ('office boy', 'en'), 'office assistant': ('office assistant', 'en'),
            'salesman': ('salesman', 'en'), 'sales': ('salesman', 'en'),
            'accountant': ('accountant', 'en'), 'tailor': ('tailor', 'en'),
            'supervisor': ('supervisor', 'en'),
            # Sinhala script
            'රියදුරු': ('driver', 'si'), 'හෙදිය': ('nurse', 'si'),
            'ආරක්ෂක': ('security guard', 'si'), 'ආරක්ෂකවර': ('security guard', 'si'),
            'ඇදිය': ('cook', 'si'), 'සේවිකා': ('housemaid', 'si'),
            'කම්කරු': ('factory worker', 'si'), 'විදුලි': ('electrician', 'si'),
            'වෑල්ම': ('welder', 'si'), 'රෙද්ද': ('tailor', 'si'),
            # Singlish (Romanized Sinhala)
            'riyaduru': ('driver', 'singlish'), 'driver karanna': ('driver', 'singlish'),
            'driver velai': ('driver', 'singlish'),
            'wadeema': ('job', 'singlish'), 'raakiyawa': ('job', 'singlish'),
            'rakiyawa': ('job', 'singlish'), 'wela': ('job', 'singlish'),
            'hediya': ('nurse', 'singlish'), 'nurse karanna': ('nurse', 'singlish'),
            'cook karanna': ('cook', 'singlish'), 'security karanna': ('security guard', 'singlish'),
            'cleaner karanna': ('cleaner', 'singlish'), 'machanic': ('mechanic', 'singlish'),
            'welder karanna': ('welder', 'singlish'), 'electrician karanna': ('electrician', 'singlish'),
            'carpenter karanna': ('carpenter', 'singlish'),
            # Tamil script
            'ஓட்டுநர்': ('driver', 'ta'), 'செவிலியர்': ('nurse', 'ta'),
            'சமையல்காரர்': ('cook', 'ta'), 'பாதுகாவலர்': ('security guard', 'ta'),
            'தச்சர்': ('carpenter', 'ta'), 'மின்சாரம்': ('electrician', 'ta'),
            'வெல்டர்': ('welder', 'ta'), 'தையல்காரர்': ('tailor', 'ta'),
            # Tanglish (Romanized Tamil)
            'driver paniyidam': ('driver', 'tanglish'), 'driver velai': ('driver', 'tanglish'),
            'nurse paniyidam': ('nurse', 'tanglish'), 'cook paniyidam': ('cook', 'tanglish'),
            'security paniyidam': ('security guard', 'tanglish'),
            'welder paniyidam': ('welder', 'tanglish'),
            'electrician paniyidam': ('electrician', 'tanglish'),
            'cleaner paniyidam': ('cleaner', 'tanglish'),
            'helper paniyidam': ('helper', 'tanglish'),
            'carpenter paniyidam': ('carpenter', 'tanglish'),
        }
        if stripped in _JOB_TOKEN_MAP:
            role, lang = _JOB_TOKEN_MAP[stripped]
            return {
                'intent': 'job_title', 'language': lang,
                'extracted_value': role, 'confidence': 1.0,
                'entities': {**_empty_entities, 'job_roles': [role]},
            }

        # ── Country names (en/si/ta/singlish/tanglish) ────────────────────────
        _COUNTRY_TOKEN_MAP = {
            # English — Middle East
            'dubai': ('UAE', 'en'), 'uae': ('UAE', 'en'),
            'abu dhabi': ('UAE', 'en'), 'sharjah': ('UAE', 'en'),
            'qatar': ('Qatar', 'en'), 'doha': ('Qatar', 'en'),
            'saudi': ('Saudi Arabia', 'en'), 'saudi arabia': ('Saudi Arabia', 'en'),
            'riyadh': ('Saudi Arabia', 'en'), 'jeddah': ('Saudi Arabia', 'en'),
            'kuwait': ('Kuwait', 'en'), 'bahrain': ('Bahrain', 'en'),
            'oman': ('Oman', 'en'), 'muscat': ('Oman', 'en'),
            'jordan': ('Jordan', 'en'), 'amman': ('Jordan', 'en'),
            # English — Asia-Pacific & Indian Ocean
            'malaysia': ('Malaysia', 'en'), 'singapore': ('Singapore', 'en'),
            'maldives': ('Maldives', 'en'), 'japan': ('Japan', 'en'),
            'korea': ('South Korea', 'en'), 'south korea': ('South Korea', 'en'),
            'hong kong': ('Hong Kong', 'en'), 'taiwan': ('Taiwan', 'en'),
            # English — Europe & Indian Ocean Islands
            'italy': ('Italy', 'en'), 'romania': ('Romania', 'en'),
            'poland': ('Poland', 'en'), 'croatia': ('Croatia', 'en'),
            'cyprus': ('Cyprus', 'en'), 'malta': ('Malta', 'en'),
            'seychelles': ('Seychelles', 'en'), 'mauritius': ('Mauritius', 'en'),
            'uk': ('United Kingdom', 'en'), 'england': ('United Kingdom', 'en'),
            # Sinhala script
            'දුබායි': ('UAE', 'si'), 'කතාර්': ('Qatar', 'si'),
            'සෞදි': ('Saudi Arabia', 'si'), 'කුවේට්': ('Kuwait', 'si'),
            'බහරේන්': ('Bahrain', 'si'), 'ඔමානය': ('Oman', 'si'),
            'මැලේසියා': ('Malaysia', 'si'), 'සිංගප්පූරු': ('Singapore', 'si'),
            'මාල දිවයින': ('Maldives', 'si'), 'ජොර්දානය': ('Jordan', 'si'),
            'ජපානය': ('Japan', 'si'), 'ඉතාලිය': ('Italy', 'si'),
            # Tamil script
            'துபாய்': ('UAE', 'ta'), 'கத்தார்': ('Qatar', 'ta'),
            'சவுதி': ('Saudi Arabia', 'ta'), 'குவைத்': ('Kuwait', 'ta'),
            'பஹ்ரைன்': ('Bahrain', 'ta'), 'ஓமன்': ('Oman', 'ta'),
            'மலேஷியா': ('Malaysia', 'ta'), 'சிங்கப்பூர்': ('Singapore', 'ta'),
            'மாலத்தீவு': ('Maldives', 'ta'), 'ஜோர்தான்': ('Jordan', 'ta'),
            'ஜப்பான்': ('Japan', 'ta'), 'இத்தாலி': ('Italy', 'ta'),
            # Singlish
            'dubai yanna': ('UAE', 'singlish'), 'dubai hadanna': ('UAE', 'singlish'),
            'qatar yanna': ('Qatar', 'singlish'), 'saudi yanna': ('Saudi Arabia', 'singlish'),
            'malaysia yanna': ('Malaysia', 'singlish'), 'oman yanna': ('Oman', 'singlish'),
            'japan yanna': ('Japan', 'singlish'), 'korea yanna': ('South Korea', 'singlish'),
            'italy yanna': ('Italy', 'singlish'), 'bahrain yanna': ('Bahrain', 'singlish'),
            'kuwait yanna': ('Kuwait', 'singlish'), 'singapore yanna': ('Singapore', 'singlish'),
            # Tanglish
            'dubai poganum': ('UAE', 'tanglish'), 'qatar poganum': ('Qatar', 'tanglish'),
            'saudi poganum': ('Saudi Arabia', 'tanglish'),
            'malaysia poganum': ('Malaysia', 'tanglish'),
            'oman poganum': ('Oman', 'tanglish'), 'japan poganum': ('Japan', 'tanglish'),
            'korea poganum': ('South Korea', 'tanglish'),
            'dubai la': ('UAE', 'tanglish'), 'qatar la': ('Qatar', 'tanglish'),
            'saudi la': ('Saudi Arabia', 'tanglish'), 'oman la': ('Oman', 'tanglish'),
            'malaysia la': ('Malaysia', 'tanglish'), 'singapore la': ('Singapore', 'tanglish'),
        }
        if stripped in _COUNTRY_TOKEN_MAP:
            country, lang = _COUNTRY_TOKEN_MAP[stripped]
            return {
                'intent': 'country', 'language': lang,
                'extracted_value': country, 'confidence': 1.0,
                'entities': {**_empty_entities, 'countries': [country]},
            }

        # ── Experience patterns (singlish / tanglish / sinhala / tamil) ───────
        # e.g. "අවුරුදු 5", "5 வருடம்", "varudam 5", "avurudu 5"
        _exp_singlish = re.match(
            r'^(?:avurudu|avurudhu|warsham|warshe)\s+(\d+)$|^(\d+)\s+(?:avurudu|warsham)$',
            stripped
        )
        _exp_tanglish = re.match(
            r'^(?:varudam|vrudam|varusham)\s+(\d+)$|^(\d+)\s+(?:varudam|varusham|varusha)$',
            stripped
        )
        _exp_sinhala = re.match(r'^(\d+)\s*අවුරුදු$|^අවුරුදු\s+(\d+)$', stripped)
        _exp_tamil = re.match(r'^(\d+)\s*வருடம்$|^(\d+)\s*ஆண்டுகள்$', stripped)

        for _m, _lang in [
            (_exp_singlish, 'singlish'), (_exp_tanglish, 'tanglish'),
            (_exp_sinhala, 'si'), (_exp_tamil, 'ta'),
        ]:
            if _m:
                _years = int(next(g for g in _m.groups() if g is not None))
                return {
                    'intent': 'years_experience', 'language': _lang,
                    'extracted_value': str(_years), 'confidence': 1.0,
                    'entities': {**_empty_entities, 'experience_years': _years},
                }

        # ── CV upload phrases ─────────────────────────────────────────────────
        _CV_TOKENS = {
            # Singlish
            'cv yawanawa', 'cv yannawa', 'cv ewanawa', 'cv anuwanawa',
            # Tanglish
            'cv anuppuren', 'cv anupuren', 'cv pathivu eiduren',
            'cv send pannuren', 'cv send panren',
        }
        if stripped in _CV_TOKENS:
            _lang = 'singlish' if any(w in stripped for w in ('yawanawa', 'yannawa', 'ewanawa', 'anuwanawa')) else 'tanglish'
            return {
                'intent': 'cv_upload', 'language': _lang,
                'extracted_value': stripped, 'confidence': 1.0,
                'entities': _empty_entities,
            }

        # ── Pure number for experience / age ──────────────────────────────────
        if state == 'awaiting_experience':
            if re.match(r'^\d+(\.(\d+))?$', stripped):
                val = float(stripped)
                return {
                    'intent': 'years_experience',
                    'language': 'en',
                    'extracted_value': stripped,
                    'confidence': 1.0,
                    'entities': {**_empty_entities, 'experience_years': int(val)},
                }

        return None  # Fall through to LLM

    # ─── Text message router ──────────────────────────────────────────────────

    async def _handle_text_message(
        self,
        db: Session,
        candidate,
        message_text: str,
        phone_number: str = "",
        source_message_type: Optional[str] = None,
    ) -> Union[str, Dict[str, Any]]:

        # 1. Explicit language switch
        switch_lang = detect_language_switch_request(message_text)
        if switch_lang:
            crud.update_candidate_language(db, candidate.id, switch_lang)
            self._set_language_lock(db, candidate, True)
            current_state = candidate.conversation_state
            if current_state == self.STATE_AWAITING_LANGUAGE_SELECTION:
                # Fall through so the state handler also advances to STATE_AWAITING_JOB.
                pass
            elif current_state == self.STATE_INITIAL:
                # User named their language on the very first interaction —
                # skip the language-selection screen and go straight to the job question.
                crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_JOB)
                self._log_msg(db, candidate.id, MessageTypeEnum.USER, message_text, switch_lang)
                ack = self._lang_switch_ack(switch_lang, candidate.name)
                job_q = PromptTemplates.get_intake_question('job_interest', switch_lang)
                response = f"{ack}\n\n{job_q}"
                self._log_msg(db, candidate.id, MessageTypeEnum.BOT, response, switch_lang)
                return response
            else:
                self._log_msg(db, candidate.id, MessageTypeEnum.USER, message_text, switch_lang)
                response = self._lang_switch_ack(switch_lang, candidate.name)
                self._log_msg(db, candidate.id, MessageTypeEnum.BOT, response, switch_lang)
                return response

        # 2. Detect language — with sliding-window adaptation
        det_lang, det_conf = detect_language(message_text, phone_number)
        
        # Proactive adaptation: if the language detector has seen 2+ consecutive
        # messages in a different register (e.g. user drifting from en → singlish),
        # silently switch without asking.
        from app.nlp.language_detector import language_detector
        confirmed = language_detector.get_confirmed_language(phone_number)
        stored_lang = self._effective_language(candidate)
        language_locked = self._is_language_locked(candidate)

        if (not language_locked) and confirmed and confirmed != stored_lang and det_conf > 0.3:
            # User has been speaking in a different register for 2+ messages
            crud.update_candidate_language(db, candidate.id, confirmed)
            language = confirmed
            # Also persist register in extracted_data for singlish/tanglish
            if confirmed in ("singlish", "tanglish"):
                data = candidate.extracted_data or {}
                data["language_register"] = confirmed
                candidate.extracted_data = data
                db.commit()
        elif (not language_locked) and det_conf > 0.85 and len(message_text.split()) >= 3:
            # High-confidence single-message detection (original logic)
            crud.update_candidate_language(db, candidate.id, det_lang)
            language = det_lang
        else:
            language = stored_lang

        # 3. Sentiment / profanity check
        sentiment = analyze_sentiment(message_text)
        self._log_msg(
            db, candidate.id, MessageTypeEnum.USER, message_text, language,
            sentiment_score=sentiment.score,
            sentiment_label=sentiment.label,
            has_profanity=sentiment.has_profanity
        )

        if sentiment.has_profanity or (
            sentiment.label == "negative" and sentiment.score < -0.7 and len(message_text.split()) > 2
        ):
            de_esc = get_de_escalation(sentiment, language)
            if de_esc:
                self._log_msg(db, candidate.id, MessageTypeEnum.BOT, de_esc, language)
                return de_esc

        # 4. Unified LLM intent + language classification + intake validation
        #    For known intake states, both classify_message and validate_intake_answer
        #    are launched in PARALLEL with asyncio.gather — halving API wait time.
        state = candidate.conversation_state

        # ── Fast-path: skip LLM for trivial numeric/yes/no inputs (~65% of msgs) ──
        fast_result = self._fast_classify(message_text, state)

        # Map intake states to their validation field so we can pre-fetch in parallel.
        _intake_field_map: Dict[str, str] = {
            self.STATE_AWAITING_JOB:        'job_interest',
            self.STATE_AWAITING_COUNTRY:    'destination_country',
            self.STATE_AWAITING_EXPERIENCE: 'experience_years',
        }

        prefetched_validation: Optional[Dict[str, Any]] = None
        try:
            if fast_result:
                # Fast-path: no LLM needed — use pre-computed classification
                classified = fast_result
                logger.info(
                    f"_fast_classify hit: '{message_text[:40]}' → intent={fast_result['intent']}"
                )
                # Phase 5: propagate detected language so response uses correct register
                _fp_lang = fast_result.get('language')
                if (not language_locked) and _fp_lang and _fp_lang != 'en' and _fp_lang != language:
                    crud.update_candidate_language(db, candidate.id, _fp_lang)
                    language = _fp_lang
            elif state in _intake_field_map:
                # Single combined LLM call: classify + validate in one round-trip
                classified, prefetched_validation = await rag_engine.classify_and_validate_async(
                    text=message_text,
                    state=state,
                    field=_intake_field_map[state],
                    language=language,
                )
            else:
                # Pass recent messages as context so classifier can resolve
                # pronoun/intent ambiguities across turns (PDF spec)
                _last_msgs = crud.get_recent_messages(db, candidate.id, limit=5) \
                    if hasattr(crud, 'get_recent_messages') else None
                classified = await rag_engine.classify_message_async(
                    text=message_text,
                    state=state,
                    stored_language=language,
                    last_messages=_last_msgs,
                )
        except Exception as _clf_err:
            logger.warning(f"classify_message failed ({_clf_err}) — using defaults")
            classified = {
                "intent": "other",
                "language": language,
                "confidence": 0.5,
                "entities": {"job_roles": [], "countries": [], "skills": [], "experience_years": None},
            }

        # Trust the LLM language detection for mixed-script inputs.
        # Promote to singlish/tanglish even when stored language is already si/ta,
        # so response templates are register-appropriate (casual vs formal).
        llm_lang = classified.get("language", language)
        if llm_lang in ("tanglish", "singlish", "ta", "si", "en") and llm_lang != language:
            llm_conf = float(classified.get("confidence", 0))
            
            # Allow "Register Sliding" between related language families even if locked
            is_valid_shift = False
            if language in ("si", "singlish") and llm_lang in ("si", "singlish"):
                is_valid_shift = True
            elif language in ("ta", "tanglish") and llm_lang in ("ta", "tanglish"):
                is_valid_shift = True

            # Promote only when the LLM is confident enough
            if (not language_locked or is_valid_shift) and llm_conf >= 0.65:
                language = llm_lang
                crud.update_candidate_language(db, candidate.id, llm_lang)
                
                # Persist the register shift in extracted_data
                if is_valid_shift:
                    data = candidate.extracted_data or {}
                    data["language_register"] = llm_lang
                    candidate.extracted_data = data
                    db.commit()


        # ── Smart entity pre-population: skip intake states when LLM extracted ──
        # multiple entities in one message (e.g. "I'm a driver with 5 years
        # experience looking in Dubai" → saves job, country, experience at once
        # and jumps directly to the next unanswered question).
        # Only applied during early intake states to avoid disrupting mid-flow.
        _early_intake_states = (
            self.STATE_INITIAL,
            self.STATE_AWAITING_LANGUAGE_SELECTION,
            self.STATE_AWAITING_JOB,
            self.STATE_AWAITING_COUNTRY,
            self.STATE_AWAITING_EXPERIENCE,
        )
        _intent = classified.get("intent", "other")
        _entities = classified.get("entities", {})
        if state in _early_intake_states and _entities and _intent not in (
            "greeting", "language_selection", "vacancy_query", "no_intent"
        ):
            skipped = await self._try_multi_entity_skip(
                db, candidate, language, state, _entities, classified
            )
            if skipped:
                self._log_msg(db, candidate.id, MessageTypeEnum.BOT, skipped, language)
                return skipped

        # 5. Route by conversation state
        response = await self._route_by_state(
            db, candidate, message_text, language, state, classified, phone_number,
            source_message_type=source_message_type,
            prefetched_validation=prefetched_validation,
        )

        log_text = json.dumps(response, ensure_ascii=False) if isinstance(response, dict) else response
        self._log_msg(db, candidate.id, MessageTypeEnum.BOT, log_text, language)
        return response


    # ─── State router ─────────────────────────────────────────────────────────

    async def _route_by_state(
        self,
        db: Session,
        candidate,
        text: str,
        language: str,
        state: str,
        classified: Optional[Dict[str, Any]] = None,
        phone_number: str = "",
        source_message_type: Optional[str] = None,
        prefetched_validation: Optional[Dict[str, Any]] = None,
    ) -> Union[str, Dict[str, Any]]:
        # Unpack pre-classified intent/entities (from classify_message in _handle_text_message)
        if classified is None:
            classified = {}
        _intent    = classified.get("intent", "other")
        _entities  = classified.get("entities") or {}
        _llm_lang  = classified.get("language", language)
        _llm_conf  = float(classified.get("confidence", 0.5))

        if state == self.STATE_HUMAN_HANDOFF:
            return ""

        guided_states = {
            self.STATE_AWAITING_JOB,
            self.STATE_AWAITING_COUNTRY,
            self.STATE_AWAITING_EXPERIENCE,
        }
        is_gibberish_or_low_conf = (
            _intent == "gibberish"
            or (_intent in ("other", "unclear") and _llm_conf < 0.55)
        )
        if state in guided_states and is_gibberish_or_low_conf and not _is_question(text):
            _current_goal = self._current_goal_for_state(state)

            retries = self._get_state_question_retry_count(candidate, state)

            if retries < 2:
                # Strike 1 or 2 → LLM-powered agentic acknowledgment + steering
                self._increment_state_question_retry_count(db, candidate, state)
                agentic_msg = await rag_engine.generate_agentic_response(
                    user_message=text,
                    current_goal=_current_goal,
                    language=language,
                )

                # On strike 2 (second failure), also send interactive widget as visual aid
                if retries == 1:
                    if state == self.STATE_AWAITING_JOB:
                        list_payload = self._build_job_picker_list_message(language)
                        if list_payload:
                            list_payload = dict(list_payload)
                            list_payload["body_text"] = f"{agentic_msg}\n\n{list_payload.get('body_text', '')}".strip()
                            return list_payload
                    elif state == self.STATE_AWAITING_COUNTRY:
                        return self._country_buttons_payload(language, body_prefix=agentic_msg)
                    elif state == self.STATE_AWAITING_EXPERIENCE:
                        payload = self._experience_buttons_payload(language)
                        payload = dict(payload)
                        payload["body_text"] = f"{agentic_msg}\n\n{payload.get('body_text', '')}".strip()
                        return payload

                return agentic_msg

            # Strike 3: auto-advance (same as previous 2-strike logic)
            auto_advanced = await self._apply_two_strike_auto_advance(db, candidate, state, language)
            if auto_advanced is not None:
                return auto_advanced
            return PromptTemplates.get_gibberish_fallback(language)


        # ── TOP-LEVEL: greetings at ANY state → warm re-welcome ───────────────
        is_greet, greet_lang = is_greeting(text)
        lang = greet_lang or language

        if is_greet and state not in (
            self.STATE_INITIAL,
            self.STATE_APPLICATION_COMPLETE
        ):
            # Returning user said hi mid-flow → remind them where we left off
            return self._resume_prompt(candidate, lang)

        # ── TOP-LEVEL: LLM-detected VACANCY QUERY (any state, any language) ─────
        # classify_message() already ran in _handle_text_message; _intent is reliable
        # for all 5 language forms (en / si / ta / tanglish / singlish).
        _is_vac = (
            _intent == "vacancy_query"
            or (
                _intent not in ("language_selection", "greeting", "cv_upload", "apply_intent")
                and _is_vacancy_question(text)        # regex safety-net
            )
        )
        if _is_vac:
            # 1. Fetch the beautifully formatted job list directly
            candidate_ctx = self._candidate_info_dict(candidate)
            vacancies_msg = await self._build_vacancy_list(language, candidate_ctx)

            # 2. Seamlessly push them into the intake flow
            if state in (self.STATE_INITIAL, self.STATE_AWAITING_LANGUAGE_SELECTION, self.STATE_AWAITING_JOB):
                crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_JOB)
                candidate.conversation_state = self.STATE_AWAITING_JOB
                return self._build_job_picker_list_message(language) or vacancies_msg

            elif state == self.STATE_APPLICATION_COMPLETE:
                suffix = {
                    'en': "\n\n💡 Reply with a role name if you'd like to start a new application!",
                    'si': "\n\n💡 නව ඉල්ලුම්පත්‍රයක් ඉදිරිපත් කිරීමට රැකියා නාමය reply කරන්න!",
                    'ta': "\n\n💡 புதிய விண்ணப்பத்தைத் தொடங்க, பதவி பெயரைப் பதிலளிக்கவும்!",
                    'singlish': "\n\n💡 Aluth application ekak start karanna role name eka reply karanna!",
                    'tanglish': "\n\n💡 Pudhu application start panna role name anuppunga!",
                }.get(language, "\n\n💡 Reply with a role name to apply!")
                return f"{vacancies_msg}{suffix}"

            else:
                # Mid-flow (e.g., awaiting country or CV). Show jobs, then re-prompt their current question.
                current_q = self._get_next_intake_question(candidate, language)
                prompt_prefix = {
                    'en': "👉 Continue:",
                    'si': "👉 ඉදිරියට:",
                    'ta': "👉 தொடருங்கள்:",
                    'singlish': "👉 Continue karamu:",
                    'tanglish': "👉 Continue pannalaam:",
                }.get(language, "👉 Continue:")
                return f"{vacancies_msg}\n\n{prompt_prefix} {current_q}"

        # ── TOP-LEVEL: Language selection intent (any state, any language) ────
        # Handles button taps (lang_en/lang_si/lang_ta normalised in webhooks.py)
        # AND free-text like "English plz", "Tamil", "Sinhala", "1", "2", "3".
        # Guard: skip during active intake/collection states to prevent short numeric
        # answers (e.g. height "156", years "2") from being mis-classified and
        # resetting the conversation state back to job-interest.
        _intake_active_states = (
            self.STATE_AWAITING_JOB,
            self.STATE_AWAITING_COUNTRY,
            self.STATE_AWAITING_JOB_SELECTION,
            self.STATE_AWAITING_EXPERIENCE,
            self.STATE_COLLECTING_JOB_REQS,
            self.STATE_AWAITING_CV,
            self.STATE_COLLECTING_INFO,
            self.STATE_PROCESSING_CV,
        )
        if _intent == "language_selection" and _llm_conf >= 0.55 and state not in _intake_active_states:
            _lang_haystack = text.lower()
            new_lang = None
            if any(w in _lang_haystack for w in ["english", "eng"]):
                new_lang = "en"
            elif _lang_haystack.strip() in ("1", "en"):
                new_lang = "en"
            elif any(w in _lang_haystack for w in ["sinhala", "sinhalese", "sinhalen", "සිංහල"]):
                new_lang = "si"
            elif _lang_haystack.strip() in ("2", "si"):
                new_lang = "si"
            elif any(w in _lang_haystack for w in ["tamil", "thamil", "tamizh", "thamizh", "தமிழ்"]):
                new_lang = "ta"
            elif _lang_haystack.strip() in ("3", "ta"):
                new_lang = "ta"
            # Singlish / Tanglish explicit selections
            elif any(w in _lang_haystack for w in ["singlish", "sinhala english", "machan", "machang"]):
                new_lang = "singlish"
            elif any(w in _lang_haystack for w in ["tanglish", "tamil english"]):
                new_lang = "tanglish"
            # Trust LLM's own detected language code when text matching fails
            if new_lang is None and _llm_lang in ("en", "si", "ta", "singlish", "tanglish"):
                new_lang = _llm_lang
            if new_lang:
                crud.update_candidate_language(db, candidate.id, new_lang)
                self._set_language_lock(db, candidate, True)
                language = new_lang
                crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_JOB)
                ack = self._lang_switch_ack(new_lang, candidate.name)
                job_q = PromptTemplates.get_intake_question("job_interest", new_lang)
                if phone_number:
                    try:
                        res = await meta_client.send_next_step_buttons(phone_number, job_q, new_lang)
                        if res and "error" not in res:
                            return ack
                    except Exception:
                        pass
                return f"{ack}\n\n{job_q}"

        # ── INITIAL: first ever message ───────────────────────────────────────
        if state == self.STATE_INITIAL:
            is_greet, greet_lang = is_greeting(text)
            lang = greet_lang or language

            # ── PRIORITY: Meta Click-to-WhatsApp ad trigger ───────────────────
            # Detect "START:ad_ref" auto-sent by WhatsApp when user clicks Meta ad
            ad_context = await ad_context_service.detect_and_load(text, candidate, db)
            if ad_context:
                # Job & country already pre-filled from ad — jump straight to CV
                crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_CV)

                # Personalised greeting set by recruitment system for this specific ad
                greeting = ad_context_service.get_greeting(ad_context) or \
                    PromptTemplates.get_greeting('welcome', lang, self.company_name)

                # Brief job snapshot so the candidate knows exactly what they applied for
                job = ad_context.get('job', {})
                project = ad_context.get('project', {})
                countries = project.get('countries', [])
                country_str = f" in {countries[0]}" if countries else ""
                salary_str = f"\n💰 Salary: {job['salary_range']}" if job.get('salary_range') else ""
                benefits = project.get('benefits', {})
                benefit_parts = []
                if benefits.get('accommodation'): benefit_parts.append('Accommodation')
                if benefits.get('food'):          benefit_parts.append('Meals')
                if benefits.get('flight'):        benefit_parts.append('Flight tickets')
                if benefits.get('medical'):       benefit_parts.append('Medical')
                benefit_str = f"\n⭐ Benefits: {', '.join(benefit_parts)}" if benefit_parts else ""
                interview_str = f"\n📅 Interview: {project['interview_date']}" if project.get('interview_date') else ""

                job_overview = (
                    f"📌 *{job.get('title', '')}*{country_str}"
                    f"{salary_str}{benefit_str}{interview_str}"
                )

                cv_q = PromptTemplates.get_intake_question('cv_upload', lang)
                return f"{greeting}\n\n{job_overview}\n\n{cv_q}"

            # ── Normal first message ───────────────────────────────────────────
            # Skip language menu for returning users with a confirmed language
            from app.nlp.language_detector import language_detector as _ld
            confirmed_lang = _ld.get_confirmed_language(phone_number) if phone_number else None
            if confirmed_lang and (is_greet or _is_apply_intent(text) or _intent in ('greeting', 'apply_intent', 'other')):
                # Returning user — skip language selection, go straight to job question
                crud.update_candidate_language(db, candidate.id, confirmed_lang)
                self._set_language_lock(db, candidate, True)
                crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_JOB)
                welcome = PromptTemplates.get_greeting('welcome', confirmed_lang, self.company_name)
                job_q = PromptTemplates.get_intake_question('job_interest', confirmed_lang)
                response = f"{welcome}\n\n{job_q}"
                self._log_msg(db, candidate.id, MessageTypeEnum.BOT, response, confirmed_lang)
                return response

            # If it's a greeting or apply intent → send interactive language selector
            if is_greet or _is_apply_intent(text) or _intent in ('greeting', 'apply_intent', 'other'):
                crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_LANGUAGE_SELECTION)
                welcome = PromptTemplates.get_greeting('welcome', lang, self.company_name)
                # Send interactive language selector button message directly
                if phone_number:
                    try:
                        res = await meta_client.send_language_selector(to_number=phone_number)
                        if res and "error" not in res:
                            return ""  # Successfully sent by meta_client, let webhook skip sending text
                    except Exception as _ie:
                        logger.warning(f"Interactive lang selector failed ({_ie}), falling back to text")
                # Fallback: plain text
                lang_sel = PromptTemplates.get_language_selection()
                return f"{welcome}\n\n{lang_sel}"

            # If they ask a question right away → answer via RAG then guide
            if _is_question(text):
                rag_resp = await rag_engine.generate_response_async(
                    user_message=text,
                    language=language,
                    candidate_info=self._candidate_info_dict(candidate)
                )
                guide = self._guide_to_apply(language)
                return f"{rag_resp}\n\n{guide}"

            # Anything else → polite opening with interactive language selector
            crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_LANGUAGE_SELECTION)
            welcome = PromptTemplates.get_greeting('welcome', language, self.company_name)
            if phone_number:
                try:
                    await meta_client.send_language_selector(to_number=phone_number)
                    return welcome
                except Exception:
                    pass
            lang_sel = PromptTemplates.get_language_selection()
            return f"{welcome}\n\n{lang_sel}"

        # ── AWAITING LANGUAGE SELECTION ───────────────────────────────────────
        elif state == self.STATE_AWAITING_LANGUAGE_SELECTION:
            text_norm = _normalize_text(text).lower()
            new_lang = None
            
            # Extended keyword matching — covers scripts, romanized names, common spellings,
            # and the Singlish/Tanglish code-switch registers.
            if any(w in text_norm for w in ["1", "1️⃣", "english", " en ", "eng"]):
                new_lang = "en"
            elif text_norm.strip() in ("en",):
                new_lang = "en"
            elif any(w in text_norm for w in [
                "2", "2️⃣", "sinhala", "sinhalese", "sinhalen", "si ", "සිංහල"
            ]):
                new_lang = "si"
            elif any(w in text_norm for w in [
                "3", "3️⃣", "tamil", "thamil", "tamizh", "thamizh", "ta ", "தமிழ்", "tamila"
            ]):
                new_lang = "ta"
            # Singlish / Tanglish explicit selections
            elif any(w in text_norm for w in ["singlish", "sinhala english", "machan", "machang"]):
                new_lang = "singlish"
            elif any(w in text_norm for w in ["tanglish", "tamil english"]):
                new_lang = "tanglish"
            elif text_norm.strip() in ("ta", "si"):
                new_lang = text_norm.strip()
            
            if not new_lang:
                # If user replied with a confirmatory word (ok / yes / sure) and we already
                # know their language (set by an earlier switch request), honour that choice.
                if _is_apply_intent(text) and candidate.language_preference.value in ('en', 'si', 'ta'):
                    stored = candidate.extracted_data or {}
                    new_lang = stored.get("language_register") or candidate.language_preference.value
                else:
                    # Fallback 1: script-based detection (returns singlish/tanglish for romanized)
                    det_lang, det_conf = detect_language(text, getattr(candidate, '_phone_number', None))
                    if det_conf > 0.6:
                        new_lang = det_lang
                    else:
                        # Fallback 2: classify_message() already ran; if it had detected
                        # language_selection the top-level handler would have returned.
                        # Generate a helpful LLM response and re-attach the language selector.
                        llm_resp = await rag_engine.generate_response_async(
                            user_message=text,
                            language=det_lang,
                            candidate_info=self._candidate_info_dict(candidate)
                        )
                        lang_sel = PromptTemplates.get_language_selection()
                        return f"{llm_resp}\n\n{lang_sel}"

            if not new_lang:
                return PromptTemplates.get_language_selection()

            # Update candidate's chosen language (also writes language_register to extracted_data)
            crud.update_candidate_language(db, candidate.id, new_lang)
            self._set_language_lock(db, candidate, True)
            language = new_lang

            # Move to job interest
            crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_JOB)
            # Engagement hook shown right after language chosen
            hook = PromptTemplates.get_engagement_hook(language)
            list_payload = self._build_job_picker_list_message(language)
            if list_payload:
                if hook:
                    list_payload = dict(list_payload)
                    list_payload["body_text"] = f"{hook}\n\n{list_payload.get('body_text', '')}".strip()
                return list_payload
            job_q = PromptTemplates.get_intake_question('job_interest', language)
            parts = [p for p in [hook, job_q] if p]
            return "\n\n".join(parts) if parts else job_q

        # ── AWAITING JOB INTEREST ─────────────────────────────────────────────
        elif state == self.STATE_AWAITING_JOB:
            text_norm = _normalize_text(text)

            # If user just clicked "Apply for a Job" or sent a standalone apply word, re-prompt directly
            clean_text = _APPLY_RE.sub('', text_norm).strip()
            if _is_apply_intent(text) and len(clean_text) < 3:
                return self._build_job_picker_list_message(language) or PromptTemplates.get_intake_question('job_interest', language)

            # Use pre-fetched validation if available (ran in parallel with classify)
            if prefetched_validation is not None:
                validation = prefetched_validation
            else:
                # Validate using LLM
                validation = await rag_engine.validate_intake_answer_async('job_interest', text, language)

            # Fallback for LLM failure/hallucinations: if it rejected, check exact match
            if not validation.get('is_valid'):
                matched_fallback = self._match_job_from_text(text_norm)
                if matched_fallback:
                    validation = {"is_valid": True, "extracted_value": text_norm}

            if not validation.get('is_valid'):
                # Short filler words / apply-intent → re-ask the question without extra fluff
                if _is_apply_intent(text) or len(text_norm) < 3:
                    return self._build_job_picker_list_message(language) or PromptTemplates.get_intake_question('job_interest', language)

                # If they explicitly ask about vacancies, list them (THIS IS THE ONLY TIME WE SHOW JOBS)
                if _is_vacancy_question(text) or _intent == "vacancy_query":
                    return self._build_job_picker_list_message(language) or PromptTemplates.get_intake_question('job_interest', language)

                # Secondary check: specialized multilingual entity extraction before declaring invalid
                ml_result = await rag_engine.extract_entities_multilingual(
                    text=text,
                    language=language,
                    active_countries=vacancy_service.get_active_countries(),
                    active_jobs=vacancy_service.get_active_job_titles(),
                )
                ml_job = ml_result.get('matched_crm_job') or ml_result.get('job_role')
                if ml_job and ml_result.get('confidence', 0.0) >= 0.65:
                    logger.info(f"STATE_AWAITING_JOB: ML secondary extraction found job='{ml_job}' (conf={ml_result.get('confidence')})")
                    validation = {"is_valid": True, "extracted_value": ml_job}
                    # Fall through to the valid-job path below
                else:
                    retries = self._increment_state_question_retry_count(db, candidate, self.STATE_AWAITING_JOB)
                    current_goal = self._current_goal_for_state(self.STATE_AWAITING_JOB)
                    agentic_msg = await rag_engine.generate_agentic_response(
                        user_message=text,
                        current_goal=current_goal,
                        language=language,
                    )

                    if retries >= 3:
                        auto_advanced = await self._apply_two_strike_auto_advance(db, candidate, self.STATE_AWAITING_JOB, language)
                        if auto_advanced is not None:
                            return auto_advanced

                    if retries >= 2:
                        list_payload = self._build_job_picker_list_message(language)
                        if list_payload:
                            list_payload = dict(list_payload)
                            list_payload["body_text"] = f"{agentic_msg}\n\n{list_payload.get('body_text', '')}".strip()
                            return list_payload

                    return agentic_msg

            if not validation.get('is_valid'):
                return self._build_job_picker_list_message(language) or PromptTemplates.get_intake_question('job_interest', language)

            # Valid job interest — the LLM already extracted the key value; trust it
            # regardless of how many words the original sentence had.
            extracted_job = validation.get('extracted_value') or text_norm
            matched = self._match_job_from_text(str(extracted_job))

            job_interest_value = str(extracted_job)
            if matched:
                job_id, job_info = matched
                job_interest_value = (job_info.get("title") or extracted_job)[:200]

            self._save_intake(db, candidate, 'job_interest', job_interest_value)
            self._reset_state_question_retry_count(db, candidate, self.STATE_AWAITING_JOB)

            # Reset confusion streak on valid answer
            _edata = candidate.extracted_data or {}
            _edata['confusion_streak'] = 0
            candidate.extracted_data = _edata
            data = candidate.extracted_data or {}
            if matched:
                job_id, job_info = matched
                data["matched_job_id"] = job_id
                req = job_info.get("requirements")
                data["job_requirements"] = dict(req) if isinstance(req, dict) else {}
                data.pop("future_pool", None)  # clear future_pool flag if now matched
                candidate.extracted_data = data
                db.commit()

            # Advance state
            crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_COUNTRY)

            # If no exact match found but cache has active jobs, be honest about availability
            # and register the candidate for future consideration (future pool)
            if not matched and get_job_cache():
                # Mark candidate as future pool so recruiters can identify them
                data = candidate.extracted_data or {}
                data["future_pool"] = True
                data["future_pool_role"] = job_interest_value
                candidate.extracted_data = data
                db.commit()

                j = job_interest_value.strip().title() if job_interest_value else "that role"
                no_match_note = {
                    'en': f"Thank you for your interest! Unfortunately, we don't have a *{j}* position open right now. 📋",
                    'si': f"ඔබගේ ඇල්ම ගැන ස්තූතියි! අවාසනාවකට, දැනට *{j}* රැකියාවක් නොමැත. 📋",
                    'ta': f"உங்கள் ஆர்வத்திற்கு நன்றி! துரதிர்ஷ்டவசமாக, இப்போது *{j}* பதவி காலியில்லை. 📋",
                    'singlish': f"Oyagey interest gena thanks! But dang *{j}* job ekak naha. 📋",
                    'tanglish': f"Ungal aarvathukku nandri! Aanaa ippo *{j}* position kaali illa. 📋",
                }
                
                # Re-ask what job they actually want
                job_q = PromptTemplates.get_intake_question('job_interest', language)
                reply = f"{no_match_note.get(language, no_match_note['en'])}\n\n{job_q}"
                
                # Revert their state so they can try answering the job again, because this was a mismatched job
                crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_JOB)
                
                return reply

            # Matched role — standard positive ack
            ack = self._build_job_ack(job_interest_value, language)
            return self._country_buttons_payload(language, body_prefix=ack.strip())

        # ── AWAITING DESTINATION COUNTRY ──────────────────────────────────────
        elif state == self.STATE_AWAITING_COUNTRY:
            text_norm = _normalize_text(text)

            validation = None
            extracted_country = None

            # Layer 1: Dictionary Check
            for key, val in _COUNTRY_MASTER_MAP.items():
                if key in text_norm:
                    extracted_country = val
                    validation = {"is_valid": True, "extracted_value": extracted_country}
                    break

            # Layer 2: Live DB Check
            if not validation:
                cache = get_job_cache()
                active_countries = {str(job.get('country') or '').strip().lower(): str(job.get('country') or '').strip() for job in cache.values() if job.get('country')}
                if text_norm in active_countries:
                    extracted_country = active_countries[text_norm]
                    validation = {"is_valid": True, "extracted_value": extracted_country}
                else:
                    # check if any active country name is fully contained in the user text
                    for ac_low, ac_real in active_countries.items():
                        if ac_low and ac_low in text_norm:
                            extracted_country = ac_real
                            validation = {"is_valid": True, "extracted_value": extracted_country}
                            break

            # Layer 3: Specialized multilingual entity extraction (CRM-aware fuzzy matching)
            if not validation:
                active_countries_list = vacancy_service.get_active_countries()
                active_jobs_list = vacancy_service.get_active_job_titles()
                ml_result = await rag_engine.extract_entities_multilingual(
                    text=text,
                    language=language,
                    active_countries=active_countries_list,
                    active_jobs=active_jobs_list,
                )
                extracted_ml = ml_result.get('matched_crm_country') or ml_result.get('country')
                if extracted_ml and ml_result.get('confidence', 0.0) >= 0.65:
                    logger.info(f"STATE_AWAITING_COUNTRY: Layer 3 ML extraction → '{extracted_ml}' (conf={ml_result.get('confidence')})")
                    validation = {"is_valid": True, "extracted_value": extracted_ml}
                else:
                    # Also try pre-fetched validation as secondary option
                    if prefetched_validation is not None:
                        validation = prefetched_validation
                    else:
                        validation = await rag_engine.validate_intake_answer_async('destination_country', text, language)

            was_loop_broken = False
            if not validation.get('is_valid'):
                country_retries = self._increment_state_question_retry_count(db, candidate, self.STATE_AWAITING_COUNTRY)

                if country_retries >= 3:
                    was_loop_broken = True
                    self._reset_state_question_retry_count(db, candidate, self.STATE_AWAITING_COUNTRY)
                    validation = {"is_valid": True, "extracted_value": "ANY"}
                else:
                    current_goal = self._current_goal_for_state(self.STATE_AWAITING_COUNTRY)
                    agentic_msg = await rag_engine.generate_agentic_response(
                        user_message=text,
                        current_goal=current_goal,
                        language=language,
                    )

                    # Second failed attempt: send visual aid alongside agentic response
                    if country_retries >= 2:
                        active_ctrs = vacancy_service.get_active_countries()
                        if active_ctrs:
                            country_rows = [
                                {"id": f"ctr_{i}", "title": c[:24]}
                                for i, c in enumerate(active_ctrs[:9])
                            ] + [{"id": "country_other", "title": "Other 🌍"}]
                            logger.info("STATE_AWAITING_COUNTRY: Agentic + interactive country list sent")
                            return {
                                "type": "list",
                                "body_text": agentic_msg,
                                "button_label": "Choose Country",
                                "sections": [{"title": "Active Destinations", "rows": country_rows}],
                            }
                        return self._country_buttons_payload(language, body_prefix=agentic_msg)

                    return agentic_msg

            extracted_country = validation.get('extracted_value') or text_norm
            if not extracted_country:
                return self._country_buttons_payload(language)

            self._save_intake(db, candidate, 'destination_country', str(extracted_country))
            self._reset_state_question_retry_count(db, candidate, self.STATE_AWAITING_COUNTRY)

            # Reset confusion streak on valid answer
            _edata = candidate.extracted_data or {}
            _edata['confusion_streak'] = 0
            candidate.extracted_data = _edata

            data = candidate.extracted_data or {}
            job_interest = str(data.get('job_interest') or '').strip()
            matching_jobs = await vacancy_service.get_matching_jobs(
                job_interest=job_interest,
                country=str(extracted_country),
                limit=3,
            )

            fallback_msg_str = ""
            if was_loop_broken:
                fallback_msgs = {
                    'en': "It seems we're having trouble matching a specific country. No worries! I'll set your preference to 'Global/Anywhere' for now so we can move forward.\n\n",
                    'si': "රටක් තෝරාගැනීමේදී ගැටලුවක් ඇති බව පෙනේ. කමක් නැහැ! අපි ඔබේ කැමැත්ත 'ඕනෑම රටක්' ලෙස සකසා ඉදිරියට යමු.\n\n",
                    'ta': "நாட்டைத் தேர்ந்தெடுப்பதில் சிக்கல் உள்ளதாகத் தெரிகிறது. பரவாயில்லை! நாம் 'எந்த நாடும்' என அமைத்து தொடரலாம்.\n\n",
                    'singlish': "Country eka match karanna podi awulak wage. Awulak na! Mama 'Glocal/Anywhere' kiyala dala idiriyata yannam.\n\n",
                    'tanglish': "Country select panradhula problem irukku pola. Paravailla! Naan 'Anywhere' nu set pannidren, namma continue panlam.\n\n"
                }
                fallback_msg_str = fallback_msgs.get(language, fallback_msgs['en'])

            if matching_jobs:
                data['presented_jobs'] = [str(job.get('id') or '') for job in matching_jobs[:3] if str(job.get('id') or '').strip()]
                data['presented_job_cards'] = matching_jobs[:3]
                candidate.extracted_data = data
                db.commit()

                crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_JOB_SELECTION)
                ack = self._build_country_ack(str(extracted_country), language)
                jobs_count = len(matching_jobs)
                
                if extracted_country == 'ANY':
                    list_intro = {
                        'en': f"Great! Since you are flexible, I looked at all our global locations and found {jobs_count} vacancies for {job_interest or 'your role'}.",
                        'si': f"නියමයි! ඔබ ඕනෑම රටකට කැමති නිසා ලොව පුරා {job_interest or 'ඔබගේ රැකියා භූමිකාව'} සඳහා පුරප්පාඩු {jobs_count} ක් මට හමුවුණා.",
                        'ta': "சிறப்பு! நீங்கள் எந்த நாடானாலும் சரி என்று கூறியதால், உலகம் முழுவதும் " + (job_interest or 'உங்கள் வேலை') + f"-க்காக {jobs_count} வேலைவாய்ப்புகளை நாடியுள்ளோம்.",
                        'singlish': f"Niyamai! Oya flexible nisa mama loke wate balala {job_interest or 'oya balana role eka'} vacancies {jobs_count} k hoyagaththa.",
                        'tanglish': f"Super! Neenga flexible nu sonnadhala, global-a thedi {job_interest or 'neenga paakura role'} kku {jobs_count} vacancies kandu pudichiruken.",
                    }.get(language, f"Great! Since you are flexible, I looked at all our global locations and found {jobs_count} vacancies for {job_interest or 'your role'}.")
                else:
                    list_intro = {
                        'en': f"Congratulations! 🎉 I found {jobs_count} vacancies for {job_interest or 'your role'} in {extracted_country}.",
                        'si': f"සුබ පැතුම්! 🎉 {extracted_country} හි {job_interest or 'ඔබගේ රැකියා භූමිකාව'} සඳහා පුරප්පාඩු {jobs_count} ක් මට හමුවුණා.",
                        'ta': f"வாழ்த்துக்கள்! 🎉 {extracted_country}-ல் {job_interest or 'உங்கள் வேலை பங்கு'} பணிக்கான {jobs_count} வேலைவாய்ப்புகள் உள்ளன.",
                        'singlish': f"Niyamai! 🎉 {extracted_country} wala {job_interest or 'oya balana role eka'} vacancies {jobs_count} k thiyenawa.",
                        'tanglish': f"Super! 🎉 {extracted_country}-la {job_interest or 'neenga paakura role'} kku {jobs_count} vacancies irukku.",
                    }.get(language, f"Congratulations! 🎉 I found {jobs_count} vacancies for {job_interest or 'your role'} in {extracted_country}.")

                rows = []
                for i, job in enumerate(data.get('presented_job_cards', [])[:3]):
                    title = job.get('title') or 'Job'
                    location = str(job.get('country') or extracted_country)
                    salary = job.get('salary') or ''
                    row_title = f"{title} ({location})"[:24]
                    row_desc = (salary if salary else job.get('description', ''))[:72]
                    rows.append({
                        "id": f"job_{i}",
                        "title": row_title,
                        "description": row_desc
                    })

                skip_title = {
                    'en': "Skip & Join Pool",
                    'si': "Skip කර Pool එකට යන්න",
                    'ta': "Skip செந்து Pool-ல் சேர்",
                    'singlish': "Skip - General Pool",
                    'tanglish': "Skip - General Pool"
                }.get(language, "Skip & Join Pool")[:24]

                rows.append({
                    "id": "skip",
                    "title": skip_title,
                    "description": "Don't select any specific job"[:72]
                })

                button_label = {
                    'en': "View Jobs",
                    'si': "රැකියා බලන්න",
                    'ta': "வேலைகளைப் பார்",
                    'singlish': "Jobs Balanna",
                    'tanglish': "Jobs Paarkavum"
                }.get(language, "View Jobs")[:20]

                return {
                    "type": "list",
                    "body_text": f"{fallback_msg_str}{list_intro}\n\n{ack}",
                    "button_label": button_label,
                    "sections": [
                        {
                            "title": "Available Vacancies"[:24],
                            "rows": rows
                        }
                    ]
                }

            has_exp = candidate.experience_years or data.get('experience_years_stated')
            next_state = self.STATE_AWAITING_CV if has_exp else self.STATE_AWAITING_EXPERIENCE
            crud.update_candidate_state(db, candidate.id, next_state)

            pool_msg = {
                'en': f"Currently, we don't have open positions for {job_interest or 'that role'} in {extracted_country}, but we frequently get new openings! Let's get your profile ready so we can contact you immediately when one opens up.",
                'si': f"දැනට {extracted_country} හි {job_interest or 'එම රැකියා භූමිකාව'} සඳහා පුරප්පාඩු නොමැත, නමුත් අනාගතයේදී පැමිණිය හැක! ඔබගේ තොරතුරු ලබා දෙන්න.",
                'ta': f"தற்போது {extracted_country}-ல் {job_interest or 'அந்த வேலை பங்கு'} வேலைகள் இல்லை, ஆனால் விரைவில் வரலாம்! உங்கள் விபரங்களை பதிவு செய்வோம்.",
                'singlish': f"Danata {extracted_country} wala {job_interest or 'e role eka'} vacancies naha, eth aluth ewa enawa! Api profile eka hadala thiyagamu.",
                'tanglish': f"Ippo {extracted_country}-la {job_interest or 'andha role'} vacancies illa, aana future-la varum! Profile-a ready pannuvom.",
            }
            
            if extracted_country == 'ANY':
                pool_msg = {
                    'en': f"Currently, we don't have open positions for {job_interest or 'that role'} anywhere, but we frequently get new openings! Let's get your profile ready so we can contact you immediately when one opens up.",
                    'si': f"දැනට {job_interest or 'එම රැකියා භූමිකාව'} සඳහා ලොව පුරා පුරප්පාඩු නොමැත, නමුත් අනාගතයේදී පැමිණිය හැක! ඔබගේ තොරතුරු ලබා දෙන්න.",
                    'ta': f"தற்போது {job_interest or 'அந்த வேலை பங்கு'} எங்கும் இல்லை, ஆனால் விரைவில் வரலாம்! உங்கள் விபரங்களை பதிவு செய்வோம்.",
                    'singlish': f"Danata {job_interest or 'e role eka'} global vacancies naha, eth aluth ewa enawa! Api profile eka hadala thiyagamu.",
                    'tanglish': f"Ippo {job_interest or 'andha role'} global vacancies illa, aana future-la varum! Profile-a ready pannuvom.",
                }

            next_q = PromptTemplates.get_intake_question('cv_upload' if has_exp else 'experience_years', language)
            reply_text = f"{pool_msg.get(language, pool_msg['en'])}\n\n{next_q}"
            if has_exp:
                return f"{fallback_msg_str}{reply_text}"
            button_payload = self._experience_buttons_payload(language)
            button_payload["body_text"] = f"{fallback_msg_str}{pool_msg.get(language, pool_msg['en'])}\n\n{button_payload.get('body_text', '')}".strip()
            return button_payload

        # ── AWAITING JOB SELECTION ───────────────────────────────────────────
        elif state == self.STATE_AWAITING_JOB_SELECTION:
            text_norm = _normalize_text(text).lower()
            data = candidate.extracted_data or {}
            presented_jobs = data.get('presented_job_cards') or data.get('presented_jobs') or []

            skip_words = {
                'skip', 'general pool', 'pool', 'later', 'none', 'no',
                'එපා', 'නැ', 'பிறகு', 'வேண்டாம்', 'illai', 'nehe',
            }
            if text_norm in skip_words or _is_no_intent(text):
                data.pop('presented_jobs', None)
                data.pop('presented_job_cards', None)
                data['selected_job_id'] = None
                data['selected_job_context'] = None
                candidate.extracted_data = data
                db.commit()

                # Check if we already have their experience
                has_exp = candidate.experience_years or data.get('experience_years_stated')

                msg = {
                    'en': "No problem — I’ll keep you in our general pool for matching roles.",
                    'si': "ප්‍රශ්නයක් නැහැ — ඔබව general pool එකේ තබාගෙන match වෙන roles බලමු.",
                    'ta': "பிரச்சனை இல்லை — உங்களை general pool-ல் வைத்து பொருந்தும் வேலைகளை பார்க்கிறேன்.",
                    'singlish': "Hari, awlak naha — oyawa general pool eke thiyagannam.",
                    'tanglish': "Parava illa — ungala general pool-la vechitu matching jobs paapom.",
                }

                if has_exp:
                    # Skip experience question, go straight to CV
                    crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_CV)
                    next_q = PromptTemplates.get_intake_question('cv_upload', language)
                    return f"{msg.get(language, msg['en'])}\n\n{next_q}"
                else:
                    # Ask for experience
                    crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_EXPERIENCE)
                    button_payload = self._experience_buttons_payload(language)
                    button_payload["body_text"] = f"{msg.get(language, msg['en'])}\n\n{button_payload.get('body_text', '')}".strip()
                    return button_payload

            idx = None
            if text_norm.startswith("job_"):
                try:
                    idx = int(text_norm.split("_")[1])
                except ValueError:
                    pass
            else:
                if any(x in text_norm for x in ['1', '1️⃣', 'one']): idx = 0
                elif any(x in text_norm for x in ['2', '2️⃣', 'two']): idx = 1
                elif any(x in text_norm for x in ['3', '3️⃣', 'three']): idx = 2

            if idx is None:
                reprompt = {
                    'en': "Please select a job from the list, or type Skip.",
                    'si': "කරුණාකර ලැයිස්තුවෙන් රැකියාවක් තෝරන්න, නැත්නම් Skip කියන්න.",
                    'ta': "பட்டியலிலிருந்து ஒரு வேலையைத் தேர்ந்தெடுக்கவும், இல்லை என்றால் Skip எழுதவும்.",
                    'singlish': "List eken job ekak select karanna, nathnam Skip kiyanna.",
                    'tanglish': "List-la irunthu job ah select pannunga, illa na Skip sollunga.",
                }
                button_label = {
                    'en': "View Jobs",
                    'si': "රැකියා බලන්න",
                    'ta': "வேலைகளைப் பார்",
                    'singlish': "Jobs Balanna",
                    'tanglish': "Jobs Paarkavum"
                }.get(language, "View Jobs")[:20]

                # We can construct the structure and fallback on plain text if we had reconstructed it, 
                # but simply returning text with instruction is usually sufficient for a fallback.
                return reprompt.get(language, reprompt['en'])

            if idx < 0 or idx >= len(presented_jobs):
                return {
                    'en': "That selection is invalid. Please select from the list.",
                    'si': "එම තේරීම වැරදියි. කරුණාකර ලැයිස්තුවෙන් තෝරන්න.",
                    'ta': "அந்த தேர்வு தவறானது. பட்டியலிலிருந்து தேர்ந்தெடுக்கவும்.",
                    'singlish': "E selection eka waradi. Karunakara list eken ganna.",
                    'tanglish': "Andha selection thappu. List-la onnu select pannunga.",
                }.get(language, "That selection is invalid. Please select from the list.")

            selected = presented_jobs[idx]
            selected_job_id = str(selected.get('id') or selected.get('job_id') or '')
            selected_context = {
                'job_id': selected_job_id,
                'title': selected.get('title') or '',
                'countries': [selected.get('country')] if selected.get('country') else [],
                'salary_range': selected.get('salary') or '',
                'description': selected.get('description') or '',
                'requirements': selected.get('requirements') or {},
            }

            data['selected_job_id'] = selected_job_id
            data['selected_job_title'] = selected_context['title']
            data['selected_job_context'] = selected_context
            data['matched_job_id'] = selected_job_id
            data['job_requirements'] = selected_context['requirements'] if isinstance(selected_context['requirements'], dict) else {}
            data.pop('presented_jobs', None)
            candidate.extracted_data = data
            db.commit()

            has_cv = bool(candidate.resume_file_path)
            has_exp = bool(candidate.experience_years) or bool(data.get('experience_years_stated'))

            if has_cv:
                confirm = {
                    'en': f"Excellent choice! Your application for *{selected_context['title']}* is complete with your CV.",
                    'si': f"විශිෂ්ට තේරීමක්! *{selected_context['title']}* සඳහා ඔබගේ අයදුම්පත CV එකත් සමග සම්පූර්ණයි.",
                    'ta': f"சிறந்த தேர்வு! *{selected_context['title']}* பணிக்கான உங்கள் விண்ணப்பம் CV உடன் முழுமையடைந்தது.",
                    'singlish': f"Niyamai! CV ekath ekka *{selected_context['title']}* application eka complete.",
                    'tanglish': f"Super choice! *{selected_context['title']}* ku unga application CV yoda complete aaiduchu.",
                }
                
                missing_queue = list(dict.fromkeys(data.get('missing_critical_fields', [])))
                if missing_queue:
                    crud.update_candidate_state(db, candidate.id, self.STATE_COLLECTING_INFO)
                    intake_field_alias = {'job_interest': 'job_interest', 'destination_country': 'destination_country', 'experience_years_stated': 'experience_years'}
                    next_field = missing_queue[0]
                    if next_field in intake_field_alias:
                        next_question = PromptTemplates.get_intake_question(intake_field_alias[next_field], language)
                    else:
                        next_question = text_extractor.get_missing_field_question(next_field, language)
                    return f"{confirm.get(language, confirm['en'])}\n\nI just need a little more information:\n{next_question}"
                else:
                    crud.update_candidate_state(db, candidate.id, self.STATE_APPLICATION_COMPLETE)
                    complete_msg = PromptTemplates.get_application_complete_message(language, self.company_name, candidate.name or "")
                    return f"{confirm.get(language, confirm['en'])}\n\n{complete_msg}"
            else:
                confirm = {
                    'en': f"Great choice — *{selected_context['title']}* selected ✅",
                    'si': f"හොඳ තේරීමක් — *{selected_context['title']}* තෝරාගත්තා ✅",
                    'ta': f"சிறந்த தேர்வு — *{selected_context['title']}* தேர்ந்தெடுக்கப்பட்டது ✅",
                    'singlish': f"Hari choice ekak — *{selected_context['title']}* select kala ✅",
                    'tanglish': f"Super choice — *{selected_context['title']}* select pannitinga ✅",
                }
                
                if has_exp:
                    crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_CV)
                    cv_q = PromptTemplates.get_intake_question('cv_upload', language)
                    return f"{confirm.get(language, confirm['en'])}\n\n{cv_q}"
                else:
                    crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_EXPERIENCE)
                    button_payload = self._experience_buttons_payload(language)
                    button_payload["body_text"] = f"{confirm.get(language, confirm['en'])}\n\n{button_payload.get('body_text', '')}".strip()
                    return button_payload

        # ── AWAITING EXPERIENCE ───────────────────────────────────────────────
        elif state == self.STATE_AWAITING_EXPERIENCE:
            text_norm = _normalize_text(text)

            # Use pre-fetched validation if available (ran in parallel with classify)
            if prefetched_validation is not None:
                validation = prefetched_validation
            else:
                validation = await rag_engine.validate_intake_answer_async('experience_years', text, language)
            
            if not validation.get('is_valid'):
                # local fallback
                yrs = _extract_years(text)
                if yrs is not None:
                    validation = {"is_valid": True, "extracted_value": str(yrs)}
                elif not _is_question(text) and len(text_norm) < 20 and text_norm not in ["yes", "no"]:
                    # just accept short text as experience if LLM is down
                    validation = {"is_valid": True, "extracted_value": text_norm}

            if not validation.get('is_valid'):
                retries = self._increment_state_question_retry_count(db, candidate, self.STATE_AWAITING_EXPERIENCE)
                if retries >= 3:
                    self._save_intake(db, candidate, 'experience_years_stated', "Unknown - Skipped")
                    if hasattr(candidate, "experience_years"):
                        candidate.experience_years = None
                    self._reset_state_question_retry_count(db, candidate, self.STATE_AWAITING_EXPERIENCE)

                    ack = {
                        'en': "No worries — I’ll mark experience as unknown for now.",
                        'si': "කමක් නැහැ — පළපුරුද්ද දැනට නොදන්නා ලෙස සටහන් කරමු.",
                        'ta': "பரவாயில்லை — அனுபவத்தை இப்போது தெரியவில்லை என்று பதிவு செய்கிறேன்.",
                        'singlish': "Awlak naha — experience eka danata unknown kiyala dānnam.",
                        'tanglish': "Parava illa — experience ippo unknown nu mark pannaren.",
                    }.get(language, "No worries — I’ll mark experience as unknown for now.")

                    early_result = await self._process_early_cv(db, candidate, f"{ack}\n\n")
                    if early_result:
                        return early_result
                    crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_CV)
                    cv_q = PromptTemplates.get_intake_question('cv_upload', language)
                    return f"{ack}\n\n{cv_q}"

                current_goal = self._current_goal_for_state(self.STATE_AWAITING_EXPERIENCE)
                agentic_msg = await rag_engine.generate_agentic_response(
                    user_message=text,
                    current_goal=current_goal,
                    language=language,
                )

                if retries >= 2:
                    button_payload = self._experience_buttons_payload(language)
                    button_payload["body_text"] = f"{agentic_msg}\n\n{button_payload.get('body_text', '')}".strip()
                    return button_payload

                return agentic_msg

            extracted_exp = validation.get('extracted_value') or text_norm
            years = _extract_years(str(extracted_exp))

            value = str(years) if years is not None else str(extracted_exp)
            self._save_intake(db, candidate, 'experience_years_stated', value)
            self._reset_state_question_retry_count(db, candidate, self.STATE_AWAITING_EXPERIENCE)

            # Reset confusion streak on valid answer
            _edata = candidate.extracted_data or {}
            _edata['confusion_streak'] = 0
            candidate.extracted_data = _edata
            if hasattr(candidate, "confusion_streak"):
                candidate.confusion_streak = 0
            if years is not None:
                candidate.experience_years = years
                db.commit()

            # Personalised acknowledgment echoing the years back
            ack = self._build_experience_ack(years, str(extracted_exp), language)

            # Check if there are specific job requirements to ask
            reqs = (candidate.extracted_data or {}).get("job_requirements", {})
            specific_info = list(reqs.get("specific_info_to_ask", []))
            
            # Auto-detect required fields from job requirements and add them if not already pending
            auto_fields = []
            if reqs.get("min_age") and "age" not in specific_info:
                auto_fields.append("age")
            if reqs.get("min_height_cm") and "height_cm" not in specific_info:
                auto_fields.append("height_cm")
            if reqs.get("licenses") and "licenses" not in specific_info:
                auto_fields.append("licenses")
            if reqs.get("required_languages") and "languages_spoken" not in specific_info:
                auto_fields.append("languages_spoken")
            specific_info = auto_fields + specific_info

            # ── FALLBACK: when DB has no requirements configured, generate role-based defaults ──
            if not specific_info:
                job_interest = (candidate.extracted_data or {}).get('job_interest', '')
                job_category = ""
                matched_id = (candidate.extracted_data or {}).get('matched_job_id', '')
                if matched_id:
                    _cache = get_job_cache()
                    job_category = (_cache.get(str(matched_id), {}) or {}).get('category', '')
                specific_info = self._get_default_role_questions(job_interest, job_category)

            if specific_info:
                # Store the list of pending questions
                data = candidate.extracted_data or {}
                data["pending_job_reqs"] = specific_info
                data["collected_job_reqs"] = {}
                crud.update_candidate(db, candidate.id, CandidateUpdate(extracted_data=data))
                crud.update_candidate_state(db, candidate.id, self.STATE_COLLECTING_JOB_REQS)
                
                # Ask the first one
                first_req = specific_info[0]
                q = await rag_engine.generate_missing_field_question_async(first_req, language)
                return f"{ack}\n\n{q}"

            # otherwise just proceed to CV (or process early CV if already received)
            early_result = await self._process_early_cv(db, candidate, f"{ack}\n\n")
            if early_result:
                return early_result
            crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_CV)
            cv_q = PromptTemplates.get_intake_question('cv_upload', language)
            return f"{ack}\n\n{cv_q}"

        # ── COLLECTING SPECIFIC JOB REQUIREMENTS ──────────────────────────────
        elif state == self.STATE_COLLECTING_JOB_REQS:
            if _is_question(text):
                rag_resp = await rag_engine.generate_response_async(
                    user_message=text,
                    language=language,
                    candidate_info=self._candidate_info_dict(candidate)
                )
                # Remind them of the current question
                data = candidate.extracted_data or {}
                pending = data.get("pending_job_reqs", [])
                if pending:
                    q = await rag_engine.generate_missing_field_question_async(pending[0], language)
                    return f"{rag_resp}\n\n{q}"
            
            data = candidate.extracted_data or {}
            pending = data.get("pending_job_reqs", [])
            collected = data.get("collected_job_reqs", {})
            
            if pending:
                current_req = pending.pop(0)
                collected[current_req] = text
                data["pending_job_reqs"] = pending
                data["collected_job_reqs"] = collected
                crud.update_candidate(db, candidate.id, CandidateUpdate(extracted_data=data))
                
                if pending:
                    next_req = pending[0]
                    q = await rag_engine.generate_missing_field_question_async(next_req, language)
                    thanks = _pick({
                        'en': ["Got it! ", "Perfect! ", "Great, thanks! "],
                        'si': ["හරි! ", "ස්තූතියි! "],
                        'ta': ["சரி! ", "நன்றி! "],
                    }.get(language, ["Got it! "]))
                    return f"{thanks}{q}"
            
            # If no more pending, proceed to CV
            thanks = _pick({
                'en': ["Thanks for that information! ", "Perfect, that's all the specific details needed. "],
                'si': ["එම තොරතුරු වලට ස්තූතියි! ", "හරි, එපමණයි අවශ්‍ය විශේෂ තොරතුරු. "],
                'ta': ["அந்த தகவலுக்கு நன்றி! ", "நன்று, குறிப்பிட்ட விவரங்கள் அவ்வளவுதான். "],
            }.get(language, ["Thanks! "]))
            # Process early CV if already received
            early_result = await self._process_early_cv(db, candidate, f"{thanks}\n\n")
            if early_result:
                return early_result
            crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_CV)
            cv_q = PromptTemplates.get_intake_question('cv_upload', language)
            return f"{thanks}\n\n{cv_q}"

        # ── AWAITING CV ───────────────────────────────────────────────────────
        elif state == self.STATE_AWAITING_CV:
            if _is_no_cv_message(text):
                data = candidate.extracted_data or {}
                data['cv_status'] = 'pending'
                data['cv_pending_reason'] = text[:200]
                candidate.extracted_data = data
                db.commit()
                self._reset_state_question_retry_count(db, candidate, self.STATE_AWAITING_CV)

                missing_queue = list(dict.fromkeys(data.get('missing_critical_fields', [])))
                if missing_queue:
                    crud.update_candidate_state(db, candidate.id, self.STATE_COLLECTING_INFO)
                    intake_field_alias = {
                        'job_interest': 'job_interest',
                        'destination_country': 'destination_country',
                        'experience_years_stated': 'experience_years',
                    }
                    next_field = missing_queue[0]
                    if next_field in intake_field_alias:
                        next_question = PromptTemplates.get_intake_question(intake_field_alias[next_field], language)
                    else:
                        next_question = text_extractor.get_missing_field_question(next_field, language)

                    proceed_msgs = {
                        'en': "No problem — we can continue even without a CV right now 👍",
                        'si': "ගැටලුවක් නැහැ — දැන් CV නැතිවත් අපි ඉදිරියට යන්න පුළුවන් 👍",
                        'ta': "பரவாயில்லை — இப்போது CV இல்லாமலும் நாம முன்னேறலாம் 👍",
                        'singlish': "Awlak naha — danata CV nathnamuth api continue karamu 👍",
                        'tanglish': "Parava illa — ippo CV illainalum naama continue pannalaam 👍",
                    }
                    return f"{proceed_msgs.get(language, proceed_msgs['en'])}\n\n{next_question}"

                crud.update_candidate_state(db, candidate.id, self.STATE_APPLICATION_COMPLETE)
                candidate.conversation_state = self.STATE_APPLICATION_COMPLETE
                self._dispatch_recruitment_sync_background(
                    candidate_id=candidate.id,
                    reason="no-cv-continue",
                )
                done_msgs = {
                    'en': "No worries if you don't have a CV right now 👍 I've submitted your basic profile. You can send your CV later anytime as PDF or Word.",
                    'si': "දැන් CV නැතිවුණාට ගැටලුවක් නැහැ 👍 ඔබගේ මූලික තොරතුරු යොමු කළා. CV එක පසුව PDF හෝ Word එකක් ලෙස ඕන වෙලාවක යවන්න.",
                    'ta': "இப்போது CV இல்லையெனில் பிரச்சினையில்லை 👍 உங்கள் அடிப்படை விபரங்கள் சமர்ப்பிக்கப்பட்டது. CV-ஐ பின்னர் எப்போது வேண்டுமானாலும் PDF அல்லது Word ஆக அனுப்பலாம்.",
                    'singlish': "Danata CV nathnam awlak naha 👍 Oyage basic profile eka submit kala. Passe oni welawakadi CV eka PDF/Word ekak widiyata ewanna.",
                    'tanglish': "Ippo CV illa-na problem illa 👍 Unga basic profile submit pannitten. Apram eppo venumnaalum CV-ah PDF/Word-a anuppunga.",
                }
                return done_msgs.get(language, done_msgs['en'])

            # They said something instead of sending CV
            if _is_question(text):
                rag_resp = await rag_engine.generate_response_async(
                    user_message=text,
                    language=language,
                    candidate_info=self._candidate_info_dict(candidate)
                )
                cv_nudge = PromptTemplates.get_awaiting_cv_message(language, self.company_name)
                return f"{rag_resp}\n\n{cv_nudge}"

            retries = self._increment_state_question_retry_count(db, candidate, self.STATE_AWAITING_CV)
            current_goal = self._current_goal_for_state(self.STATE_AWAITING_CV)
            agentic_msg = await rag_engine.generate_agentic_response(
                user_message=text,
                current_goal=current_goal,
                language=language,
            )

            if retries >= 2:
                cv_nudge = PromptTemplates.get_awaiting_cv_message(language, self.company_name)
                return f"{agentic_msg}\n\n{cv_nudge}"

            return agentic_msg

        # ── COLLECTING MISSING INFO ───────────────────────────────────────────
        elif state == self.STATE_COLLECTING_INFO:
            response = await self._handle_info_collection(db, candidate, text, language)
            # If info collection just completed the application, push to recruitment system
            if candidate.conversation_state == self.STATE_APPLICATION_COMPLETE:
                # Await directly — we're already in the background task, DB session is still valid
                try:
                    await recruitment_sync.push(candidate, db)
                except Exception as sync_err:
                    logger.error(f"Recruitment sync failed after info collection: {sync_err}")
            return response or PromptTemplates.get_application_complete_message(
                language, self.company_name, candidate.name or ""
            )

        # ── APPLICATION COMPLETE ──────────────────────────────────────────────
        elif state == self.STATE_APPLICATION_COMPLETE:
            # If it's a greeting, respond with a brief static acknowledgment only
            if is_greet:
                name = _first_name(candidate.name)
                hi = {'en': f"Hi{', ' + name if name else ''}! 👋 Your application is already on file with us. We'll be in touch soon! 😊",
                      'si': f"හෙලෝ{', ' + name if name else ''}! 👋 ඔබේ ඉල්ලුම්පත්‍රය දැනටමත් ගොනු කර ඇත. ඉක්මනින් දැනුම් දෙන්නෙමු! 😊",
                      'ta': f"வணக்கம்{', ' + name if name else ''}! 👋 உங்கள் விண்ணப்பம் ஏற்கனவே பதிவு செய்யப்பட்டுள்ளது. விரைவில் தொடர்பு கொள்கிறோம்! 😊"}
                return hi.get(language, hi['en'])

            # Vacancy browsing → guide toward structured new-application flow
            if _is_vacancy_question(text):
                cache = get_job_cache()
                active_jobs = [info for info in cache.values() if info.get("status") == "active"]
                if active_jobs:
                    titles = [info.get("title", "Unknown") for info in active_jobs[:5]]
                    job_list = "\n".join(f"  • {t}" for t in titles)
                    guide = {
                        'en': f"We have these open positions right now:\n{job_list}\n\nJust tell me the job title you're interested in and I'll start a new application for you! 😊",
                        'si': f"මේ අරාට පවතින ආසනිකයන් තියෙනවා:\n{job_list}\n\nඔබ කැමති රැකියා මාතෘකාව කියන්න, නව ඉල්ලුම්පත්‍රයක් පටන් ගනිමු! 😊",
                        'ta': f"இப்போது இந்த பதவிகள் காலியாக உள்ளன:\n{job_list}\n\nநீங்கள் விரும்பும் வேலையை சொல்லுங்கள், புதிய விண்ணப்பம் தொடங்குகிறேன்! 😊",
                        'singlish': f"Meth positions open:\n{job_list}\n\nKemathi job eka kiyanna, new application start karamu! 😊",
                        'tanglish': f"Ippo indha positions open-ah irruki:\n{job_list}\n\nKemana job sollunga, pudhu application start panniduven! 😊",
                    }
                else:
                    guide = {
                        'en': "No new vacancies at the moment, but we'll notify you when something comes up! 🔔",
                        'si': "මේ වෙලාවෙ නව ආසනික නැත, නමුත් එකක් ආවම දැනුම් දෙනවා! 🔔",
                        'ta': "இப்போது புதிய காலியிடங்கள் இல்லை, ஆனால் வரும்போது தெரிவிப்போம்! 🔔",
                        'singlish': "Apahu vacancy naha, eka awama kiyannakam! 🔔",
                        'tanglish': "Ippo pudhu vacancy illa, vandha solluven! 🔔",
                    }
                return guide.get(language, guide['en'])

            # Only generate AI response for genuine questions (status, interview dates, documents)
            if _is_question(text):
                follow_up = await rag_engine.generate_response_async(
                    user_message=text,
                    language=language,
                    candidate_info=self._candidate_info_dict(candidate)
                )
                return follow_up
            # Check if user is naming a job role to start a fresh application
            matched_new = self._match_job_from_text(text)
            if matched_new or (not _is_no_intent(text) and self._looks_like_job_title(text)):
                if matched_new:
                    new_job_id, new_job_info = matched_new
                    job_title = (new_job_info.get("title") or text.strip().title())
                else:
                    new_job_id, new_job_info = None, {}
                    job_title = text.strip().title()
                # Preserve language; reset intake data for the new application
                new_data: Dict[str, Any] = {'job_interest': job_title}
                if new_job_id:
                    new_data['matched_job_id'] = new_job_id
                    req = new_job_info.get("requirements")
                    new_data['job_requirements'] = dict(req) if isinstance(req, dict) else {}
                crud.update_candidate(db, candidate.id, CandidateUpdate(extracted_data=new_data))
                crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_COUNTRY)
                new_app_msgs = {
                    'en': f"Starting a new application for *{job_title}*! 🎉",
                    'si': f"*{job_title}* සඳහා නව ඉල්ලුම්පත්‍රයක් ආරම්භ කළා! 🎉",
                    'ta': f"*{job_title}* க்காக புதிய விண்ணப்பம் தொடங்கினோம்! 🎉",
                }
                return self._country_buttons_payload(language, body_prefix=new_app_msgs.get(language, new_app_msgs['en']))
            # For anything else: brief static reply
            done = {'en': "Your application is already submitted! ✅ We'll contact you soon.",
                    'si': "ඔබේ ඉල්ලුම්පත්‍රය ඉදිරිපත් කර ඇත! ✅ ඉක්මනින් අමතන්නෙමු.",
                    'ta': "உங்கள் விண்ணப்பம் சமர்ப்பிக்கப்பட்டது! ✅ விரைவில் தொடர்பு கொள்கிறோம்."}
            return done.get(language, done['en'])


        # FALLBACK
        else:
            return await self._handle_confused_message(
                db, candidate, text, language
            )

    # ─── CV Upload ────────────────────────────────────────────────────────────

    def _calculate_mismatches(self, cv_data, job_reqs: dict) -> list:
        mismatches = []
        if not cv_data or not job_reqs:
            return mismatches
            
        # Age
        age = getattr(cv_data, 'age', None)
        if age is not None:
            min_age = job_reqs.get('min_age')
            max_age = job_reqs.get('max_age')
            if min_age is not None and age < int(min_age):
                mismatches.append(f"Age ({age}) is below minimum required ({min_age})")
            if max_age is not None and age > int(max_age):
                mismatches.append(f"Age ({age}) is above maximum allowed ({max_age})")
                
        # Height
        height = getattr(cv_data, 'height_cm', None)
        if height is not None:
            min_height = job_reqs.get('min_height_cm')
            max_height = job_reqs.get('max_height_cm')
            if min_height is not None and height < int(min_height):
                mismatches.append(f"Height ({height}cm) is below minimum allowed ({min_height}cm)")
            if max_height is not None and height > int(max_height):
                mismatches.append(f"Height ({height}cm) is above maximum allowed ({max_height}cm)")
                
        # Experience
        exp = getattr(cv_data, 'total_experience_years', None)
        if exp is not None:
            req_exp = job_reqs.get('experience_years')
            try:
                if req_exp is not None and float(exp) < float(req_exp):
                    mismatches.append(f"Experience ({exp} years) is below minimum required ({req_exp} years)")
            except ValueError:
                pass
                
        return mismatches

    async def _handle_additional_document(
        self,
        db: Session,
        candidate,
        media_content: bytes,
        filename: str
    ) -> str:
        """Handle upload of additional documents like ID card, passport, certificates."""
        language = candidate.preferred_language or 'en'
        try:
            # 1. Save file
            file_path, _ = file_manager.save_cv(media_content, filename, candidate.phone_number)
            
            # 2. Update local state
            extracted = candidate.extracted_data or {}
            additional_docs = extracted.get('additional_documents', [])
            additional_docs.append({"path": file_path, "name": filename})
            extracted['additional_documents'] = additional_docs
            
            crud.update_candidate(db, candidate.id, CandidateUpdate(extracted_data=extracted))
            
            self._log_msg(db, candidate.id, MessageTypeEnum.USER, f"[Additional Document Uploaded: {filename}]", language, media_type="document")
            
            # 3. Inform user
            response = _pick({
                'en': ["Got the document, thanks! 📄", "Saved successfully! ✅", "Document received! 👍"],
                'si': ["ලිපිගොනුව ලැබුණා, ස්තූතියි! 📄", "සාර්ථකව save කළා! ✅"],
                'ta': ["ஆவணம் பெறப்பட்டது, நன்றி! 📄", "வெற்றிகரமாக சேமிக்கப்பட்டது! ✅"]
            }.get(language, ["Got the document, thanks! 📄"]))

            self._log_msg(db, candidate.id, MessageTypeEnum.BOT, response, language)
            
            # 4. Sync immediately with the new document
            try:
                await recruitment_sync.push(
                    candidate, db,
                    additional_doc_bytes=media_content,
                    additional_doc_filename=filename
                )
            except Exception as sync_err:
                logger.error(f"Recruitment sync failed for additional doc: {sync_err}")
                
            return response
            
        except Exception as e:
            logger.error(f"Error processing additional document: {e}", exc_info=True)
            return _pick({
                'en': ["Sorry, I couldn't process that document. Could you try again? 🙏"],
                'si': ["සමාවෙන්න, ලිපිගොනුව process කරන්න බැරි වුණා. නැවත උත්සාහ කරන්න 🙏"]
            }.get(language, ["Sorry, I couldn't process that document. 🙏"]))

    async def _handle_cv_upload(
        self,
        db: Session,
        candidate,
        file_content: bytes,
        filename: str,
        media_url: Optional[str] = None,
    ) -> str:
        language = candidate.language_preference.value

        try:
            crud.update_candidate_state(db, candidate.id, self.STATE_PROCESSING_CV)

            # Save file
            file_path, saved_name = file_manager.save_cv(
                file_content, filename, candidate.phone_number
            )

            # KEEP IN MEMORY so background task finds it if needed
            candidate.resume_file_path = file_path
            db.commit()

            # IMMEDIATE PORTAL PUSH: Even before AI extraction, guarantee the CV
            # reaches the recruiter!
            self._dispatch_recruitment_sync_background(
                candidate_id=candidate.id,
                cv_bytes=file_content,
                cv_filename=filename,
                reason="cv-upload-immediate",
            )

            # Intelligent extraction
            ext = (filename.rsplit('.', 1)[-1].lower() if '.' in filename else '')
            image_ext_to_mime = {
                'jpg': 'image/jpeg',
                'jpeg': 'image/jpeg',
                'png': 'image/png',
                'webp': 'image/webp',
                'bmp': 'image/bmp',
                'tiff': 'image/tiff',
            }
            vision_image_url = media_url
            if not vision_image_url and ext in image_ext_to_mime:
                b64 = base64.b64encode(file_content).decode('utf-8')
                vision_image_url = f"data:{image_ext_to_mime[ext]};base64,{b64}"

            document_processor = get_document_processor()
            result = document_processor.process_document(
                file_content=file_content,
                filename=filename,
                use_intelligent_extraction=True,
                use_openai_ocr=True,
                expected_language=language,
                image_url=vision_image_url,
            )

            if not result.success:
                logger.error(f"Document processing failed: {result.error_message}")
                cv_data = text_extractor.extract_from_bytes(file_content, filename)
                extracted_data = None
            else:
                extracted_data = result.extracted_data
                cv_data = None

            # Merge intake fields into extracted_data for storage
            existing_intake = candidate.extracted_data or {}
            
            intake_fields = {
                k: v for k, v in existing_intake.items()
                if k not in ['missing_fields', 'missing_critical_fields', 'pending_job_reqs']
            }
            
            # Use CV's current job title as job interest if none provided yet
            if 'job_interest' not in intake_fields and extracted_data and extracted_data.current_job_title:
                intake_fields['job_interest'] = extracted_data.current_job_title
            
            # Calculate mismatches
            mismatches = self._calculate_mismatches(
                extracted_data or cv_data, 
                existing_intake.get('job_requirements', {})
            )
            if mismatches:
                intake_fields['mismatches'] = mismatches

            # Update candidate DB record
            if extracted_data:
                merged = {**extracted_data.to_dict(), **intake_fields}
                crud.update_candidate_cv_data(db, candidate.id, merged, file_path)
                if extracted_data.full_name_confidence > 0.7:
                    candidate.name = extracted_data.full_name
                if extracted_data.email_confidence > 0.7:
                    candidate.email = extracted_data.email
                if extracted_data.highest_qualification_confidence > 0.7:
                    candidate.highest_qualification = extracted_data.highest_qualification
                if extracted_data.technical_skills:
                    candidate.skills = ', '.join(extracted_data.technical_skills[:10])
                if extracted_data.total_experience_years:
                    candidate.experience_years = int(extracted_data.total_experience_years)
                db.commit()
            else:
                merged = {**cv_data.to_dict(), **intake_fields}
                crud.update_candidate_cv_data(db, candidate.id, merged, file_path)

            # Keep in-memory candidate object in sync so recruitment_sync can
            # find the file path without having to reload from the DB.
            candidate.resume_file_path = file_path

            # Log upload
            self._log_msg(
                db, candidate.id, MessageTypeEnum.USER,
                f"[CV Uploaded: {filename}]", language, media_type="document"
            )

            # Determine missing fields
            missing_fields = (
                extracted_data.missing_critical_fields
                if extracted_data else cv_data.missing_fields
            )

            merged_data = candidate.extracted_data or {}

            # Smart inference from CV payload (supports both internal and generic key styles)
            inferred_role = (
                (extracted_data.current_job_title if extracted_data else None)
                or merged_data.get('current_job_title')
                or ((merged_data.get('professional_info') or {}).get('current_or_latest_role') if isinstance(merged_data.get('professional_info'), dict) else None)
            )
            if inferred_role and not merged_data.get('job_interest'):
                merged_data['job_interest'] = str(inferred_role).strip()

            inferred_exp = (
                (extracted_data.total_experience_years if extracted_data else None)
                or merged_data.get('total_experience_years')
                or ((merged_data.get('professional_info') or {}).get('total_years_experience') if isinstance(merged_data.get('professional_info'), dict) else None)
            )
            if inferred_exp is not None and not merged_data.get('experience_years_stated'):
                try:
                    merged_data['experience_years_stated'] = str(int(float(inferred_exp)))
                except Exception:
                    merged_data['experience_years_stated'] = str(inferred_exp)

            # Keep CV-required fields in queue for later collection if needed
            filtered_missing_fields = [
                field
                for field in list(missing_fields or [])
                if not merged_data.get(field)
            ]
            merged_data['missing_critical_fields'] = list(dict.fromkeys(filtered_missing_fields))
            candidate.extracted_data = merged_data
            db.commit()

            candidate_name = (
                (extracted_data.full_name if extracted_data else None)
                or candidate.name or ""
            )

            # Build CV summary
            if extracted_data:
                summary = self._build_cv_summary(
                    extracted_data, language,
                    result.extraction_confidence, candidate_name
                )
            else:
                summary = self._build_basic_cv_summary(cv_data, language, candidate_name)

            # Build intake recap (what we collected before CV)
            recap = self._build_intake_recap(intake_fields, language)

            # SEMANTIC MATCHING FOR JOBS POST-CV
            cv_title = (extracted_data.current_job_title if extracted_data else cv_data.current_position) or ""
            
            if extracted_data:
                cv_skills = " ".join(extracted_data.technical_skills or [])
            else:
                cv_skills = cv_data.skills or ""
            search_query = f"{cv_title} {cv_skills}".strip() or merged_data.get('job_interest', '')
            
            if not merged_data.get('selected_job_id') and search_query:
                matching_jobs = await vacancy_service.get_matching_jobs(
                    job_interest=search_query,
                    country=merged_data.get('destination_country', ''),
                    limit=3,
                )
                if matching_jobs:
                    merged_data['presented_jobs'] = [str(j.get('id') or '') for j in matching_jobs[:3] if str(j.get('id') or '').strip()]
                    merged_data['presented_job_cards'] = matching_jobs[:3]
                    candidate.extracted_data = merged_data
                    db.commit()

                    crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_JOB_SELECTION)
                    
                    list_intro = {
                        'en': f"Thanks for your CV! 📄✅ Based on your skills, I found {len(matching_jobs)} perfect job matches.",
                        'si': f"ඔබගේ CV එකට ස්තූතියි! 📄✅ ඔබගේ කුසලතා මත, මට {len(matching_jobs)} ගැලපෙන රැකියා හමුවුණා.",
                        'ta': f"உங்கள் CVக்கு நன்றி! 📄✅ உங்கள் திறமைகளின் அடிப்படையில், நான் {len(matching_jobs)} சரியான வேலைகளைக் கண்டேன்.",
                        'singlish': f"CV ekata thanks! 📄✅ Oyage skills walata match wena jobs {len(matching_jobs)} k thiyenawa.",
                        'tanglish': f"CV-ku thanks! 📄✅ Unga skills vachu, {len(matching_jobs)} perfect jobs kandupudichiruken.",
                    }.get(language, f"Thanks for your CV! 📄✅ Based on your skills, I found {len(matching_jobs)} perfect job matches.")

                    rows = []
                    for i, job in enumerate(matching_jobs[:3]):
                        title = job.get('title') or 'Job'
                        loc = str(job.get('country') or 'Location')
                        salary = job.get('salary') or ''
                        rows.append({
                            "id": f"job_{i}",
                            "title": f"{title} ({loc})"[:24],
                            "description": (salary if salary else job.get('description', ''))[:72]
                        })

                    skip_title = {
                        'en': "Skip & Complete", 'si': "Skip කර අවසන් කරන්න", 'ta': "Skip செந்து முடி",
                        'singlish': "Skip & Complete", 'tanglish': "Skip & Complete"
                    }.get(language, "Skip & Complete")[:24]

                    rows.append({
                        "id": "skip",
                        "title": skip_title,
                        "description": "Just complete my application"[:72]
                    })
                    btn_label = {
                        'en': "View Jobs", 'si': "රැකියා බලන්න", 'ta': "வேலைகளைப் பார்",
                        'singlish': "Jobs Balanna", 'tanglish': "Jobs Paarkavum"
                    }.get(language, "View Jobs")[:20]

                    return {
                        "type": "list",
                        "body_text": f"{recap}{summary}\n\n{list_intro}",
                        "button_label": btn_label,
                        "sections": [{"title": "Recommended Jobs"[:24], "rows": rows}]
                    }

            # Gap-fill routing for post-CV flow (never regress to earlier linear states)
            missing_queue = list(dict.fromkeys(merged_data.get('missing_critical_fields', [])))

            if missing_queue:
                crud.update_candidate_state(db, candidate.id, self.STATE_COLLECTING_INFO)
                candidate.conversation_state = self.STATE_COLLECTING_INFO
                merged_data['missing_critical_fields'] = missing_queue
                candidate.extracted_data = merged_data
                db.commit()

                intake_field_alias = {
                    'job_interest': 'job_interest',
                    'destination_country': 'destination_country',
                    'experience_years_stated': 'experience_years',
                }
                next_field = missing_queue[0]
                if next_field in intake_field_alias:
                    next_question = PromptTemplates.get_intake_question(intake_field_alias[next_field], language)
                else:
                    next_question = PromptTemplates.get_gap_filling_prompt(next_field)

                ack = {
                    'en': "Thanks for your CV! 📄✅ I’ve saved your details. I just need a little more information.",
                    'si': "ඔබගේ CV එකට ස්තූතියි! 📄✅ ඔබගේ විස්තර save කළා. තව ටිකක් තොරතුරු ඕන.",
                    'ta': "உங்கள் CVக்கு நன்றி! 📄✅ உங்கள் விவரங்கள் சேமிக்கப்பட்டது. இன்னும் சிறிய தகவல் வேண்டும்.",
                    'singlish': "CV ekata thanks! 📄✅ Oyage details save kala. Thawa poddak information one.",
                    'tanglish': "CV-ku thanks! 📄✅ Unga details save panniten. Innum konjam information venum.",
                }
                response = f"{recap}{summary}\n\n{ack.get(language, ack['en'])}\n\n{next_question}"
            else:
                crud.update_candidate_state(db, candidate.id, self.STATE_APPLICATION_COMPLETE)
                candidate.conversation_state = self.STATE_APPLICATION_COMPLETE
                complete_msg = PromptTemplates.get_application_complete_message(
                    language, self.company_name, candidate.name or ""
                )
                response = f"{recap}{summary}\n\n{complete_msg}"

            self._log_msg(db, candidate.id, MessageTypeEnum.BOT, response, language)

            return response

        except Exception as e:
            logger.error(f"Error processing CV upload: {e}", exc_info=True)
            errs = {
                'en': "Hmm, I had a small issue processing your CV. Could you try uploading it again? 🙏",
                'si': "ඔබගේ CV process කරන ගමන් ගැටළුවක් ආවා. නැවත upload කරන්න පුළුවන්ද? 🙏",
                'ta': "CV செயலாக்குவதில் சிறு பிரச்சனை. மீண்டும் upload முயற்சிக்கவும்? 🙏",
            }
            return errs.get(language, errs['en'])

    async def _build_vacancy_list(self, language: str, candidate_ctx: Dict[str, Any]) -> str:
        """
        Generates a beautifully formatted job list directly when intent is vacancy_query.
        """
        from app.services.vacancy_service import vacancy_service
        return await vacancy_service.search_and_refine(
            user_message="Provide me a list of job opportunities suitable for me.",
            entities={},
            language=language,
            candidate_info=candidate_ctx
        )

    # ─── Intake helpers ───────────────────────────────────────────────────────

    def _resume_prompt(self, candidate, language: str) -> str:
        """When a returning user sends a greeting mid-flow, gently remind where we left off."""
        state = candidate.conversation_state
        name = _first_name(candidate.name)
        hi = f"Hey{', ' + name if name else ''}! 😊 " if language == 'en' else (
            f"හෙලෝ{', ' + name if name else ''}! 😊 " if language == 'si' else
            f"வணக்கம்{', ' + name if name else ''}! 😊 "
        )
        if state == self.STATE_AWAITING_LANGUAGE_SELECTION:
            return hi + PromptTemplates.get_language_selection()
        elif state == self.STATE_AWAITING_JOB:
            return hi + PromptTemplates.get_intake_question('job_interest', language)
        elif state == self.STATE_AWAITING_COUNTRY:
            return hi + PromptTemplates.get_intake_question('destination_country', language)
        elif state == self.STATE_AWAITING_EXPERIENCE:
            return hi + PromptTemplates.get_intake_question('experience_years', language)
        elif state == self.STATE_AWAITING_CV:
            return hi + PromptTemplates.get_awaiting_cv_message(language, self.company_name)
        else:
            return hi + PromptTemplates.get_greeting('welcome', language, self.company_name)

    def _save_intake(self, db: Session, candidate, field: str, value: str):
        """Save an intake answer into candidate.extracted_data JSON."""

        data = candidate.extracted_data or {}
        data[field] = value
        candidate.extracted_data = data
        db.commit()

    # ─── Personalised acknowledgment builders ────────────────────────────────

    def _build_job_ack(self, job_value: str, language: str) -> str:
        """Return a short, personalised acknowledgment that echoes the job the user mentioned."""
        j = job_value.strip().title() if job_value else "that role"
        msgs = {
            'en': [
                f"Great choice — *{j}* is in good demand! 🌟 ",
                f"Nice, we work with employers looking for *{j}* roles! ⭐ ",
                f"*{j}* — perfect, we have good opportunities for that! 💼 ",
                f"Awesome, noted your interest in *{j}*! 👍 ",
            ],
            'si': [
                f"ඉතා හොඳ තේරීමක්! *{j}* ගැන හොඳ ඉල්ලුමක් තිබෙනවා! 🌟 ",
                f"හරි, *{j}* සඳහා රැකියා තිබෙනවා! ⭐ ",
                f"*{j}* — ඉතා හොඳ, ඒ ගැන හොඳ අවස්ථා තිබෙනවා! 💼 ",
            ],
            'ta': [
                f"சிறந்த தேர்வு! *{j}* க்கு நல்ல தேவை உள்ளது! 🌟 ",
                f"சரி, *{j}* பதவிகளுக்கான வாய்ப்புகள் உள்ளன! ⭐ ",
                f"*{j}* — அருமை, இதற்கு நல்ல வாய்ப்புகள் உள்ளன! 💼 ",
            ],
        }
        return _pick(msgs.get(language, msgs['en']))

    def _build_country_ack(self, country_value: str, language: str) -> str:
        """Return a short, personalised acknowledgment that echoes the destination country."""
        c = country_value.strip().title() if country_value else "that destination"
        msgs = {
            'en': [
                f"Great destination! 🌍 *{c}* has strong job opportunities. ",
                f"*{c}* — excellent choice, we have connections there! 🌟 ",
                f"Perfect, we work with top employers in *{c}*! ",
            ],
            'si': [
                f"ඉතා හොඳ ගමනාන්තයක්! 🌍 *{c}* හි හොඳ රැකියා අවස්ථා තිබෙනවා. ",
                f"*{c}* — විශිෂ්ට! එහි අපට ශක්තිමත් සබඳතා තිබෙනවා. 🌟 ",
            ],
            'ta': [
                f"சிறந்த நாடு! 🌍 *{c}*-ல் நல்ல வேலை வாய்ப்புகள் உள்ளன. ",
                f"*{c}* — அருமையான தேர்வு, எங்களுக்கு அங்கு நல்ல தொடர்புகள் உள்ளன. 🌟 ",
            ],
        }
        return _pick(msgs.get(language, msgs['en']))

    def _build_experience_ack(self, years: Optional[int], raw_value: str, language: str) -> str:
        """Return a short, personalised acknowledgment that echoes the years of experience."""
        if years is not None:
            yr_str = f"{years} year{'s' if years != 1 else ''}"
            yr_str_si = f"අවුරුදු {years}"
            yr_str_ta = f"{years} ஆண்டுகள்"
        else:
            yr_str = raw_value
            yr_str_si = raw_value
            yr_str_ta = raw_value

        msgs = {
            'en': [
                f"*{yr_str}* of experience — that's solid! 💪 ",
                f"Great, *{yr_str}* experience is a strong background! 👍 ",
                f"*{yr_str}* — employers will like that! ⭐ ",
            ],
            'si': [
                f"*{yr_str_si}* ක් පළපුරුද්ද — ඉතා හොඳයි! 💪 ",
                f"*{yr_str_si}* ක් පළපුරුද්ද — ශක්තිමත් පසුබිමක්! 👍 ",
            ],
            'ta': [
                f"*{yr_str_ta}* அனுபவம் — சிறந்தது! 💪 ",
                f"*{yr_str_ta}* — நிறுவனங்கள் இதை விரும்புவார்கள்! 👍 ",
            ],
        }
        return _pick(msgs.get(language, msgs['en']))

    def _build_intake_recap(self, intake: dict, language: str) -> str:
        """Build a short recap of what was collected during intake."""
        if not intake:
            return ""

        job = intake.get('job_interest', '')
        country = intake.get('destination_country', '')
        exp = intake.get('experience_years_stated', '')
        
        # Add collected specific job requirements
        collected_reqs = intake.get('collected_job_reqs', {})
        reqs_en = [f"📌 {k}: {v}" for k, v in collected_reqs.items()]
        reqs_si = [f"📌 {k}: {v}" for k, v in collected_reqs.items()]
        reqs_ta = [f"📌 {k}: {v}" for k, v in collected_reqs.items()]

        if language == 'si':
            parts = []
            if job:     parts.append(f"💼 රැකියාව: {job}")
            if country: parts.append(f"🌍 රට: {country}")
            if exp:     parts.append(f"📊 Experience: {exp} years")
            parts.extend(reqs_si)
            if parts:
                return "ඔබගේ preferences:\n" + "\n".join(parts) + "\n\n"
        elif language == 'ta':
            parts = []
            if job:     parts.append(f"💼 பதவி: {job}")
            if country: parts.append(f"🌍 நாடு: {country}")
            if exp:     parts.append(f"📊 அனுபவம்: {exp} ஆண்டுகள்")
            parts.extend(reqs_ta)
            if parts:
                return "உங்கள் விருப்பங்கள்:\n" + "\n".join(parts) + "\n\n"
        else:
            parts = []
            if job:     parts.append(f"💼 Role: {job}")
            if country: parts.append(f"🌍 Country: {country}")
            if exp:     parts.append(f"📊 Experience: {exp} years")
            parts.extend(reqs_en)
            if parts:
                return "Your application details:\n" + "\n".join(parts) + "\n\n"

        return ""

    def _guide_to_apply(self, language: str) -> str:
        """Prompt user to apply after answering their info question."""
        options = {
            'en': [
                "Would you like to go ahead and apply? I can guide you through it! 😊",
                "Interested in applying? I can walk you through the process!",
            ],
            'si': [
                "Apply කරන්නද කැමතිද? මම guide කරන්නම්! 😊",
                "Apply කරන්නද? Process එක guide කරන්නම්!",
            ],
            'ta': [
                "விண்ணப்பிக்க விரும்புகிறீர்களா? நான் வழிகாட்டுகிறேன்! 😊",
                "விண்ணப்பிக்க விரும்புகிறீர்களா? செயல்முறையை விளக்குகிறேன்!",
            ],
        }
        return _pick(options.get(language, options['en']))

    @staticmethod
    def _looks_like_job_title(text: str) -> bool:
        """Heuristic: short text with no question mark is probably a job title."""
        # Avoid common negative phrases
        negatives = ["don't know", "not sure", "no", "none", "nothing"]
        if any(n in text.lower() for n in negatives):
            return False
        return len(text) < 50 and '?' not in text and len(text.split()) < 6

    def _match_job_from_text(self, text: str) -> Optional[tuple]:
        """
        Match user text to a job from the synced job cache.
        Returns (job_id, job_info dict) or None if no match.
        """
        cache = get_job_cache()
        if not cache:
            return None
        text_norm = text.strip().lower()
        
        # Stop generic "Apply" from matching the interactive button payload.
        if text_norm in ["apply", "apply for a job", "apply job", "want to apply", "interested"]:
            return None
            
        words = set(re.findall(r'\w+', text_norm))
        best = None
        best_score = 0
        for jid, info in cache.items():
            if info.get("status") != "active":
                continue
            title = (info.get("title") or "").strip().lower()
            category = (info.get("category") or "").strip().lower()
            title_words = set(re.findall(r'\w+', title))
            cat_words = set(re.findall(r'\w+', category))
            if not title_words and not cat_words:
                continue
            if text_norm in title or (title_words and title_words <= words):
                score = len(title_words) + 2
                if score > best_score:
                    best_score = score
                    best = (jid, info)
            elif title in text_norm or (words & title_words):
                score = len(words & title_words) + 1
                if score > best_score:
                    best_score = score
                    best = (jid, info)
            elif words & cat_words:
                score = len(words & cat_words)
                if score > best_score:
                    best_score = score
                    best = (jid, info)
        return best

    def _get_default_role_questions(self, job_title: str, job_category: str = "") -> list:
        """
        Return a sensible list of screening fields to ask when no specific requirements
        are configured in the DB for the matched job.  Always returns at least a couple
        of items so candidates feel they are being properly screened.
        """
        title_lower = (job_title or "").lower()
        cat_lower = (job_category or "").lower()

        # Medical / healthcare roles
        if any(kw in title_lower or kw in cat_lower for kw in
               ['nurs', 'doctor', 'physician', 'midwife', 'paramedic', 'pharmacist',
                'therapist', 'caregiver', 'care assistant', 'ward', 'medical', 'health']):
            return ['nursing_license', 'qualification_level', 'passport_status']

        # Driver roles
        if any(kw in title_lower for kw in
               ['driver', 'chauffeur', 'operator', 'forklift']):
            return ['license_type', 'passport_status']

        # IT / software (checked before generic 'engineer' to avoid mis-match)
        if any(kw in title_lower or kw in cat_lower for kw in
               ['software', 'developer', 'programmer', 'data ', 'data science',
                'network', ' it ', 'information technology', 'cyber', 'devops']):
            return ['english_proficiency', 'passport_status']

        # Construction / technical trades
        if any(kw in title_lower or kw in cat_lower for kw in
               ['construct', 'mason', 'welder', 'carpenter', 'electrician', 'plumber',
                'mechanic', 'technician', 'engineer', 'fabricat', 'steel', 'scaffold']):
            return ['technical_certification', 'passport_status']

        # Hospitality / hotel / cleaning
        if any(kw in title_lower or kw in cat_lower for kw in
               ['hotel', 'hospitality', 'housekeep', 'steward', 'waiter', 'chef',
                'cook', 'kitchen', 'cleaner', 'laundry']):
            return ['english_proficiency', 'passport_status']

        # Security
        if any(kw in title_lower or kw in cat_lower for kw in
               ['security', 'guard', 'bodyguar']):
            return ['height_cm', 'passport_status']

        # Generic fallback — always ask at least about passport and availability
        return ['passport_status', 'availability']

    def _get_available_roles_hint(self, language: str) -> str:
        """Return a short hint listing available job titles from cache, or empty string."""
        cache = get_job_cache()
        active = [
            (info.get("title") or "").split(" - ")[0].strip()
            for info in cache.values()
            if info.get("status") == "active"
        ]
        if not active:
            return ""
        seen = set()
        unique = [t for t in active if t and t not in seen and not seen.add(t)]
        if not unique:
            return ""
        roles = ", ".join(unique[:8])
        hints = {
            "en": f"Current openings include: {roles}.",
            "si": f"දැන් තියෙන රැකියා: {roles}.",
            "ta": f"தற்போதைய வெற்றிடங்கள்: {roles}.",
        }
        return hints.get(language, hints["en"])

    async def _build_vacancy_list(
        self, language: str, candidate_context: Optional[dict] = None
    ) -> str:
        """
        Build a formatted list of available vacancies from the job cache.
        Prioritises jobs that match the candidate's stated interest when
        candidate_context is supplied.  Attempts a live cache refresh when the
        cache is empty before falling back to a RAG knowledge-base query.
        """
        cache = get_job_cache()
        active_jobs = [
            info for info in cache.values()
            if info.get("status") == "active"
        ]

        # If cache is empty, attempt a live refresh from the recruitment system
        if not active_jobs:
            try:
                loaded = await refresh_job_cache()
                if loaded > 0:
                    cache = get_job_cache()
                    active_jobs = [
                        info for info in cache.values()
                        if info.get("status") == "active"
                    ]
            except Exception as refresh_err:
                logger.warning(f"Live job cache refresh failed: {refresh_err}")

        if not active_jobs:
            # Final fallback — ask the RAG engine which has synced job content
            try:
                rag_resp = await rag_engine.generate_response_async(
                    user_message="List all current active job vacancies available",
                    language=language,
                    candidate_info=candidate_context or {}
                )
                if rag_resp:
                    return rag_resp
            except Exception:
                pass
            no_info = {
                'en': (
                    "I don't have the full list of current openings right now, but we have positions "
                    "in Security, Construction, Manufacturing, Hospitality, and more. "
                    "Please tell me which type of job you're interested in and I'll guide you! 😊"
                ),
                'si': (
                    "දැනට ඇති රැකියා ලැයිස්තුව සම්පූර්ණයෙන් මට නැත, නමුත් Security, Construction, \n"
                    "Manufacturing, Hospitality ඇතුළු බොහෝ රැකියා තිබේ. "
                    "කුමන ආකාරයේ රැකියාවක් ගැන කැමැත්තතිද කියන්නද? 😊"
                ),
                'ta': (
                    "தற்போதைய காலியிட பட்டியல் இப்போது என்னிடம் இல்லை, ஆனால் Security, Construction, \n"
                    "Manufacturing, Hospitality உள்ளிட்ட பல வேலை வாய்ப்புகள் உள்ளன. "
                    "எந்த வகையான வேலையில் ஆர்வம் உள்ளது என்று சொல்லுங்கள்! 😊"
                ),
            }
            return no_info.get(language, no_info['en'])

        # ── Smart sorting: show candidate-matched jobs first ──────────────────
        matched_ids: set = set()
        if candidate_context:
            job_interest = (candidate_context.get('job_interest') or '').lower()
            interest_words = set(re.findall(r'\w+', job_interest)) if job_interest else set()
            if interest_words:
                for info in active_jobs:
                    jid = str(info.get('job_id', ''))
                    title_words = set(re.findall(r'\w+', (info.get('title') or '').lower()))
                    if interest_words & title_words:
                        matched_ids.add(jid)

        sorted_jobs = (
            [j for j in active_jobs if str(j.get('job_id', '')) in matched_ids] +
            [j for j in active_jobs if str(j.get('job_id', '')) not in matched_ids]
        )

        # Build list of unique jobs with appealing WhatsApp formatting
        seen = set()
        matched_lines: list = []
        other_lines: list = []
        for info in sorted_jobs[:10]:
            title = (info.get("title") or "").strip()
            if not title or title in seen:
                continue
            seen.add(title)

            # Extract Salary and Country for the UI
            salary = info.get("salary_range") or info.get("salary")
            salary_str = f" | 💰 {salary}" if salary else ""

            country = info.get("country") or info.get("location") or "Overseas"
            country_str = f"🌍 {country}"

            # WhatsApp Appealing Format:
            # 💼 *Job Title*
            # 🌍 Country | 💰 Salary
            line = f"💼 *{title}*\n   {country_str}{salary_str}\n"
            if str(info.get('job_id', '')) in matched_ids:
                matched_lines.append(line)
            else:
                other_lines.append(line)

        if matched_lines and other_lines:
            best_lbl = {'en': "Best matches for you", 'si': "ඔබට ගැළපෙන", 'ta': "உங்களுக்கு ஏற்றவை"}.get(language, "Best matches")
            other_lbl = {'en': "Other openings", 'si': "සෙසු රැකියා", 'ta': "மற்ற வாய்ப்புகள்"}.get(language, "Other openings")
            roles_list = (
                f"⭐ {best_lbl}:\n" + "\n".join(matched_lines[:5]) +
                f"\n\n📋 {other_lbl}:\n" + "\n".join(other_lines[:8])
            )
        else:
            roles_list = "\n".join((matched_lines + other_lines)[:10])

        intros = {
            'en': f"Here are our current job openings:\n\n{roles_list}\n\nWhich one are you interested in? 🙋",
            'si': f"දැනට ඇති රැකියා අවස්ථා:\n\n{roles_list}\n\nකුමක් ගැන කැමැත්තතිද? 🙋",
            'ta': f"தற்போதைய வேலை வாய்ப்புகள்:\n\n{roles_list}\n\nஎது பிடிக்கும்? 🙋",
            'singlish': f"Dan open positions mewa:\n\n{roles_list}\n\nOyata hariyana role eka monada? 🙋",
            'tanglish': f"Ippo open positions inga irukku:\n\n{roles_list}\n\nUngalukku pidicha role enna? 🙋",
        }
        return intros.get(language, intros['en'])

    # ─── Missing info collection (post-CV) ───────────────────────────────────

    async def _handle_info_collection(
        self,
        db: Session,
        candidate,
        text: str,
        language: str
    ) -> Optional[str]:
        extracted_data = candidate.extracted_data or {}
        missing_fields = extracted_data.get('missing_critical_fields', extracted_data.get('missing_fields', []))

        def _has_field_value(field_name: str) -> bool:
            value = extracted_data.get(field_name)
            if value:
                return True
            if field_name == 'experience_years_stated' and extracted_data.get('experience_years'):
                return True
            return False

        pruned_missing = [field for field in list(missing_fields or []) if not _has_field_value(field)]
        if pruned_missing != list(missing_fields or []):
            extracted_data['missing_critical_fields'] = pruned_missing
            crud.update_candidate(db, candidate.id, CandidateUpdate(extracted_data=extracted_data))
        missing_fields = pruned_missing

        intake_field_alias = {
            'job_interest': 'job_interest',
            'destination_country': 'destination_country',
            'experience_years_stated': 'experience_years',
        }

        if not missing_fields:
            crud.update_candidate_state(db, candidate.id, self.STATE_APPLICATION_COMPLETE)
            candidate.conversation_state = self.STATE_APPLICATION_COMPLETE  # keep in-memory object in sync
            return PromptTemplates.get_application_complete_message(
                language, self.company_name, candidate.name or ""
            )

        current_field = missing_fields[0]
        if current_field == 'experience_years_stated':
            yrs = _extract_years(text)
            extracted_value = str(yrs) if yrs is not None else None
        else:
            extracted_value = self._extract_field(current_field, text)

        if extracted_value:
            extracted_data[current_field] = extracted_value
            while current_field in missing_fields:
                missing_fields.remove(current_field)
            extracted_data['missing_critical_fields'] = missing_fields
            extracted_data['question_retries'] = 0
            if hasattr(candidate, "question_retries"):
                candidate.question_retries = 0

            if current_field == 'experience_years_stated':
                try:
                    candidate.experience_years = int(float(extracted_value))
                except Exception:
                    pass

            crud.update_candidate(db, candidate.id, CandidateUpdate(
                extracted_data=extracted_data,
                **({current_field: extracted_value}
                   if current_field in ('name', 'email', 'highest_qualification', 'skills')
                   else {})
            ))

            if current_field in ('name', 'full_name'):
                candidate.name = extracted_value

            if missing_fields:
                next_field = missing_fields[0]
                if next_field in intake_field_alias:
                    question = PromptTemplates.get_intake_question(intake_field_alias[next_field], language)
                else:
                    question = PromptTemplates.get_gap_filling_prompt(next_field)
                thanks = _pick({
                    'en': ["Got it! ", "Perfect! ", "Great, thanks! "],
                    'si': ["හරි! ", "ස්තූතියි! "],
                    'ta': ["சரி! ", "நன்றி! "],
                }.get(language, ["Got it! "]))
                return thanks + question
            else:
                crud.update_candidate_state(db, candidate.id, self.STATE_APPLICATION_COMPLETE)
                candidate.conversation_state = self.STATE_APPLICATION_COMPLETE  # keep in-memory object in sync
                return PromptTemplates.get_application_complete_message(
                    language, self.company_name, candidate.name or ""
                )

            retries = self._increment_question_retries(db, candidate)
            if retries >= 2:
                extracted_data[current_field] = "Unknown - Skipped"
                while current_field in missing_fields:
                    missing_fields.remove(current_field)
                extracted_data['missing_critical_fields'] = missing_fields
                extracted_data['question_retries'] = 0
                if hasattr(candidate, "question_retries"):
                    candidate.question_retries = 0

                crud.update_candidate(db, candidate.id, CandidateUpdate(extracted_data=extracted_data))

                if missing_fields:
                    next_field = missing_fields[0]
                    if next_field in intake_field_alias:
                        question = PromptTemplates.get_intake_question(intake_field_alias[next_field], language)
                    else:
                        question = PromptTemplates.get_gap_filling_prompt(next_field)
                    return f"Noted — I'll mark this as unknown for now.\n\n{question}"

                crud.update_candidate_state(db, candidate.id, self.STATE_APPLICATION_COMPLETE)
                candidate.conversation_state = self.STATE_APPLICATION_COMPLETE
                return PromptTemplates.get_application_complete_message(
                    language, self.company_name, candidate.name or ""
                )

        readable_field = intake_field_alias.get(current_field, current_field).replace('_', ' ')
        clarify = {
            'en': [
                f"Sorry, I didn't catch that. Could you share your {readable_field} again?",
                f"No worries — could you type your {readable_field} one more time?",
            ],
            'si': [
                f"සමාවෙන්න, මට ඒක හරියට ගත නොහැකි වුණා. ඔබගේ {readable_field} කියන්න පුළුවන්ද?",
                f"තව වතාවක් කියන්නද? ඔබගේ {readable_field} ඕන.",
            ],
            'ta': [
                f"மன்னிக்கவும், சரியாக புரியவில்லை. உங்கள் {readable_field} மீண்டும் சொல்ல முடியுமா?",
                f"கவலைப்படாதீர்கள் — உங்கள் {readable_field} மறுபடி தட்டச்சு செய்ய முடியுமா?",
            ],
        }
        return _pick(clarify.get(language, clarify['en']))

    # ─── Contextual / RAG fallback ────────────────────────────────────────────

    async def _generate_contextual_response(
        self,
        db: Session,
        candidate,
        text: str,
        language: str
    ) -> str:
        history = crud.get_conversation_context(db, candidate.id, limit=6)
        rag_resp = await rag_engine.generate_response_async(
            user_message=text,
            conversation_history=history,
            candidate_info=self._candidate_info_dict(candidate),
            language=language,
            use_rag=True
        )

        # Append a state-aware guide so the conversation stays on track.
        # Strip the greeting part ("Hey! 😊 ") from the resume prompt so we don't
        # double-greet, then append just the relevant question.
        guide = self._resume_prompt(candidate, language)
        # Remove leading greeting up to (and including) the first sentence-ending punctuation
        if '😊 ' in guide:
            guide = guide.split('😊 ', 1)[-1].strip()
        elif '! ' in guide:
            guide = guide.split('! ', 1)[-1].strip()

        if guide and guide not in rag_resp:
            return f"{rag_resp}\n\n{guide}"
        return rag_resp

    # ─── CV Summary builders ──────────────────────────────────────────────────

    def _build_cv_summary(
        self,
        data: ExtractedCVData,
        language: str,
        confidence: float,
        candidate_name: str = ""
    ) -> str:
        response = PromptTemplates.get_cv_summary_header(language, candidate_name) + "\n\n"

        if data.full_name:
            lbl = {'en': 'Name', 'si': 'නම', 'ta': 'பெயர்'}
            chk = "✓" if data.full_name_confidence > 0.8 else "?"
            response += f"📌 {lbl.get(language,'Name')}: {data.full_name} {chk}\n"
        if data.email:
            chk = "✓" if data.email_confidence > 0.8 else "?"
            response += f"📧 Email: {data.email} {chk}\n"
        if data.phone:
            lbl = {'en': 'Phone', 'si': 'දුරකථනය', 'ta': 'தொலைபேசி'}
            chk = "✓" if data.phone_confidence > 0.8 else "?"
            response += f"📱 {lbl.get(language,'Phone')}: {data.phone} {chk}\n"
        if data.highest_qualification:
            lbl = {'en': 'Qualification', 'si': 'සුදුසුකම', 'ta': 'தகுதி'}
            response += f"🎓 {lbl.get(language,'Qualification')}: {data.highest_qualification}\n"
        if data.current_job_title:
            lbl = {'en': 'Current Role', 'si': 'වත්මන් තනතුර', 'ta': 'தற்போதைய பதவி'}
            response += f"💼 {lbl.get(language,'Current Role')}: {data.current_job_title}\n"
        if data.current_company:
            lbl = {'en': 'Company', 'si': 'සමාගම', 'ta': 'நிறுவனம்'}
            response += f"🏢 {lbl.get(language,'Company')}: {data.current_company}\n"
        if data.total_experience_years:
            lbl = {'en': 'Experience', 'si': 'පළපුරුද්ද', 'ta': 'அனுபவம்'}
            response += f"📊 {lbl.get(language,'Experience')}: {data.total_experience_years} years\n"
        if data.technical_skills:
            lbl = {'en': 'Skills', 'si': 'කුසලතා', 'ta': 'திறன்கள்'}
            skills = ', '.join(data.technical_skills[:8])
            if len(data.technical_skills) > 8:
                skills += f" (+{len(data.technical_skills)-8} more)"
            response += f"⚡ {lbl.get(language,'Skills')}: {skills}\n"

        if confidence > 0.8:
            chk = {'en': "\n✅ High confidence extraction",
                   'si': "\n✅ ඉහළ විශ්වාසනීයත්වය",
                   'ta': "\n✅ அதிக நம்பகத்தன்மை"}
            response += chk.get(language, chk['en'])
        elif confidence < 0.5:
            warn = {'en': "\n⚠️ Some info may need verification",
                    'si': "\n⚠️ සමහර info verify කරන්න ඕනෑ",
                    'ta': "\n⚠️ சில தகவல்கள் சரிபார்க்க வேண்டும்"}
            response += warn.get(language, warn['en'])

        return response.strip()

    def _build_basic_cv_summary(
        self, cv_data: CVData, language: str, candidate_name: str = ""
    ) -> str:
        response = PromptTemplates.get_cv_summary_header(language, candidate_name) + "\n\n"
        lbl_name   = {'en': 'Name',          'si': 'නම',        'ta': 'பெயர்'}
        lbl_phone  = {'en': 'Phone',         'si': 'දුරකථනය',   'ta': 'தொலைபேசி'}
        lbl_qual   = {'en': 'Qualification', 'si': 'සුදුසුකම',  'ta': 'தகுதி'}
        lbl_skills = {'en': 'Skills',        'si': 'කුසලතා',    'ta': 'திறன்கள்'}
        if cv_data.name:
            response += f"📌 {lbl_name.get(language,'Name')}: {cv_data.name}\n"
        if cv_data.email:
            response += f"📧 Email: {cv_data.email}\n"
        if cv_data.phone:
            response += f"📱 {lbl_phone.get(language,'Phone')}: {cv_data.phone}\n"
        if cv_data.highest_qualification:
            response += f"🎓 {lbl_qual.get(language,'Qualification')}: {cv_data.highest_qualification}\n"
        if cv_data.skills:
            response += f"💼 {lbl_skills.get(language,'Skills')}: {cv_data.skills[:120]}\n"
        return response.strip()

    # ─── Utility helpers ──────────────────────────────────────────────────────

    def _candidate_info_dict(self, candidate) -> dict:
        data = candidate.extracted_data or {}
        return {
            'name':                   candidate.name,
            'email':                  candidate.email,
            'phone':                  candidate.phone_number,
            'skills':                 candidate.skills,
            'highest_qualification':  candidate.highest_qualification,
            'experience_years':       candidate.experience_years,
            'conversation_state':     candidate.conversation_state,
            'job_interest':           data.get('job_interest', ''),
            'destination_country':    data.get('destination_country', ''),
        }

    def _effective_language(self, candidate) -> str:
        data = candidate.extracted_data or {}
        return data.get("language_register") or getattr(candidate.language_preference, "value", "en") or "en"

    def _is_language_locked(self, candidate) -> bool:
        data = candidate.extracted_data or {}
        if "language_locked" in data:
            return bool(data.get("language_locked"))
        return bool(data.get("language_register")) and candidate.conversation_state not in (
            self.STATE_INITIAL,
            self.STATE_AWAITING_LANGUAGE_SELECTION,
        )

    def _set_language_lock(self, db: Session, candidate, locked: bool = True) -> None:
        data = candidate.extracted_data or {}
        data["language_locked"] = bool(locked)
        candidate.extracted_data = data
        db.commit()

    def _log_msg(
        self,
        db: Session,
        candidate_id: int,
        msg_type: MessageTypeEnum,
        text: str,
        language: str,
        sentiment_score: float = None,
        sentiment_label: str = None,
        has_profanity: bool = False,
        media_type: str = None
    ):
        crud.create_conversation(db, ConversationCreate(
            candidate_id=candidate_id,
            message_type=msg_type,
            message_text=text,
            detected_language=language,
            sentiment_score=sentiment_score,
            sentiment_label=sentiment_label,
            has_profanity=has_profanity,
            media_type=media_type
        ))

    def _to_cv_data(self, extracted: ExtractedCVData) -> CVData:
        return CVData(
            name=extracted.full_name,
            email=extracted.email,
            phone=extracted.phone,
            address=extracted.address,
            highest_qualification=extracted.highest_qualification,
            skills=', '.join(extracted.technical_skills) if extracted.technical_skills else None,
            experience_years=int(extracted.total_experience_years) if extracted.total_experience_years else None,
            current_company=extracted.current_company,
            current_position=extracted.current_job_title,
            notice_period=extracted.notice_period,
            summary=extracted.profile_summary,
            education=[ed.get('degree', '') for ed in extracted.education_details],
            work_experience=[wh.get('job_title', '') for wh in extracted.work_history],
            languages=extracted.languages_spoken,
            raw_text=extracted.raw_text,
            missing_fields=extracted.missing_critical_fields
        )

    def _extract_field(self, field: str, text: str) -> Optional[str]:
        text = text.strip()
        if field == 'email':
            m = re.search(r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b', text)
            return m.group(0) if m else None
        if field == 'phone':
            m = re.search(r'\+?\d[\d\s-]{8,}', text)
            return m.group(0).strip() if m else None
        if field == 'name':
            if 2 <= len(text.split()) <= 5 and len(text) < 100:
                return text.title()
            return text[:100] if len(text) > 3 else None
        if field == 'highest_qualification':
            return text if len(text) > 2 else None
        if field == 'experience_years':
            return _extract_years(text)
        return text if len(text) > 2 else None

    def _lang_switch_ack(self, language: str, candidate_name: str = "") -> str:
        name = _first_name(candidate_name)
        options = {
            'si': [
                f"{'ස්තූතියි ' + name + '! ' if name else ''}දැන් සිංහලෙන් කතා කරමු 😊",
                f"Okay{', ' + name if name else ''}! සිංහලෙන් හොඳටම කරන්නෙව්.",
            ],
            'ta': [
                f"{'நன்றி ' + name + '! ' if name else ''}இப்போது தமிழில் பேசலாம் 😊",
                f"சரி{', ' + name if name else ''}! தமிழில் தொடருவோம்.",
            ],
            'en': [
                f"Sure{', ' + name if name else ''}! English it is 😊",
                f"Of course{', ' + name if name else ''}! Let's continue in English.",
            ],
            'singlish': [
                f"Okay{', ' + name + ' da' if name else ' da'}! Singlish it is — let's go! 😊",
                f"No problem{', ' + name if name else ''}! We'll chat Singlish style 🤙",
            ],
            'tanglish': [
                f"Seri{', ' + name if name else ''}! Tanglish-la pesalam — let's go! 😊",
                f"Okay{', ' + name + ' da' if name else ' da'}! Tanglish-la continue pannalam.",
            ],
        }
        return _pick(options.get(language, options['en']))

    def _default_response(self, db, candidate) -> str:
        """Response when payload has no text/media."""
        language = self._effective_language(candidate)
        opts = {
            'en': "Sorry, I didn't get that. Send a text or your CV! 😊",
            'si': "මට එක් ගත නොහැකි වුණා. Text එකකා CV එකකා ෂෙයාර් කරන්න! 😊",
            'ta': "புரியவில்லை. Text அல்லது CV அனுப்பவும்! 😊",
            'singlish': "Sorry da, send text or CV la! 😊",
            'tanglish': "Puriyala da, text or CV anuppu! 😊",
        }
        return opts.get(language, opts['en'])

    def _error_response(self, language: str, error_type: str = "error_generic") -> str:
        return PromptTemplates.get_error_message(error_type, language)

    async def _handle_confused_message(
        self,
        db,
        candidate,
        text: str,
        language: str
    ) -> str:
        """
        Fallback for unrecognised intents ('other') and low-confidence classifications.
        Tries RAG first; if the RAG returns a generic/empty response, replies with a
        register-matched 'didn't understand' + optionally recruiter handoff.
        """
        try:
            history = crud.get_conversation_context(db, candidate.id, limit=4)
            rag_resp = await rag_engine.generate_response_async(
                user_message=text,
                conversation_history=history,
                candidate_info=self._candidate_info_dict(candidate),
                language=language,
                use_rag=True,
            )
            # If RAG produced a meaningful response (>15 chars), return it
            if rag_resp and len(rag_resp.strip()) > 15:
                data = candidate.extracted_data or {}
                data['confusion_streak'] = 0
                candidate.extracted_data = data
                if hasattr(candidate, "confusion_streak"):
                    candidate.confusion_streak = 0
                db.commit()
                return rag_resp
        except Exception as _e:
            logger.warning(f"_handle_confused_message RAG failed: {_e}")

        data = candidate.extracted_data or {}
        confusion = int(data.get('confusion_streak', getattr(candidate, 'confusion_streak', 0) or 0)) + 1
        data['confusion_streak'] = confusion
        data['is_human_handoff'] = confusion >= 3
        candidate.extracted_data = data
        if hasattr(candidate, "confusion_streak"):
            candidate.confusion_streak = confusion

        if confusion >= 3:
            crud.update_candidate_state(db, candidate.id, self.STATE_HUMAN_HANDOFF)
            candidate.conversation_state = self.STATE_HUMAN_HANDOFF
            if hasattr(candidate, "status"):
                candidate.status = self.STATE_HUMAN_HANDOFF
            db.commit()
            await self._notify_human_handoff(candidate, reason="confusion_streak>=3")
            return (
                "It seems like we are getting a bit stuck! 🛑 I am going to notify one of our human "
                "agents to message you right here. Please wait a moment."
            )

        db.commit()
        # RAG had nothing useful — return register-matched fallback
        return self.GIBBERISH_FALLBACK_MESSAGE


# Singleton
chatbot = ChatbotEngine()
