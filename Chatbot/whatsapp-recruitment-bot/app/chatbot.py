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
import difflib
import httpx
from typing import Optional, Dict, Any, Union, List

from sqlalchemy.orm import Session

from app.config import settings
from app.llm.agent_router import route_user_message
from app.nlp.language_detector import (
    detect_language, is_greeting, detect_language_switch_request, normalize_sri_lankan_input
)
from app.nlp.sentiment_analyzer import analyze_sentiment, get_de_escalation
from app.cv_parser.text_extractor import text_extractor, CVData
from app.cv_parser.document_processor import get_document_processor
from app.cv_parser.intelligent_extractor import ExtractedCVData
from app.llm.rag_engine import rag_engine
from app.llm.prompt_templates import (
    PromptTemplates,
    DEWAN_AGENT_PROMPT,
    SUPERVISOR_OVERRIDE_PROMPT,
)
from app.utils.file_handler import file_manager
from app import crud
from app.schemas import ConversationCreate, CandidateUpdate, MessageTypeEnum
from app.database import SessionLocal
from app.services.ad_context_service import ad_context_service
from app.services.recruitment_sync import recruitment_sync
from app.services.vacancy_service import vacancy_service
from app.services.voice_service import voice_service
from app.utils.meta_client import meta_client
from app.knowledge import get_job_cache, refresh_job_cache


logger = logging.getLogger(__name__)


def is_repeating(proposed_response: str, recent_messages: List[str]) -> bool:
    """Checks if the proposed response is >80% similar to recent messages."""
    if not proposed_response or not recent_messages:
        return False

    for past_message in recent_messages:
        similarity = difflib.SequenceMatcher(
            None,
            proposed_response.lower(),
            str(past_message).lower(),
        ).ratio()
        if similarity > 0.80:
            return True
    return False


def _default_extracted_profile() -> Dict[str, Any]:
    return {
        "job_role": None,
        "target_countries": [],
        "age": None,
        "licenses": [],
        "experience_years": None,
    }


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

_INTERACTIVE_TOKEN_RE = re.compile(
    r"^(job_\d+|skip|skip_complete|ctr_\d+|country_[a-z_]+|exp_[a-z0-9_]+"
    r"|lang_en|lang_si|lang_ta"
    r"|action_apply|action_vacancies|action_question)$",
    re.IGNORECASE,
)

_LANG_REJECT_RE = re.compile(
    r"(dont\s+understand|don't\s+understand|do\s+not\s+understand|"
    r"i\s+cant\s+understand|i\s+can't\s+understand|no\s+sinhala|no\s+tamil|"
    r"i\s+dont\s+know\s+sinhala|i\s+don't\s+know\s+sinhala|"
    r"මට\s+සිංහල\s+තේරෙන්නෙ\s+නැ|සිංහල\s+තේරෙන්නෙ\s+නැ|"
    r"எனக்கு\s+சிங்களம்\s+புரியாது|சிங்களம்\s+புரியாது)",
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


def _is_structured_interactive_token(text: str) -> bool:
    return bool(_INTERACTIVE_TOKEN_RE.match((text or "").strip()))


def _extract_rejected_language(text: str) -> Optional[str]:
    low = (text or "").lower()
    if not _LANG_REJECT_RE.search(low):
        return None
    if "sinhala" in low or "සිංහල" in text:
        return "si"
    if "tamil" in low or "தமிழ்" in text:
        return "ta"
    if "english" in low:
        return "en"
    return None


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
    NORMALIZATION_CONFUSING_FALLBACK = (
        "I'm sorry, I didn't quite catch that. To help you better, please reply with your language: "
        "1 for English, 2 for Sinhala, 3 for Tamil."
    )
    NORMALIZATION_SECOND_CHANCE_MESSAGE = "Could you please clarify what kind of job you are looking for?"

    def __init__(self):
        self.company_name = settings.company_name

    @staticmethod
    def _response_preview_text(response: Union[str, Dict[str, Any]]) -> str:
        """Extract a text preview from either plain text or interactive payloads."""
        if isinstance(response, str):
            return response.strip()
        if isinstance(response, dict):
            return str(response.get("body_text") or "").strip()
        return ""

    def _localized_language_selector_prompt(self, language: str) -> str:
        prompts = {
            "en": "To help you better, please select your preferred language:\n1. English\n2. Sinhala\n3. Tamil",
            "si": "ඔබට හොඳින් උදව් කිරීමට, කරුණාකර ඔබගේ භාෂාව තෝරන්න:\n1. English\n2. Sinhala\n3. Tamil",
            "ta": "உங்களுக்கு நல்ல உதவி செய்ய, தயவு செய்து உங்கள் மொழியைத் தேர்வு செய்யவும்:\n1. English\n2. Sinhala\n3. Tamil",
            "singlish": "Oyata honda help karanna, oyage language eka select karanna:\n1. English\n2. Sinhala\n3. Tamil",
            "tanglish": "Ungalukku nalla help panna, unga language-a select pannunga:\n1. English\n2. Sinhala\n3. Tamil",
        }
        return prompts.get(language, prompts["en"])

    def _normalization_confusing_fallback(self, language: str) -> str:
        prompts = {
            "en": "I'm sorry, I didn't quite catch that. To help you better, please reply with your language: 1 for English, 2 for Sinhala, 3 for Tamil.",
            "si": "සමාවන්න, ඔබ කියූ දේ හරියටම තේරුම් ගන්න බැරි වුණා. කරුණාකර භාෂාව 1 (English), 2 (Sinhala), 3 (Tamil) ලෙස reply කරන්න.",
            "ta": "மன்னிக்கவும், உங்கள் செய்தி முழுமையாக புரியவில்லை. தயவு செய்து மொழியை 1 (English), 2 (Sinhala), 3 (Tamil) என்று reply செய்யவும்.",
            "singlish": "Samawenna, oyage message eka hariyata catch une ne. Language eka reply karanna: 1 English, 2 Sinhala, 3 Tamil.",
            "tanglish": "Sorry, unga message clear-ah puriyala. Language-a reply pannunga: 1 English, 2 Sinhala, 3 Tamil.",
        }
        return prompts.get(language, prompts["en"])

    def _normalization_second_chance_message(self, language: str) -> str:
        prompts = {
            "en": "Could you please clarify what kind of job you are looking for?",
            "si": "ඔබ බලාපොරොත්තු වන රැකියා වර්ගය ටිකක් පැහැදිලි කරලා කියන්න පුළුවන්ද?",
            "ta": "நீங்கள் எந்த வகை வேலை தேடுகிறீர்கள் என்பதை சற்று தெளிவாக சொல்ல முடியுமா?",
            "singlish": "Oya balanne mona wage job ekakda kiyala tikak clear karanna puluwanda?",
            "tanglish": "Neenga thedura job type enna-nu konjam clear-ah solla mudiyuma?",
        }
        return prompts.get(language, prompts["en"])

    def _loop_failsafe_message(self, language: str = "en") -> str:
        return self._localized_language_selector_prompt(language)

    @staticmethod
    def _should_use_loop_failsafe(reply: str) -> bool:
        low = (reply or "").lower()
        if not low:
            return True
        return ("sorry" in low) or ("understand" in low)

    @staticmethod
    def _get_recent_bot_messages(candidate) -> List[str]:
        messages = getattr(candidate, "recent_bot_messages", None)
        if isinstance(messages, list):
            return [str(m) for m in messages if str(m).strip()]
        return []

    def _push_recent_bot_message(self, db: Session, candidate, message: str) -> None:
        text = (message or "").strip()
        if not text:
            return
        recent = self._get_recent_bot_messages(candidate)
        recent.append(text)
        candidate.recent_bot_messages = recent[-3:]
        db.commit()

    async def _call_supervisor_ai(
        self,
        user_message: str,
        stuck_response: str,
        current_state: Dict[str, Any],
        language: str,
    ) -> str:
        fallback = self._loop_failsafe_message(language)
        current_state_json = json.dumps(current_state or {}, ensure_ascii=False)
        prompt = SUPERVISOR_OVERRIDE_PROMPT.format(
            user_message=(user_message or "")[:1000],
            stuck_response=(stuck_response or "")[:1000],
            current_state=current_state_json[:2000],
            language=language or "en",
        )

        if not getattr(rag_engine, "async_openai_client", None):
            return fallback

        try:
            response = await rag_engine.async_openai_client.chat.completions.create(
                model=rag_engine.complex_chat_model if language in ("singlish", "tanglish") else rag_engine.chat_model,
                messages=[
                    {"role": "system", "content": PromptTemplates.SYSTEM_PROMPT},
                    {"role": "user", "content": prompt},
                ],
                timeout=10,
            )
            return str(response.choices[0].message.content or "").strip() or fallback
        except Exception as exc:
            logger.warning(f"Supervisor override failed: {exc}")
            return fallback

    async def _apply_loop_guard(
        self,
        db: Session,
        candidate,
        raw_user_text: str,
        proposed_response: Union[str, Dict[str, Any]],
        language: str,
    ) -> Union[str, Dict[str, Any]]:
        preview = self._response_preview_text(proposed_response)
        recent = self._get_recent_bot_messages(candidate)
        if not is_repeating(preview, recent):
            if preview:
                self._push_recent_bot_message(db, candidate, preview)
            return proposed_response

        logger.warning(
            f"LOOP DETECTED for {candidate.phone_number}. Triggering Supervisor Override."
        )

        supervisor_reply = await self._call_supervisor_ai(
            user_message=raw_user_text,
            stuck_response=preview,
            current_state=self._coerce_extracted_profile(getattr(candidate, "extracted_profile", {})),
            language=language,
        )

        if self._should_use_loop_failsafe(supervisor_reply):
            supervisor_reply = self._loop_failsafe_message(language)

        self._push_recent_bot_message(db, candidate, supervisor_reply)
        return supervisor_reply

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

    def _get_confusion_counter(self, candidate) -> int:
        data = candidate.extracted_data or {}
        raw = data.get("confusion_counter", data.get("confusion_streak", getattr(candidate, "confusion_streak", 0)))
        try:
            return max(0, int(raw or 0))
        except Exception:
            return 0

    def _set_confusion_counter(self, db: Session, candidate, value: int) -> None:
        counter = max(0, int(value))
        data = candidate.extracted_data or {}
        data["confusion_counter"] = counter
        data["confusion_streak"] = counter
        if counter == 0:
            data["is_human_handoff"] = False
        candidate.extracted_data = data
        if hasattr(candidate, "confusion_streak"):
            candidate.confusion_streak = counter
        db.commit()

    def _increment_confusion_counter(self, db: Session, candidate) -> int:
        counter = self._get_confusion_counter(candidate) + 1
        self._set_confusion_counter(db, candidate, counter)
        return counter

    def _reset_confusion_counter(self, db: Session, candidate) -> None:
        self._set_confusion_counter(db, candidate, 0)

    def _current_goal_for_state(self, state: str) -> str:
        return PromptTemplates.CURRENT_GOAL_MAP.get(
            state,
            PromptTemplates.CURRENT_GOAL_MAP.get('awaiting_job_interest', 'Collect the required intake detail from the candidate')
        )

    def _is_unified_rollout_enabled(self, state: str) -> bool:
        """Check whether unified onboarding is enabled for a specific state."""
        raw = (settings.unified_onboarding_rollout_states or "*").strip()
        if not raw or raw == "*":
            return True

        allowed = {s.strip() for s in raw.split(",") if s.strip()}
        alias_map = {
            "job": self.STATE_AWAITING_JOB,
            "country": self.STATE_AWAITING_COUNTRY,
            "experience": self.STATE_AWAITING_EXPERIENCE,
            "cv": self.STATE_AWAITING_CV,
        }
        expanded = set(allowed)
        for item in list(allowed):
            mapped = alias_map.get(item.lower())
            if mapped:
                expanded.add(mapped)
        return state in expanded

    def _match_country_from_text(self, text: str, active_countries: Optional[list]) -> Optional[str]:
        """Resolve free-text country to an active CRM country value."""
        stripped = (text or "").strip().lower()
        if not stripped:
            return None

        mapped = _COUNTRY_MASTER_MAP.get(stripped)
        candidate_country = mapped or stripped.title()

        countries = [str(c) for c in (active_countries or []) if str(c).strip()]
        if not countries:
            return candidate_country

        exact = {c.lower(): c for c in countries}
        if candidate_country.lower() in exact:
            return exact[candidate_country.lower()]

        close = difflib.get_close_matches(candidate_country, countries, n=1, cutoff=0.72)
        return close[0] if close else None

    def _normalize_free_text_country(self, text: str) -> Optional[str]:
        """Normalize a country-like free-text answer when CRM match is unavailable."""
        stripped = (text or "").strip()
        if len(stripped) < 2:
            return None

        mapped = _COUNTRY_MASTER_MAP.get(stripped.lower())
        if mapped:
            return mapped

        if re.search(r"\d", stripped):
            return None

        cleaned = re.sub(r"\s+", " ", stripped).strip(" .,!?:;-")
        if not cleaned or len(cleaned) > 48:
            return None
        return cleaned.title()

    async def _handle_non_unified_rollout_state(
        self,
        db: Session,
        candidate,
        text: str,
        language: str,
        state: str,
    ) -> Union[str, Dict[str, Any]]:
        """Deterministic fallback path used when a state is excluded from unified rollout."""
        if state == self.STATE_AWAITING_JOB:
            matched = self._match_job_from_text(text)
            if matched:
                job_interest_value = (matched[1].get("title") or text.strip().title())[:200]
                self._save_intake(db, candidate, 'job_interest', job_interest_value)

                _edata = candidate.extracted_data or {}
                _edata["matched_job_id"] = matched[0]
                _edata["job_requirements"] = dict(matched[1].get("requirements", {}))
                _edata.pop("future_pool", None)
                candidate.extracted_data = _edata
                db.commit()

                crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_COUNTRY)
                ack = self._build_job_ack(job_interest_value, language)
                return self._country_buttons_payload(language, body_prefix=ack.strip())

            if self._looks_like_job_title(text):
                job_interest_value = text.strip().title()[:200]
                self._save_intake(db, candidate, 'job_interest', job_interest_value)
                crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_COUNTRY)
                ack = self._build_job_ack(job_interest_value, language)
                return self._country_buttons_payload(language, body_prefix=ack.strip())

            return self._build_job_picker_list_message(language) or PromptTemplates.get_intake_question('job_interest', language)

        if state == self.STATE_AWAITING_COUNTRY:
            active_countries_list = vacancy_service.get_active_countries()
            resolved_country = self._match_country_from_text(text, active_countries_list)
            if resolved_country:
                self._save_intake(db, candidate, 'destination_country', resolved_country)
                crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_EXPERIENCE)
                return self._experience_buttons_payload(language)
            return self._country_buttons_payload(language)

        if state == self.STATE_AWAITING_EXPERIENCE:
            yrs = re.search(r'\d+', text or "")
            if yrs:
                target_data = yrs.group()
                self._save_intake(db, candidate, 'experience_years_stated', str(target_data))

                data = candidate.extracted_data or {}
                job_reqs = data.get("job_requirements", {})
                fields_to_ask = self._get_missing_req_fields(db, candidate, job_reqs)

                if fields_to_ask:
                    crud.update_candidate_state(db, candidate.id, self.STATE_COLLECTING_JOB_REQS)
                    return self._get_next_intake_question(candidate, language)

                crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_CV)
                return PromptTemplates.get_awaiting_cv_message(language, self.company_name)

            return PromptTemplates.get_intake_question('experience_years', language)

        if state == self.STATE_AWAITING_CV:
            return PromptTemplates.get_awaiting_cv_message(language, self.company_name)

        return self._get_next_intake_question(candidate, language)

    def _country_buttons_payload(self, language: str, body_prefix: str = "") -> str:
        country_q = PromptTemplates.get_intake_question('destination_country', language)
        active_countries = vacancy_service.get_active_countries() or []
        country_line = ""
        if active_countries:
            preview = ", ".join(active_countries)
            labels = {
                'en': "Available countries:",
                'si': "පවතින රටවල්:",
                'ta': "கிடைக்கும் நாடுகள்:",
                'singlish': "Available countries:",
                'tanglish': "Available countries:",
            }
            country_line = f"{labels.get(language, labels['en'])} {preview}."

        anywhere_hint = {
            'en': "You can also type 'Anywhere'.",
            'si': "ඔබට 'Anywhere' කියලත් type කරන්න පුළුවන්.",
            'ta': "நீங்கள் 'Anywhere' என்றும் type செய்யலாம்.",
            'singlish': "'Anywhere' kiyala type karannath puluwan.",
            'tanglish': "'Anywhere' nu type pannalaam.",
        }.get(language, "You can also type 'Anywhere'.")

        parts = [p for p in [body_prefix.strip(), country_q, country_line, anywhere_hint] if p]
        return "\n\n".join(parts)

    async def _escalate_to_human_handoff(self, db: Session, candidate, language: str, reason: str) -> str:
        data = candidate.extracted_data or {}
        data['confusion_counter'] = max(3, int(data.get('confusion_counter', 0) or 0))
        data['confusion_streak'] = max(3, int(data.get('confusion_streak', 0) or 0))
        data['is_human_handoff'] = True
        candidate.extracted_data = data
        crud.update_candidate_state(db, candidate.id, self.STATE_HUMAN_HANDOFF)
        candidate.conversation_state = self.STATE_HUMAN_HANDOFF
        if hasattr(candidate, "status"):
            candidate.status = self.STATE_HUMAN_HANDOFF
        db.commit()
        await self._notify_recruitment_escalation(candidate, reason=reason)
        await self._notify_human_handoff(candidate, reason=reason)
        msg = {
            'en': "I’m bringing in a human recruiter so you get the best help quickly. Please wait a moment. 🙏",
            'si': "ඔබට හොඳම සහය ඉක්මනින් ලැබෙන්න මම human recruiter කෙනෙක් add කරනවා. ටිකක් ඉන්න. 🙏",
            'ta': "உங்களுக்கு சிறந்த உதவி விரைவாக கிடைக்க நான் human recruiter-ஐ இணைக்கிறேன். கொஞ்சம் காத்திருக்கவும். 🙏",
            'singlish': "Oyata hodata help karanna human recruiter kenek connect karanawa. Tikak inna. 🙏",
            'tanglish': "Ungalukku best help kudukka human recruiter-ah connect panren. Konjam wait pannunga. 🙏",
        }
        return msg.get(language, msg['en'])

    @staticmethod
    def _clean_job_title(title: str) -> str:
        """Remove trailing test IDs (5+ digit numbers) and smart-truncate to 24 chars."""
        import re as _re
        clean = _re.sub(r'\s+\d{5,}$', '', str(title).strip())
        if len(clean) > 24:
            return clean[:23] + "…"
        return clean

    def _build_presented_jobs_list_payload(
        self,
        language: str,
        presented_jobs: list,
        body_prefix: str = "",
    ) -> Dict[str, Any]:
        rows = []
        for i, job in enumerate((presented_jobs or [])[:3]):
            title = self._clean_job_title(job.get('title') or 'Job')
            # Build rich description: country · salary · exp
            desc_parts = []
            if job.get('country'): desc_parts.append(str(job['country']))
            if job.get('salary') or job.get('salary_range'):
                desc_parts.append(str(job.get('salary') or job.get('salary_range')))
            reqs = job.get('requirements') or {}
            if isinstance(reqs, dict) and reqs.get('experience_years'):
                desc_parts.append(f"{reqs['experience_years']}+ yrs")
            row_desc = (" · ".join(desc_parts) if desc_parts else str(job.get('description') or 'Tap to apply'))[:72]
            rows.append({
                "id": f"job_{i}",
                "title": title,
                "description": row_desc,
            })

        skip_labels = {
            'en':       {"title": "Skip & Complete",    "description": "Just complete my application"},
            'si':       {"title": "Skip කරන්න",          "description": "Application submit කරන්න"},
            'ta':       {"title": "Skip செய்து முடி",     "description": "விண்ணப்பத்தை முடிக்க"},
            'singlish': {"title": "Skip karala finish",  "description": "Application eka submit karanna"},
            'tanglish': {"title": "Skip pannu",          "description": "Application submit pannidu"},
        }
        skip = skip_labels.get(language, skip_labels['en'])
        rows.append({
            "id": "skip",
            "title": skip["title"][:24],
            "description": skip["description"][:72],
        })

        button_label = {
            'en': "View Jobs",
            'si': "රැකියා බලන්න",
            'ta': "வேலைகளைப் பார்",
            'singlish': "Jobs Balanna",
            'tanglish': "Jobs Paarkavum"
        }.get(language, "View Jobs")[:20]

        default_body = {
            'en': "Please select a job from the list below, or choose Skip.",
            'si': "කරුණාකර පහත ලැයිස්තුවෙන් රැකියාවක් තෝරන්න, නැත්නම් Skip තෝරන්න.",
            'ta': "கீழே உள்ள பட்டியலில் இருந்து வேலை ஒன்றைத் தேர்வு செய்யவும், இல்லை என்றால் Skip தேர்வு செய்யவும்.",
            'singlish': "Pahatha list eken job ekak select karanna, nathnam Skip karanna.",
            'tanglish': "Kizha irukka list-la job ah select pannunga, illa na Skip pannunga.",
        }.get(language, "Please select a job from the list below, or choose Skip.")

        body_text = f"{body_prefix}\n\n{default_body}".strip() if body_prefix else default_body
        return {
            "type": "list",
            "body_text": body_text,
            "button_label": button_label,
            "sections": [{"title": "Available Vacancies"[:24], "rows": rows}],
        }

    def _finalize_no_cv_continue(self, db: Session, candidate, language: str) -> str:
        data = candidate.extracted_data or {}
        data['cv_status'] = 'pending'
        candidate.extracted_data = data
        db.commit()
        self._reset_state_question_retry_count(db, candidate, self.STATE_AWAITING_CV)
        crud.update_candidate_state(db, candidate.id, self.STATE_APPLICATION_COMPLETE)
        candidate.conversation_state = self.STATE_APPLICATION_COMPLETE
        self._dispatch_recruitment_sync_background(
            candidate_id=candidate.id,
            reason="cv-auto-skipped",
        )
        done_msgs = {
            'en': "No worries 👍 I submitted your basic profile for now. You can send your CV later anytime as PDF or Word.",
            'si': "ගැටලුවක් නැහැ 👍 ඔබගේ මූලික තොරතුරු යොමු කළා. CV එක පසුව PDF හෝ Word එකක් ලෙස ඕන වෙලාවක යවන්න.",
            'ta': "பரவாயில்லை 👍 உங்கள் அடிப்படை விபரங்கள் சமர்ப்பிக்கப்பட்டது. CV-ஐ பின்னர் எப்போது வேண்டுமானாலும் PDF அல்லது Word ஆக அனுப்பலாம்.",
            'singlish': "Awlak naha 👍 Oyage basic profile eka submit kala. Passe oni welawakadi CV eka PDF/Word ekak widiyata ewanna.",
            'tanglish': "Parava illa 👍 Unga basic profile submit pannitten. Apram eppo venumnaalum CV-ah PDF/Word-a anuppunga.",
        }
        return done_msgs.get(language, done_msgs['en'])

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

    @staticmethod
    def _map_normalized_language(detected_language: Optional[str]) -> Optional[str]:
        mapping = {
            "english": "en",
            "sinhala": "si",
            "tamil": "ta",
            "singlish": "singlish",
            "tanglish": "tanglish",
        }
        key = str(detected_language or "").strip().lower()
        return mapping.get(key)

    def _sanitize_takeover_reply(self, reply: str) -> str:
        """Strip internal-stage leakage and banned slang from onboarding takeover text."""
        text = str(reply or "").strip()
        if not text:
            return ""

        leakage_pattern = re.compile(
            r"(you are currently at|current onboarding goal|current onboarding stage goal|current stage|current state|state_awaiting|awaiting_[a-z_]+)",
            re.IGNORECASE,
        )
        if leakage_pattern.search(text):
            return "Thank you. Please share the required detail so we can continue your application."

        text = re.sub(r"\b(malli|nangi|ayye|machan|machang|apo|haha)\b", "", text, flags=re.IGNORECASE)
        text = re.sub(r"\s{2,}", " ", text).strip(" -:;,\n\t")
        if not text:
            return "Thank you. Please share the required detail so we can continue your application."
        return text

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

    async def _notify_recruitment_escalation(self, candidate, reason: str = "Persistent unclear inputs") -> None:
        base_url = str(getattr(settings, "recruitment_api_url", "") or "").strip().rstrip("/")
        if not base_url:
            return

        phone = getattr(candidate, "phone_number", None) or getattr(candidate, "phone", None)
        if not phone:
            return

        payload = {"phone": phone, "reason": reason or "Persistent unclear inputs"}
        headers = {}
        if getattr(settings, "chatbot_api_key", None):
            headers["x-chatbot-api-key"] = settings.chatbot_api_key

        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                resp = await client.post(
                    f"{base_url}/api/communications/escalate",
                    json=payload,
                    headers=headers,
                )
                resp.raise_for_status()
        except Exception as exc:
            logger.warning(f"Recruitment escalation API call failed: {exc}")

    async def _send_unified_takeover_reply(
        self,
        db: Session,
        candidate,
        text: str,
        language: str,
        state: str,
        phone_number: str,
        active_countries: Optional[list] = None,
        active_jobs: Optional[list] = None,
    ) -> str:
        """Use the unified processor to generate steering text for off-track onboarding turns."""
        if self._is_language_locked(candidate):
            language = self._effective_language(candidate)

        try:
            normalized_data = candidate.extracted_data or {}
            detected_language = language if self._is_language_locked(candidate) else str(normalized_data.get("detected_language") or language)
            unified = await self._process_agentic_state(
                db=db,
                candidate=candidate,
                user_intent=text,
                detected_language=detected_language,
                current_state=state,
                active_countries=active_countries,
                active_jobs=active_jobs,
            )
        except Exception as e:
            logger.warning(f"Unified takeover generation failed for state {state}: {e}")
            unified = {}

        unified = self._normalize_unified_onboarding_response(unified)
        reply = (unified.get("agent_reply") or "").strip()
        if not reply:
            reply = PromptTemplates.get_gibberish_fallback(language)

        reply = self._sanitize_takeover_reply(reply)

        # De-dupe repetitive takeover messages to avoid visible response loops.
        data = candidate.extracted_data or {}
        normalized = re.sub(r"\s+", " ", reply).strip().lower()
        last_normalized = str(data.get("last_takeover_reply_norm") or "").strip().lower()
        if normalized and normalized == last_normalized:
            followup_q = self._get_next_intake_question(candidate, language)
            fallback = PromptTemplates.get_gibberish_fallback(language)
            reply = f"{fallback}\n\n{followup_q}" if followup_q else fallback
            reply = self._sanitize_takeover_reply(reply)
            normalized = re.sub(r"\s+", " ", reply).strip().lower()

        data["last_takeover_reply_norm"] = normalized
        candidate.extracted_data = data
        db.commit()

        if phone_number and reply:
            await meta_client.send_text(phone_number, reply)
            return ""
        return reply

    def _normalize_unified_onboarding_response(self, unified_response: Optional[Dict[str, Any]]) -> Dict[str, Any]:
        """Normalize unified onboarding response to extracted_data/agent_reply while keeping legacy compatibility."""
        data = unified_response or {}
        extracted_data = data.get("extracted_data") if isinstance(data.get("extracted_data"), dict) else {}
        legacy_entities = data.get("entities") if isinstance(data.get("entities"), dict) else {}
        if not extracted_data:
            extracted_data = legacy_entities

        agent_reply = str(data.get("agent_reply") or data.get("steering_reply") or "").strip()

        return {
            "intent": str(data.get("intent") or "other"),
            "extracted_data": extracted_data,
            "entities": legacy_entities or extracted_data,
            "crm": data.get("crm") if isinstance(data.get("crm"), dict) else {},
            "agent_reply": agent_reply,
            "steering_reply": agent_reply,
        }

    @staticmethod
    def _safe_int(value: Any) -> Optional[int]:
        if value in (None, ""):
            return None
        try:
            return int(float(str(value).strip()))
        except Exception:
            return None

    def _coerce_extracted_profile(self, profile: Any) -> Dict[str, Any]:
        base = _default_extracted_profile()
        if not isinstance(profile, dict):
            return base

        job_role = profile.get("job_role")
        target_countries = profile.get("target_countries")
        age = self._safe_int(profile.get("age"))
        licenses = profile.get("licenses")
        experience_years = self._safe_int(profile.get("experience_years"))

        base["job_role"] = str(job_role).strip() if job_role not in (None, "") else None
        if isinstance(target_countries, list):
            base["target_countries"] = [str(c).strip() for c in target_countries if str(c).strip()]
        elif target_countries not in (None, ""):
            base["target_countries"] = [str(target_countries).strip()]

        base["age"] = age

        if isinstance(licenses, list):
            base["licenses"] = [str(l).strip() for l in licenses if str(l).strip()]
        elif licenses not in (None, ""):
            base["licenses"] = [str(licenses).strip()]

        base["experience_years"] = experience_years
        return base

    def _merge_extracted_profile(self, current_profile: Dict[str, Any], updated_profile: Dict[str, Any]) -> Dict[str, Any]:
        merged = self._coerce_extracted_profile(current_profile)
        patch = self._coerce_extracted_profile(updated_profile)

        if patch.get("job_role"):
            merged["job_role"] = patch["job_role"]
        if patch.get("target_countries"):
            merged["target_countries"] = patch["target_countries"]
        if patch.get("age") is not None:
            merged["age"] = patch["age"]
        if patch.get("licenses"):
            merged["licenses"] = patch["licenses"]
        if patch.get("experience_years") is not None:
            merged["experience_years"] = patch["experience_years"]

        return merged

    def _get_candidate_extracted_profile(self, candidate) -> Dict[str, Any]:
        profile = self._coerce_extracted_profile(getattr(candidate, "extracted_profile", None))
        if profile != _default_extracted_profile():
            return profile

        data = candidate.extracted_data or {}
        legacy_profile = self._coerce_extracted_profile(data.get("extracted_profile"))
        if legacy_profile != _default_extracted_profile():
            return legacy_profile

        country = str(data.get("destination_country") or "").strip()
        if data.get("job_interest"):
            profile["job_role"] = str(data.get("job_interest")).strip()
        if country:
            profile["target_countries"] = [country]
        exp = self._safe_int(data.get("experience_years_stated") or data.get("experience_years"))
        if exp is not None:
            profile["experience_years"] = exp
        return profile

    def _safe_json_object(self, raw_content: str) -> Dict[str, Any]:
        content = str(raw_content or "").strip()
        if content.startswith("```json"):
            content = content[7:]
        elif content.startswith("```"):
            content = content[3:]
        if content.endswith("```"):
            content = content[:-3]
        content = content.strip()

        if "{" in content and "}" in content:
            content = content[content.find("{"):content.rfind("}") + 1]

        try:
            data = json.loads(content)
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    async def _process_agentic_state(
        self,
        db: Session,
        candidate,
        user_intent: str,
        detected_language: str,
        current_state: str,
        active_countries: Optional[list] = None,
        active_jobs: Optional[list] = None,
    ) -> Dict[str, Any]:
        fallback = await rag_engine.process_unified_turn(
            user_message=user_intent,
            current_state=current_state,
            language=detected_language or "en",
            active_countries=active_countries,
            active_jobs=active_jobs,
        )

        if not rag_engine.async_openai_client:
            return fallback

        current_profile = self._get_candidate_extracted_profile(candidate)
        prompt = DEWAN_AGENT_PROMPT.format(
            current_profile_state=json.dumps(current_profile, ensure_ascii=False),
            detected_language=detected_language or "en",
            user_intent=user_intent,
        )

        try:
            response = await rag_engine.async_openai_client.chat.completions.create(
                model="gpt-4o",
                response_format={"type": "json_object"},
                messages=[{"role": "system", "content": prompt}],
                temperature=0.3,
            )

            parsed = self._safe_json_object(response.choices[0].message.content or "")
            updated_profile = self._coerce_extracted_profile(parsed.get("updated_profile"))
            merged_profile = self._merge_extracted_profile(current_profile, updated_profile)

            route_to_general_pool = bool(parsed.get("route_to_general_pool"))
            profile_complete = bool(parsed.get("is_profile_complete"))
            reply_message = str(parsed.get("reply_message") or "").strip()

            target_country = None
            target_countries = merged_profile.get("target_countries") or []
            if target_countries:
                target_country = str(target_countries[0]).strip()

            matched_crm_country = None
            if target_country and active_countries:
                countries = [str(c) for c in active_countries if str(c).strip()]
                exact = {c.lower(): c for c in countries}
                matched_crm_country = exact.get(target_country.lower())
                if not matched_crm_country:
                    close = difflib.get_close_matches(target_country, countries, n=1, cutoff=0.72)
                    matched_crm_country = close[0] if close else None

            matched_crm_job = None
            job_role = merged_profile.get("job_role")
            if job_role and active_jobs:
                jobs = [str(j) for j in active_jobs if str(j).strip()]
                exact = {j.lower(): j for j in jobs}
                matched_crm_job = exact.get(job_role.lower())
                if not matched_crm_job:
                    close = difflib.get_close_matches(job_role, jobs, n=1, cutoff=0.68)
                    matched_crm_job = close[0] if close else None

            candidate.extracted_profile = merged_profile
            candidate.is_general_pool = bool(getattr(candidate, "is_general_pool", False) or route_to_general_pool)

            data = candidate.extracted_data or {}
            data["extracted_profile"] = merged_profile
            data["is_general_pool"] = candidate.is_general_pool
            data["is_profile_complete"] = profile_complete
            if candidate.is_general_pool:
                data["future_pool"] = True
                if merged_profile.get("job_role"):
                    data["future_pool_role"] = merged_profile.get("job_role")
            candidate.extracted_data = data
            db.commit()

            expected_field_by_state = {
                self.STATE_AWAITING_JOB: ["matched_crm_job", "job_role"],
                self.STATE_AWAITING_COUNTRY: ["matched_crm_country", "country"],
                self.STATE_AWAITING_EXPERIENCE: ["experience_years"],
            }
            expected_fields = expected_field_by_state.get(current_state, [])

            mapped_extracted = {
                "job_role": merged_profile.get("job_role"),
                "country": target_country,
                "experience_years": merged_profile.get("experience_years"),
                "matched_crm_country": matched_crm_country,
                "matched_crm_job": matched_crm_job,
            }
            has_state_data = any(mapped_extracted.get(field) not in (None, "", []) for field in expected_fields)

            return {
                "intent": "other",
                "extracted_data": mapped_extracted,
                "agent_reply": "" if has_state_data else reply_message,
                "is_profile_complete": profile_complete,
                "route_to_general_pool": candidate.is_general_pool,
            }
        except Exception as exc:
            logger.warning(f"Agentic state processor failed, using unified fallback: {exc}")
            return fallback

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

                if current_state == self.STATE_AWAITING_CV:
                    try:
                        await meta_client.send_text(
                            phone_number,
                            "I received your file. Please give me a few seconds to read it..."
                        )
                    except Exception as ack_err:
                        logger.warning(f"Failed to send awaiting-CV media ack: {ack_err}")

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
                    noisy_audio_msg = voice_service.AUDIO_FALLBACK_MESSAGES.get(
                        language, voice_service.AUDIO_FALLBACK_MESSAGES["en"]
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

            return await self._default_response(db, candidate)

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

        raw_text = (message_text or "").strip()
        interactive_token = _is_structured_interactive_token(raw_text)

        # Interactive button/list reply IDs are machine tokens, not user text.
        # Skip NLP normalization entirely — they must never be flagged as "confusing".
        if interactive_token:
            normalized = {"is_confusing": False, "detected_language": None, "english_translation": raw_text}
        else:
            normalized = await normalize_sri_lankan_input(raw_text)

        if bool(normalized.get("is_confusing", False)):
            current_state = candidate.conversation_state
            language = self._effective_language(candidate)

            # During language pick state, never route to generic confusion text.
            if current_state == self.STATE_AWAITING_LANGUAGE_SELECTION:
                self._log_msg(db, candidate.id, MessageTypeEnum.USER, raw_text, language)
                response = PromptTemplates.get_language_selection()
                self._log_msg(db, candidate.id, MessageTypeEnum.BOT, response, language)
                return response

            confusion_counter = self._increment_confusion_counter(db, candidate)

            self._log_msg(db, candidate.id, MessageTypeEnum.USER, raw_text, language)

            if confusion_counter == 1:
                crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_LANGUAGE_SELECTION)
                candidate.conversation_state = self.STATE_AWAITING_LANGUAGE_SELECTION
                response = self._normalization_confusing_fallback(language)
            elif confusion_counter >= 3:
                response = await self._escalate_to_human_handoff(
                    db,
                    candidate,
                    language,
                    reason="Persistent unclear inputs",
                )
            else:
                response = self._normalization_second_chance_message(language)

            self._log_msg(db, candidate.id, MessageTypeEnum.BOT, response, language)
            return response

        if self._get_confusion_counter(candidate) > 0:
            self._reset_confusion_counter(db, candidate)

        language_locked = self._is_language_locked(candidate)
        normalized_language = self._map_normalized_language(normalized.get("detected_language"))
        if normalized_language and (not language_locked) and (not interactive_token):
            crud.update_candidate_language(db, candidate.id, normalized_language)

        data = candidate.extracted_data or {}
        data["detected_language"] = normalized.get("detected_language")
        candidate.extracted_data = data
        db.commit()

        english_translation = str(normalized.get("english_translation") or "").strip()
        if english_translation:
            message_text = english_translation

        # 1. Explicit language switch
        switch_lang = detect_language_switch_request(message_text)
        if switch_lang:
            crud.update_candidate_language(db, candidate.id, switch_lang)
            self._set_language_lock(db, candidate, True)
            self._remove_rejected_language(db, candidate, switch_lang)
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

        rejected_language = _extract_rejected_language(message_text)
        if rejected_language:
            self._add_rejected_language(db, candidate, rejected_language)
            current_lang = self._effective_language(candidate)
            if current_lang == rejected_language:
                fallback_lang = "en" if rejected_language != "en" else "ta"
                if fallback_lang in self._get_rejected_languages(candidate):
                    fallback_lang = "en"
                crud.update_candidate_language(db, candidate.id, fallback_lang)
                self._set_language_lock(db, candidate, True)
            info = {
                'en': "Understood. I won’t use that language in this chat. Please continue in your preferred language.",
                'si': "හරි. මේ chat එකේ එම භාෂාව මම භාවිතා කරන්නෙ නැහැ. ඔබ කැමති භාෂාවෙන් දිගටම කියන්න.",
                'ta': "புரிந்தது. இந்த chat-ல் அந்த மொழியை நான் பயன்படுத்த மாட்டேன். உங்கள் விருப்ப மொழியில் தொடருங்கள்.",
                'singlish': "Hari, e language eka me chat eke use karanne ne. Oyage prefer language eken continue karanna.",
                'tanglish': "Purinjiduchu, andha language inga use panna maatten. Unga preferred language-la continue pannunga.",
            }
            language = self._effective_language(candidate)
            self._log_msg(db, candidate.id, MessageTypeEnum.USER, message_text, language)
            response = info.get(language, info['en'])
            self._log_msg(db, candidate.id, MessageTypeEnum.BOT, response, language)
            return response

        # 2. Detect language — with sliding-window adaptation
        # Treat structured tokens as interactive even if WhatsApp delivers them as text.
        det_lang, det_conf = detect_language(message_text, phone_number)
        
        # Proactive adaptation: if the language detector has seen 2+ consecutive
        # messages in a different register (e.g. user drifting from en → singlish),
        # silently switch without asking.
        from app.nlp.language_detector import language_detector
        confirmed = language_detector.get_confirmed_language(phone_number)
        stored_lang = self._effective_language(candidate)
        language_locked = self._is_language_locked(candidate)

        rejected_languages = self._get_rejected_languages(candidate)
        if (not interactive_token) and (not language_locked) and confirmed and confirmed != stored_lang and det_conf > 0.85 and confirmed not in rejected_languages:
            # User has been speaking in a different register for 2+ messages
            crud.update_candidate_language(db, candidate.id, confirmed)
            language = confirmed
            # Also persist register in extracted_data for singlish/tanglish
            if confirmed in ("singlish", "tanglish"):
                data = candidate.extracted_data or {}
                data["language_register"] = confirmed
                candidate.extracted_data = data
                db.commit()
        elif (not interactive_token) and (not language_locked) and det_conf > 0.9 and len(message_text.split()) >= 3 and det_lang not in rejected_languages:
            # High-confidence single-message detection (original logic)
            crud.update_candidate_language(db, candidate.id, det_lang)
            language = det_lang
        else:
            language = stored_lang

        if language in rejected_languages:
            language = stored_lang if stored_lang not in rejected_languages else "en"

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
                if (not language_locked) and _fp_lang and _fp_lang != 'en' and _fp_lang != language and _fp_lang not in rejected_languages:
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
        if (not interactive_token) and (not language_locked) and llm_lang in ("tanglish", "singlish", "ta", "si", "en") and llm_lang != language and llm_lang not in rejected_languages:
            llm_conf = float(classified.get("confidence", 0))

            # Promote only when the LLM is very confident
            if llm_conf >= 0.85:
                language = llm_lang
                crud.update_candidate_language(db, candidate.id, llm_lang)
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

        response = await self._apply_loop_guard(
            db=db,
            candidate=candidate,
            raw_user_text=message_text,
            proposed_response=response,
            language=language,
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



        # ── TOP-LEVEL: greetings at ANY state → warm re-welcome ───────────────
        is_greet, greet_lang = is_greeting(text)
        lang = greet_lang or language

        if is_greet and state not in (
            self.STATE_INITIAL,
            self.STATE_APPLICATION_COMPLETE
        ):
            agentic_states = {
                self.STATE_AWAITING_JOB,
                self.STATE_AWAITING_COUNTRY,
                self.STATE_AWAITING_JOB_SELECTION,
                self.STATE_AWAITING_EXPERIENCE,
                self.STATE_COLLECTING_JOB_REQS,
                self.STATE_AWAITING_CV,
                self.STATE_COLLECTING_INFO,
            }
            if state in agentic_states:
                current_goal = self._current_goal_for_state(state)
                return await rag_engine.generate_agentic_response(
                    user_message=text,
                    current_goal=current_goal,
                    language=lang,
                )
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
            allowed_jump_states = (
                self.STATE_INITIAL,
                self.STATE_AWAITING_LANGUAGE_SELECTION,
                self.STATE_AWAITING_JOB,
                self.STATE_AWAITING_COUNTRY,
            )

            # Enforce language gate in early onboarding before showing job options.
            if state in (self.STATE_INITIAL, self.STATE_AWAITING_LANGUAGE_SELECTION):
                crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_LANGUAGE_SELECTION)
                candidate.conversation_state = self.STATE_AWAITING_LANGUAGE_SELECTION
                return PromptTemplates.get_language_selection()

            if state in allowed_jump_states and not self._is_language_locked(candidate):
                crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_LANGUAGE_SELECTION)
                candidate.conversation_state = self.STATE_AWAITING_LANGUAGE_SELECTION
                return PromptTemplates.get_language_selection()

            # Conservative jump: only redirect in early onboarding states.
            if state in allowed_jump_states:
                candidate_ctx = self._candidate_info_dict(candidate)
                vacancies_msg = await self._build_vacancy_list(language, candidate_ctx)
                crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_JOB)
                candidate.conversation_state = self.STATE_AWAITING_JOB
                return self._build_job_picker_list_message(language) or vacancies_msg

            elif state == self.STATE_APPLICATION_COMPLETE:
                candidate_ctx = self._candidate_info_dict(candidate)
                vacancies_msg = await self._build_vacancy_list(language, candidate_ctx)
                suffix = {
                    'en': "\n\n💡 Reply with a role name if you'd like to start a new application!",
                    'si': "\n\n💡 නව ඉල්ලුම්පත්‍රයක් ඉදිරිපත් කිරීමට රැකියා නාමය reply කරන්න!",
                    'ta': "\n\n💡 புதிய விண்ணப்பத்தைத் தொடங்க, பதவி பெயரைப் பதிலளிக்கவும்!",
                    'singlish': "\n\n💡 Aluth application ekak start karanna role name eka reply karanna!",
                    'tanglish': "\n\n💡 Pudhu application start panna role name anuppunga!",
                }.get(language, "\n\n💡 Reply with a role name to apply!")
                return f"{vacancies_msg}{suffix}"

            else:
                # Mid/late-flow: keep the current intake context; do not interrupt with a jump.
                current_q = self._get_next_intake_question(candidate, language)
                prompt_prefix = {
                    'en': "I can show jobs right after this step.",
                    'si': "මෙම පියවරෙන් පසු මට රැකියා පෙන්විය හැක.",
                    'ta': "இந்த படியைத் தொடர்ந்து வேலை வாய்ப்புகளை காட்டலாம்.",
                    'singlish': "Me step eka passe jobs pennanna puluwan.",
                    'tanglish': "Indha step mudinja udane jobs kaataren.",
                }.get(language, "I can show jobs right after this step.")
                return f"{prompt_prefix}\n\n{current_q}"

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
                self._remove_rejected_language(db, candidate, new_lang)
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

            # Deterministic first-touch UX: bypass LLM and always send the
            # branded welcome + language selector for non-ad entries.
            crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_LANGUAGE_SELECTION)
            candidate.conversation_state = self.STATE_AWAITING_LANGUAGE_SELECTION
            welcome_text = "Welcome to Dewan Recruitment! 🏢 We are here to help you build your career."
            return f"{welcome_text}\n\n{PromptTemplates.get_language_selection()}"

        # ── AWAITING LANGUAGE SELECTION ───────────────────────────────────────
        elif state == self.STATE_AWAITING_LANGUAGE_SELECTION:
            text_norm = (text or "").lower().strip()
            new_lang = None

            # Button IDs from send_language_selector: lang_en / lang_si / lang_ta
            if text_norm in ("lang_en", "1", "en", "english", "eng") or "english" in text_norm:
                new_lang = "en"
            elif text_norm in ("lang_si", "2", "si", "sinhala", "sinhalese") or "සිංහල" in text_norm:
                new_lang = "si"
            elif text_norm in ("lang_ta", "3", "ta", "tamil", "tamizh", "thamizh") or "தமிழ்" in text_norm:
                new_lang = "ta"
            elif "singlish" in text_norm or "sinhala english" in text_norm:
                new_lang = "singlish"
            elif "tanglish" in text_norm or "tamil english" in text_norm:
                new_lang = "tanglish"

            if not new_lang:
                retries = self._increment_state_question_retry_count(
                    db,
                    candidate,
                    self.STATE_AWAITING_LANGUAGE_SELECTION,
                )
                if retries >= 2:
                    fallback_lang = "en"
                    crud.update_candidate_language(db, candidate.id, fallback_lang)
                    self._set_language_lock(db, candidate, True)
                    self._remove_rejected_language(db, candidate, fallback_lang)
                    self._reset_state_question_retry_count(
                        db,
                        candidate,
                        self.STATE_AWAITING_LANGUAGE_SELECTION,
                    )
                    language = fallback_lang
                    crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_JOB)
                    candidate.conversation_state = self.STATE_AWAITING_JOB

                    note = "I will continue in English for now."
                    hook = PromptTemplates.get_engagement_hook(language)
                    list_payload = self._build_job_picker_list_message(language)
                    if list_payload:
                        list_payload = dict(list_payload)
                        list_payload["body_text"] = "\n\n".join(
                            [p for p in [note, hook, list_payload.get("body_text", "")] if p]
                        )
                        return list_payload

                    job_q = PromptTemplates.get_intake_question('job_interest', language)
                    return "\n\n".join([p for p in [note, hook, job_q] if p])
                return PromptTemplates.get_language_selection()

            self._reset_state_question_retry_count(db, candidate, self.STATE_AWAITING_LANGUAGE_SELECTION)

            crud.update_candidate_language(db, candidate.id, new_lang)
            self._set_language_lock(db, candidate, True)
            self._remove_rejected_language(db, candidate, new_lang)
            language = new_lang

            crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_JOB)
            candidate.conversation_state = self.STATE_AWAITING_JOB

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
            if not self._is_unified_rollout_enabled(state):
                return await self._handle_non_unified_rollout_state(
                    db=db,
                    candidate=candidate,
                    text=text,
                    language=language,
                    state=state,
                )

            # 1. Attempt Data Extraction
            active_countries_list = vacancy_service.get_active_countries()
            active_jobs_list = vacancy_service.get_active_job_titles()
            normalized_data = candidate.extracted_data or {}
            detected_language = str(normalized_data.get("detected_language") or language)
            unified = await self._process_agentic_state(
                db=db,
                candidate=candidate,
                user_intent=text,
                detected_language=detected_language,
                current_state=candidate.conversation_state,
                active_countries=active_countries_list,
                active_jobs=active_jobs_list,
            )

            unified = self._normalize_unified_onboarding_response(unified)
            extracted_data = unified.get("extracted_data", {})
            agent_reply = (unified.get("agent_reply") or "").strip()

            if agent_reply:
                if phone_number:
                    await meta_client.send_text(phone_number, agent_reply)
                    return ""
                return agent_reply

            target_data = extracted_data.get("matched_crm_job") or extracted_data.get("job_role")
            
            # 2. The Happy Path
            if target_data and len(target_data.strip()) >= 2:
                matched = self._match_job_from_text(target_data)
                job_interest_value = target_data
                if matched:
                    job_interest_value = (matched[1].get("title") or target_data)[:200]

                self._save_intake(db, candidate, 'job_interest', job_interest_value)
                
                _edata = candidate.extracted_data or {}
                if matched:
                    _edata["matched_job_id"] = matched[0]
                    _edata["job_requirements"] = dict(matched[1].get("requirements", {}))
                    _edata.pop("future_pool", None)
                candidate.extracted_data = _edata
                db.commit()

                crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_COUNTRY)

                ack = self._build_job_ack(job_interest_value, language)
                return self._country_buttons_payload(language, body_prefix=ack.strip())

            # 3. Unified conversational recovery (stay in state)
            return await self._send_unified_takeover_reply(
                db=db,
                candidate=candidate,
                text=text,
                language=language,
                state=candidate.conversation_state,
                phone_number=phone_number,
                active_countries=active_countries_list,
                active_jobs=active_jobs_list,
            )

        # ── AWAITING DESTINATION COUNTRY ──────────────────────────────────────
        elif state == self.STATE_AWAITING_COUNTRY:
            if not self._is_unified_rollout_enabled(state):
                return await self._handle_non_unified_rollout_state(
                    db=db,
                    candidate=candidate,
                    text=text,
                    language=language,
                    state=state,
                )

            # 1. Attempt Data Extraction
            active_countries_list = vacancy_service.get_active_countries()
            active_jobs_list = vacancy_service.get_active_job_titles()

            existing_data = candidate.extracted_data or {}
            existing_country = str(existing_data.get("destination_country") or "").strip()
            change_country_intent = bool(re.search(r"\b(change|different|another|instead|not this|switch)\b", (text or "").lower()))

            # If country is already captured for this application, do not re-ask unless
            # the user explicitly asks to change it.
            if existing_country and not change_country_intent:
                crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_EXPERIENCE)
                return self._experience_buttons_payload(language)

            normalized_data = candidate.extracted_data or {}
            detected_language = str(normalized_data.get("detected_language") or language)
            unified = await self._process_agentic_state(
                db=db,
                candidate=candidate,
                user_intent=text,
                detected_language=detected_language,
                current_state=candidate.conversation_state,
                active_countries=active_countries_list,
                active_jobs=active_jobs_list,
            )

            unified = self._normalize_unified_onboarding_response(unified)
            extracted_data = unified.get("extracted_data", {})
            agent_reply = (unified.get("agent_reply") or "").strip()

            if agent_reply:
                if phone_number:
                    await meta_client.send_text(phone_number, agent_reply)
                    return ""
                return agent_reply

            target_data = extracted_data.get("matched_crm_country") or extracted_data.get("country")
            
            # 2. The Happy Path
            if target_data and len(target_data.strip()) >= 2:
                resolved_country = self._match_country_from_text(target_data, active_countries_list)
                country_to_save = resolved_country or self._normalize_free_text_country(target_data)
                if country_to_save:
                    self._save_intake(db, candidate, 'destination_country', country_to_save)
                    crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_EXPERIENCE)
                    return self._experience_buttons_payload(language)

            fallback_country = self._match_country_from_text(text, active_countries_list) or self._normalize_free_text_country(text)
            if fallback_country:
                self._save_intake(db, candidate, 'destination_country', fallback_country)
                crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_EXPERIENCE)
                return self._experience_buttons_payload(language)

            # 3. Unified conversational recovery (stay in state)
            return await self._send_unified_takeover_reply(
                db=db,
                candidate=candidate,
                text=text,
                language=language,
                state=candidate.conversation_state,
                phone_number=phone_number,
                active_countries=active_countries_list,
                active_jobs=active_jobs_list,
            )

        # ── AWAITING JOB SELECTION ───────────────────────────────────────────
        elif state == self.STATE_AWAITING_JOB_SELECTION:
            data = candidate.extracted_data or {}
            presented_cards = list(data.get('presented_job_cards') or [])
            normalized = (text or "").strip().lower()

            # Recover cards if they were lost/stale in state storage.
            if not presented_cards:
                search_job = str(data.get('job_interest') or '').strip()
                search_country = str(data.get('destination_country') or '').strip()
                if search_job:
                    # Pass CV skills + experience for smarter job matching
                    _skills_raw = data.get('skills') or ''
                    _cv_skills = [s.strip() for s in _skills_raw.split(',') if s.strip()] if _skills_raw else []
                    _exp_yrs = data.get('experience_years') or data.get('experience_years_stated')
                    try:
                        _exp_yrs = int(str(_exp_yrs).split('.')[0]) if _exp_yrs else None
                    except (ValueError, TypeError):
                        _exp_yrs = None
                    rebuilt = await vacancy_service.get_matching_jobs(
                        job_interest=search_job,
                        country=search_country,
                        limit=3,
                        candidate_skills=_cv_skills,
                        experience_years=_exp_yrs,
                    )
                    if rebuilt:
                        presented_cards = rebuilt[:3]
                        data['presented_job_cards'] = presented_cards
                        data['presented_jobs'] = [str(j.get('id') or '') for j in presented_cards if str(j.get('id') or '').strip()]
                        candidate.extracted_data = data
                        db.commit()

            selected_index: Optional[int] = None
            should_skip = normalized in ('skip', 'skip_complete', 'skip & complete', 'skip karala finish', 'skip pannu', 'skip කරන්න', 'skip செய்து முடி')

            token_match = re.match(r'^job_(\d+)$', normalized)
            if token_match:
                selected_index = int(token_match.group(1))
            elif normalized in ('1', '2', '3'):
                selected_index = int(normalized) - 1

            if selected_index is not None and 0 <= selected_index < len(presented_cards):
                selected_job = presented_cards[selected_index]
                selected_job_id = str(selected_job.get('id') or '').strip()
                selected_job_title = str(selected_job.get('title') or 'Selected Job').strip()

                data['selected_job_id'] = selected_job_id
                data['selected_job_title'] = selected_job_title
                data['job_interest'] = selected_job_title
                data.pop('future_pool', None)
                candidate.extracted_data = data
                db.commit()

                self._reset_state_question_retry_count(db, candidate, self.STATE_AWAITING_JOB_SELECTION)
            elif should_skip:
                data['future_pool'] = True
                data.pop('selected_job_id', None)
                data['selected_job_title'] = 'Skipped'
                if not data.get('job_interest'):
                    data['job_interest'] = 'Future Pool'
                candidate.extracted_data = data
                db.commit()

                self._reset_state_question_retry_count(db, candidate, self.STATE_AWAITING_JOB_SELECTION)
            else:
                # Keep user in this state and re-show the same list when unclear.
                retries = self._increment_state_question_retry_count(db, candidate, self.STATE_AWAITING_JOB_SELECTION)
                reminder = {
                    'en': "Please choose a job from the list below, or tap Skip.",
                    'si': "කරුණාකර පහත ලැයිස්තුවෙන් රැකියාවක් තෝරන්න, නැත්නම් Skip තෝරන්න.",
                    'ta': "கீழே உள்ள பட்டியலில் இருந்து வேலை தேர்வு செய்யவும், இல்லை என்றால் Skip தேர்வு செய்யவும்.",
                    'singlish': "Pahatha list eken job ekak select karanna, nathnam Skip karanna.",
                    'tanglish': "Kizha irukka list-la job ah select pannunga, illa na Skip pannunga.",
                }.get(language, "Please choose a job from the list below, or tap Skip.")

                if presented_cards:
                    body_prefix = reminder if retries <= 2 else f"{reminder}\n\n{self._get_next_intake_question(candidate, language)}"
                    return self._build_presented_jobs_list_payload(language, presented_cards, body_prefix=body_prefix)

                return f"{reminder}\n\n{self._get_next_intake_question(candidate, language)}"

            missing_queue = list(dict.fromkeys((data.get('missing_critical_fields') or [])))
            if missing_queue:
                crud.update_candidate_state(db, candidate.id, self.STATE_COLLECTING_INFO)
                candidate.conversation_state = self.STATE_COLLECTING_INFO
                data['missing_critical_fields'] = missing_queue
                candidate.extracted_data = data
                db.commit()

                intake_field_alias = {
                    'job_interest': 'job_interest',
                    'destination_country': 'destination_country',
                    'experience_years_stated': 'experience_years',
                }
                next_field = missing_queue[0]
                if next_field in intake_field_alias:
                    response = PromptTemplates.get_intake_question(intake_field_alias[next_field], language)
                else:
                    response = PromptTemplates.get_gap_filling_prompt(next_field)
            else:
                crud.update_candidate_state(db, candidate.id, self.STATE_APPLICATION_COMPLETE)
                candidate.conversation_state = self.STATE_APPLICATION_COMPLETE
                db.commit()
                response = PromptTemplates.get_application_complete_message(
                    language, self.company_name, candidate.name or ""
                )

            try:
                sync_ok = await recruitment_sync.push(candidate, db)
                if not sync_ok:
                    self._dispatch_recruitment_sync_background(
                        candidate_id=candidate.id,
                        reason="job-selection-sync-retry",
                    )
            except Exception as sync_err:
                logger.error(f"Recruitment sync failed after job selection: {sync_err}", exc_info=True)
                self._dispatch_recruitment_sync_background(
                    candidate_id=candidate.id,
                    reason="job-selection-sync-exception",
                )

            return response

        # ── AWAITING EXPERIENCE ───────────────────────────────────────────────
        elif state == self.STATE_AWAITING_EXPERIENCE:
            if not self._is_unified_rollout_enabled(state):
                return await self._handle_non_unified_rollout_state(
                    db=db,
                    candidate=candidate,
                    text=text,
                    language=language,
                    state=state,
                )

            # 1. Attempt Data Extraction
            normalized_data = candidate.extracted_data or {}
            detected_language = str(normalized_data.get("detected_language") or language)
            unified = await self._process_agentic_state(
                db=db,
                candidate=candidate,
                user_intent=text,
                detected_language=detected_language,
                current_state=candidate.conversation_state,
            )

            unified = self._normalize_unified_onboarding_response(unified)
            extracted_data = unified.get("extracted_data", {})
            agent_reply = (unified.get("agent_reply") or "").strip()

            if agent_reply:
                if phone_number:
                    await meta_client.send_text(phone_number, agent_reply)
                    return ""
                return agent_reply

            target_data = extracted_data.get("experience_years")
            
            if not target_data:
                yrs = re.search(r'\d+', text)
                if yrs:
                    target_data = yrs.group()

            # 2. The Happy Path
            if target_data:
                self._save_intake(db, candidate, 'experience_years_stated', str(target_data))
                
                data = candidate.extracted_data or {}
                job_reqs = data.get("job_requirements", {})
                fields_to_ask = self._get_missing_req_fields(db, candidate, job_reqs)
                
                if fields_to_ask:
                    crud.update_candidate_state(db, candidate.id, self.STATE_COLLECTING_JOB_REQS)
                    return self._get_next_intake_question(candidate, language)
                else:
                    crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_CV)
                    return PromptTemplates.get_awaiting_cv_message(language, self.company_name)

            # 3. Unified conversational recovery (stay in state)
            return await self._send_unified_takeover_reply(
                db=db,
                candidate=candidate,
                text=text,
                language=language,
                state=candidate.conversation_state,
                phone_number=phone_number,
            )

        # ── AWAITING CV ───────────────────────────────────────────────────────
        elif state == self.STATE_AWAITING_CV:
            if not self._is_unified_rollout_enabled(state):
                return await self._handle_non_unified_rollout_state(
                    db=db,
                    candidate=candidate,
                    text=text,
                    language=language,
                    state=state,
                )

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

            return await self._send_unified_takeover_reply(
                db=db,
                candidate=candidate,
                text=text,
                language=language,
                state=candidate.conversation_state,
                phone_number=phone_number,
                active_countries=vacancy_service.get_active_countries(),
                active_jobs=vacancy_service.get_active_job_titles(),
            )

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
        language = getattr(candidate.language_preference, 'value', 'en') or 'en'

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
                extraction_failed = True
            else:
                extracted_data = result.extracted_data
                cv_data = None
                extraction_failed = False

            # Merge intake fields into extracted_data for storage
            existing_intake = dict(candidate.extracted_data or {})
            
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

            # Work on a plain dict copy to avoid SQLAlchemy MutableDict parent-state issues.
            merged_data = dict(candidate.extracted_data or {})

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
            if extraction_failed:
                merged_data['extraction_failed'] = True
            else:
                merged_data.pop('extraction_failed', None)
            candidate.extracted_data = merged_data
            db.commit()

            extraction_notice = ""
            if extraction_failed:
                extraction_notice = {
                    'en': "Thanks for sharing your CV. I had trouble reading parts of it, so our recruiter will also review it manually.",
                    'si': "ඔබගේ CV එකට ස්තූතියි. කොටස් කිහිපයක් කියවීමට අපහසු වුණා, ඒ නිසා recruiter කෙනෙක් manual review එකක්ත් කරනවා.",
                    'ta': "உங்கள் CVக்கு நன்றி. சில பகுதிகளை வாசிக்க சிரமமாக இருந்ததால், recruiter ஒருவர் கைமுறையாகவும் சரிபார்ப்பார்.",
                    'singlish': "CV ekata thanks. Eka samahara kotas kiyawanna amarui, e nisa recruiter kenek manual review ekak karanawa.",
                    'tanglish': "CV-ku thanks. Konjam parts read panna kashtam, so recruiter manual-a review pannuvaar.",
                }.get(language, "Thanks for sharing your CV. I had trouble reading parts of it, so our recruiter will also review it manually.")

            extraction_success_notice = {
                'en': "Great news! I extracted your CV details and saved your profile.",
                'si': "හොඳ ආරංචියක්! ඔබගේ CV විස්තර extract කර profile එක save කළා.",
                'ta': "நல்ல செய்தி! உங்கள் CV விவரங்களை எடுத்துப் profile சேமித்துவிட்டேன்.",
                'singlish': "Great news! Oyage CV details extract karala profile eka save kala.",
                'tanglish': "Great news! Unga CV details extract panni profile save panniten.",
            }.get(language, "Great news! I extracted your CV details and saved your profile.") if not extraction_failed else ""

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

            async def _sync_after_cv() -> bool:
                try:
                    sync_ok_inner = await recruitment_sync.push(
                        candidate,
                        db,
                        cv_bytes=file_content,
                        cv_filename=filename,
                    )
                    if sync_ok_inner:
                        logger.info(f"Successfully synced candidate {candidate.phone_number} to CRM")
                        return True

                    logger.warning(
                        f"Immediate CRM sync returned unsuccessful for {candidate.phone_number}; scheduling background retry"
                    )
                    self._dispatch_recruitment_sync_background(
                        candidate_id=candidate.id,
                        cv_bytes=file_content,
                        cv_filename=filename,
                        reason="cv-upload-immediate-sync-retry",
                    )
                    return False
                except Exception as sync_err_inner:
                    logger.error(f"CRM sync error for {candidate.phone_number}: {sync_err_inner}", exc_info=True)
                    self._dispatch_recruitment_sync_background(
                        candidate_id=candidate.id,
                        cv_bytes=file_content,
                        cv_filename=filename,
                        reason="cv-upload-sync-exception",
                    )
                    return False

            # SEMANTIC MATCHING FOR JOBS POST-CV
            cv_title = (extracted_data.current_job_title if extracted_data else cv_data.current_position) or ""
            
            if extracted_data:
                cv_skills = " ".join(extracted_data.technical_skills or [])
            else:
                cv_skills = cv_data.skills or ""
            search_query = f"{cv_title} {cv_skills}".strip() or merged_data.get('job_interest', '')
            
            try:
                if not merged_data.get('selected_job_id') and search_query:
                    matching_jobs = await vacancy_service.get_matching_jobs(
                        job_interest=search_query,
                        country=merged_data.get('destination_country', ''),
                        limit=3,
                    )
                    if matching_jobs:
                        safe_merged = dict(merged_data or {})
                        safe_merged['presented_jobs'] = [str(j.get('id') or '') for j in matching_jobs[:3] if str(j.get('id') or '').strip()]
                        safe_merged['presented_job_cards'] = matching_jobs[:3]
                        candidate.extracted_data = safe_merged
                        db.commit()

                        crud.update_candidate_state(db, candidate.id, self.STATE_AWAITING_JOB_SELECTION)

                        sync_ok_for_list = await _sync_after_cv()

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

                        sync_note = {
                            'en': "✅ Your CV has been submitted to our recruitment system.",
                            'si': "✅ ඔබගේ CV එක recruitment system එකට යොමු කළා.",
                            'ta': "✅ உங்கள் CV recruitment system-க்கு அனுப்பப்பட்டுள்ளது.",
                            'singlish': "✅ Oyage CV eka recruitment system ekata submit kala.",
                            'tanglish': "✅ Unga CV recruitment system-ku submit panniten.",
                        }.get(language, "✅ Your CV has been submitted to our recruitment system.") if sync_ok_for_list else {
                            'en': "✅ Your CV is saved. We are finalizing submission in the background.",
                            'si': "✅ ඔබගේ CV එක save කරලා. background එකෙන් submission complete කරනවා.",
                            'ta': "✅ உங்கள் CV சேமிக்கப்பட்டது. background-ல் submission முடிக்கிறோம்.",
                            'singlish': "✅ Oyage CV eka save kala. background eken submission complete karanawa.",
                            'tanglish': "✅ Unga CV save pannitom. background-la submission complete pannrom.",
                        }.get(language, "✅ Your CV is saved. We are finalizing submission in the background.")

                        body_text = f"{recap}{summary}\n\n{list_intro}\n\n{sync_note}"
                        if extraction_notice:
                            body_text = f"{body_text}\n\n{extraction_notice}"
                        elif extraction_success_notice:
                            body_text = f"{body_text}\n\n{extraction_success_notice}"

                        return {
                            "type": "list",
                            "body_text": body_text,
                            "button_label": btn_label,
                            "sections": [{"title": "Recommended Jobs"[:24], "rows": rows}]
                        }
            except Exception as match_err:
                logger.error(f"Post-CV job matching failed, continuing with fallback flow: {match_err}", exc_info=True)

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
                if extraction_notice:
                    response = f"{response}\n\n{extraction_notice}"
            else:
                crud.update_candidate_state(db, candidate.id, self.STATE_APPLICATION_COMPLETE)
                candidate.conversation_state = self.STATE_APPLICATION_COMPLETE
                complete_msg = PromptTemplates.get_application_complete_message(
                    language, self.company_name, candidate.name or ""
                )
                response = f"{recap}{summary}\n\n{complete_msg}"
                if extraction_notice:
                    response = f"{response}\n\n{extraction_notice}"

            sync_ok = await _sync_after_cv()

            sync_note = {
                'en': "✅ Your CV has been submitted to our recruitment system.",
                'si': "✅ ඔබගේ CV එක recruitment system එකට යොමු කළා.",
                'ta': "✅ உங்கள் CV recruitment system-க்கு அனுப்பப்பட்டுள்ளது.",
                'singlish': "✅ Oyage CV eka recruitment system ekata submit kala.",
                'tanglish': "✅ Unga CV recruitment system-ku submit panniten.",
            }.get(language, "✅ Your CV has been submitted to our recruitment system.") if sync_ok else {
                'en': "✅ Your CV is saved. We are finalizing submission in the background.",
                'si': "✅ ඔබගේ CV එක save කරලා. background එකෙන් submission complete කරනවා.",
                'ta': "✅ உங்கள் CV சேமிக்கப்பட்டது. background-ல் submission முடிக்கிறோம்.",
                'singlish': "✅ Oyage CV eka save kala. background eken submission complete karanawa.",
                'tanglish': "✅ Unga CV save pannitom. background-la submission complete pannrom.",
            }.get(language, "✅ Your CV is saved. We are finalizing submission in the background.")

            response = f"{response}\n\n{sync_note}"
            if extraction_notice:
                pass
            elif extraction_success_notice:
                response = f"{response}\n\n{extraction_success_notice}"

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
        elif state == self.STATE_AWAITING_JOB_SELECTION:
            return hi + self._get_next_intake_question(candidate, language)
        elif state == self.STATE_AWAITING_EXPERIENCE:
            return hi + PromptTemplates.get_intake_question('experience_years', language)
        elif state == self.STATE_COLLECTING_JOB_REQS:
            return hi + self._get_next_intake_question(candidate, language)
        elif state == self.STATE_AWAITING_CV:
            return hi + PromptTemplates.get_awaiting_cv_message(language, self.company_name)
        elif state == self.STATE_COLLECTING_INFO:
            return hi + self._get_next_intake_question(candidate, language)
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
        if len(text.strip()) < 4:
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

        unified = await rag_engine.process_unified_turn(
            user_message=text,
            current_state=candidate.conversation_state,
            language=language,
        )
        unified = self._normalize_unified_onboarding_response(unified)
        agent_reply = (unified.get("agent_reply") or "").strip()
        if agent_reply:
            return agent_reply
        return PromptTemplates.get_gibberish_fallback(language)

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

    def _get_rejected_languages(self, candidate) -> set:
        data = candidate.extracted_data or {}
        values = data.get("rejected_languages") or []
        if not isinstance(values, list):
            return set()
        return {str(v).strip().lower() for v in values if str(v).strip()}

    def _add_rejected_language(self, db: Session, candidate, language_code: str) -> None:
        code = (language_code or "").strip().lower()
        if not code:
            return
        data = candidate.extracted_data or {}
        rejected = data.get("rejected_languages") or []
        if not isinstance(rejected, list):
            rejected = []
        if code not in [str(v).strip().lower() for v in rejected]:
            rejected.append(code)
            data["rejected_languages"] = rejected
            candidate.extracted_data = data
            db.commit()

    def _remove_rejected_language(self, db: Session, candidate, language_code: str) -> None:
        code = (language_code or "").strip().lower()
        if not code:
            return
        data = candidate.extracted_data or {}
        rejected = data.get("rejected_languages") or []
        if not isinstance(rejected, list):
            return
        updated = [v for v in rejected if str(v).strip().lower() != code]
        if len(updated) != len(rejected):
            data["rejected_languages"] = updated
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

    async def _default_response(self, db, candidate) -> str:
        """Response when payload has no text/media."""
        return await rag_engine.execute_silent_takeover(
            user_message="(no content)",
            current_state=candidate.conversation_state,
        )

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
        return await rag_engine.execute_silent_takeover(
            user_message=text,
            current_state=candidate.conversation_state,
        )

    async def handle_with_llm_router(
        self,
        db: Session,
        user_phone: str,
        raw_text: str,
        candidate: "Candidate"
    ) -> str:
        """
        Handle message using the new LLM Router (Elite Implementation).
        This is the GatewayMethod that decides:
        1. Chat response → send text back
        2. Tool call → execute WhatsApp UI action + save to DB
        
        The router is responsible for all the "brain" logic.
        This method is just the pipeline executor.
        """
        
        try:
            # Build session state from candidate record
            session_state = {
                "language": candidate.language_preference or "Unknown",
                "candidate_id": candidate.id,
                "current_flow": candidate.conversation_state,
                "extracted_data": candidate.extracted_profile or {}
            }
            
            # Ask the LLM router what to do
            logger.info(f"🧠 Routing message from {user_phone}: {raw_text[:50]}")
            decision = await route_user_message(raw_text, session_state)
            
            # Execute the router's decision
            if decision["action"] == "chat":
                # Just send a normal text response
                message = decision.get("message", "")
                logger.info(f"💬 Chat response: {message[:50]}")
                await meta_client.send_text(user_phone, message)
                
                # Log the interaction
                crud.create_conversation(
                    db,
                    ConversationCreate(
                        candidate_id=candidate.id,
                        user_message=raw_text,
                        bot_message=message,
                        message_type=MessageTypeEnum.BOT
                    )
                )
                return message
            
            elif decision["action"] == "tool_call":
                tool_name = decision.get("tool_name")
                args = decision.get("arguments", {})
                
                logger.info(f"🔧 Tool call: {tool_name} with args: {args}")
                
                if tool_name == "show_language_selector":
                    # Send 3 language buttons (English, Sinhala, Tamil)
                    greeting = args.get("greeting", "Please select your language:")
                    await meta_client.send_language_selector(user_phone, greeting)
                    candidate.conversation_state = self.STATE_AWAITING_LANGUAGE_SELECTION
                    db.commit()
                    return "Language selector displayed"
                
                elif tool_name == "show_main_menu":
                    # Send main menu as interactive list
                    payload = self._build_main_menu_payload(
                        candidate.language_preference or "en"
                    )
                    if payload:
                        await meta_client.send_interactive_list(user_phone, payload)
                    candidate.conversation_state = self.STATE_AWAITING_JOB
                    db.commit()
                    return "Main menu displayed"
                
                elif tool_name == "show_vacancies_list":
                    # Fetch top 5 jobs and send as WhatsApp list
                    jobs_list = self._get_top_vacancies_for_list(limit=5)
                    if jobs_list:
                        payload = self._build_vacancies_payload(
                            jobs_list,
                            candidate.language_preference or "en"
                        )
                        if payload:
                            await meta_client.send_interactive_list(user_phone, payload)
                            candidate.conversation_state = "viewing_vacancies"
                            db.commit()
                            return f"Showing {len(jobs_list)} vacancies"
                    else:
                        await meta_client.send_text(
                            user_phone,
                            "No vacancies available at this moment. Please check back soon!"
                        )
                        return "No vacancies available"
                
                elif tool_name == "submit_candidate_profile":
                    # The AI has gathered all required data! Save to CRM
                    name = args.get("name", "")
                    job_role = args.get("job_role", "")
                    preferred_country = args.get("preferred_country", "")
                    
                    logger.info(
                        f"✅ AI collected: name={name}, role={job_role}, country={preferred_country}"
                    )
                    
                    # Update candidate in database
                    candidate.name = name
                    candidate.extracted_profile = {
                        "job_role": job_role,
                        "target_countries": [preferred_country],
                    }
                    candidate.conversation_state = self.STATE_APPLICATION_COMPLETE
                    db.commit()
                    
                    # Send success message
                    success_msg = (
                        f"✅ Thank you {name.split()[0] if name else 'there'}! "
                        f"Your profile for **{job_role}** in **{preferred_country}** "
                        f"has been successfully saved. We will contact you soon! 🎉"
                    )
                    await meta_client.send_text(user_phone, success_msg)
                    
                    # Log the submission
                    crud.create_conversation(
                        db,
                        ConversationCreate(
                            candidate_id=candidate.id,
                            user_message=f"[AUTO] Submitted: {job_role} in {preferred_country}",
                            bot_message=success_msg,
                            message_type=MessageTypeEnum.BOT
                        )
                    )
                    
                    return success_msg
            
            else:
                # Unknown action type
                logger.warning(f"Unknown router action: {decision.get('action')}")
                fallback = "I'm having a moment of confusion. Could you repeat that?"
                await meta_client.send_text(user_phone, fallback)
                return fallback
        
        except Exception as e:
            logger.error(f"LLM Router error: {str(e)}", exc_info=True)
            fallback = "I'm experiencing a technical issue. Please try again in a moment."
            await meta_client.send_text(user_phone, fallback)
            return fallback

    def _build_main_menu_payload(self, language: str) -> Optional[Dict[str, Any]]:
        """Build the main menu interactive list payload."""
        menus = {
            "en": {
                "body": "What would you like to do?",
                "items": [
                    {"id": "action_apply", "title": "Apply for a Job"},
                    {"id": "action_vacancies", "title": "View Vacancies"},
                    {"id": "action_question", "title": "Ask a Question"}
                ]
            },
            "si": {
                "body": "ඔබ කුමක්ද කිරීමට කැමතිද?",
                "items": [
                    {"id": "action_apply", "title": "වැඩ සඳහා අයදුම් කරන්න"},
                    {"id": "action_vacancies", "title": "විවෘත ස්ථාන බලන්න"},
                    {"id": "action_question", "title": "ප්‍රශ්න කරන්න"}
                ]
            },
            "ta": {
                "body": "நீங்கள் என்ன செய்ய விரும்புகிறீர்கள்?",
                "items": [
                    {"id": "action_apply", "title": "வேலைக்கு விண்ணப்பிக்கவும்"},
                    {"id": "action_vacancies", "title": "காலிப்பொருளைக் பார்க்கவும்"},
                    {"id": "action_question", "title": "கேள்வி கேளுங்கள்"}
                ]
            }
        }
        
        menu_data = menus.get(language, menus["en"])
        return {
            "body": menu_data["body"],
            "items": menu_data["items"]
        }

    def _get_top_vacancies_for_list(self, limit: int = 5) -> List[Dict[str, Any]]:
        """Get top N vacancies formatted for WhatsApp list."""
        try:
            # Simple implementation — fetch active job titles
            # You may want to expand this to fetch actual job postings from DB
            active_jobs = vacancy_service.get_active_job_titles() or []
            return active_jobs[:limit]
        except Exception as e:
            logger.error(f"Error fetching vacancies: {str(e)}")
            return []

    def _build_vacancies_payload(
        self,
        jobs_list: List[Dict[str, Any]],
        language: str
    ) -> Optional[Dict[str, Any]]:
        """Build vacancies list interactive payload."""
        if not jobs_list:
            return None
        
        items = []
        for i, job in enumerate(jobs_list[:10], 1):  # WhatsApp list has limits
            job_title = job.get("title", job) if isinstance(job, dict) else str(job)
            items.append({
                "id": f"job_{i}",
                "title": job_title[:24],  # WhatsApp title character limit
                "description": "Click to learn more" 
            })
        
        title_map = {
            "en": "Available Positions",
            "si": "විවෘත ස්ථාන",
            "ta": "கிடைக்கும் பல்வேறு பொறுப்புகள்"
        }
        
        return {
            "body": title_map.get(language, "Available Positions"),
            "items": items
        }


# Singleton
chatbot = ChatbotEngine()
