"""
Universal Intent Classifier
============================
Uses GPT-4o-mini to understand ANY message from Sri Lankan users —
Sinhala, Tamil, Singlish, Tanglish, slang, voice transcriptions, gibberish.

Returns structured intent data so the state machine can always make a
decision rather than failing or repeating itself.

Budget: GPT-4o-mini at ~$0.00015/1K tokens ≈ $0.00005 per classification.
"""

import json
import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# ── What each state needs from the user ──────────────────────────────────────
_STATE_CONTEXT: Dict[str, str] = {
    "initial":                    "any message to start the conversation",
    "awaiting_language_selection":"language choice (English/Sinhala/Tamil)",
    "awaiting_job_interest":      "the type of job they want (security guard, driver, nurse, cook, welder, etc.)",
    "awaiting_destination_country":"the country they want to work in (UAE, Saudi, Kuwait, Qatar, Oman, Malaysia, etc.)",
    "awaiting_job_selection":     "which job from the list they want to apply for, or 'skip'",
    "awaiting_experience":        "how many years of work experience they have (number)",
    "collecting_job_requirements":"more details about their job preferences",
    "awaiting_cv":                "their CV/resume document (PDF or Word file)",
    "processing_cv":              "waiting while CV is processed",
    "collecting_info":            "personal information (name, age, address, email, etc.)",
    "answering_questions":        "any question they have about jobs, salary, visa, or the agency",
    "application_complete":       "any follow-up message after application is submitted",
    "human_handoff":              "they need a human agent",
}

_SYSTEM_PROMPT = """You are an AI classifier for a Sri Lankan recruitment agency WhatsApp chatbot.
Users may write in: English, Sinhala (Unicode script), Tamil (Unicode script),
Singlish (Romanized Sinhala + English), Tanglish (Romanized Tamil + English),
or any mix. They may use slang, typos, abbreviations, or very short replies.
Common English words like "job", "CV", "salary", "agency", "visa", "interview",
"passport", "medical", "Dubai", "UAE" appear as-is even in Sinhala/Tamil messages.

Current chatbot state: {state}
We need from the user: {state_context}
User's detected language: {language}
Last 3 bot messages (most recent last):
{history}

User's message: "{message}"

Classify this message and return ONLY a JSON object with these exact fields:
{{
  "intent": "<one of: answer, question, greeting, confusion, irrelevant, profanity, help, skip>",
  "extracted_value": "<the useful answer if intent is 'answer', else null>",
  "english_translation": "<English translation of the message>",
  "confidence": <0.0 to 1.0>,
  "should_escalate": <true if user is very frustrated or needs human help, else false>,
  "graceful_response_hint": "<suggested short phrase to acknowledge and re-ask, in user's language>"
}}

Intent meanings:
- answer: user is answering the current question (even if poorly written or in another language)
- question: user is asking something about jobs, salary, visa, agency
- greeting: hello/hi/start type message
- confusion: user seems lost or confused about what to do
- irrelevant: completely unrelated message (wrong number, testing, etc.)
- profanity: rude or offensive language
- help: user explicitly wants help or to restart
- skip: user wants to skip current step

Be generous in classifying as "answer" — if there's ANY chance the message answers what we need, classify it as answer."""


async def classify_intent(
    message: str,
    language: str,
    current_state: str,
    conversation_history: List[str],
    candidate_data: Optional[Dict[str, Any]] = None,
    openai_client=None,
) -> Dict[str, Any]:
    """
    Classify the intent of any user message using GPT-4o-mini.

    Args:
        message: The raw user message (any language/script)
        language: Detected language code (en/si/ta/singlish/tanglish)
        current_state: Current conversation state string
        conversation_history: Last 3 bot messages (strings)
        candidate_data: Optional dict of what we already know about the candidate
        openai_client: Optional AsyncOpenAI client (will try to import if None)

    Returns:
        Dict with keys: intent, extracted_value, english_translation,
                        confidence, should_escalate, graceful_response_hint
    """
    _FALLBACK = {
        "intent": "answer",
        "extracted_value": message,
        "english_translation": message,
        "confidence": 0.4,
        "should_escalate": False,
        "graceful_response_hint": "",
    }

    if not message or not message.strip():
        return {**_FALLBACK, "intent": "irrelevant", "confidence": 0.9}

    # Get OpenAI client
    client = openai_client
    if client is None:
        try:
            from openai import AsyncOpenAI
            from app.config import settings
            if settings.openai_api_key:
                client = AsyncOpenAI(api_key=settings.openai_api_key)
        except Exception as e:
            logger.warning(f"UniversalClassifier: cannot init OpenAI client: {e}")
            return _FALLBACK

    state_context = _STATE_CONTEXT.get(current_state, "their response")
    history_str = "\n".join(f"  Bot: {m}" for m in (conversation_history or [])[-3:]) or "  (no history)"

    prompt = _SYSTEM_PROMPT.format(
        state=current_state,
        state_context=state_context,
        language=language,
        history=history_str,
        message=message,
    )

    try:
        response = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
            max_tokens=200,
            temperature=0.1,
            response_format={"type": "json_object"},
        )
        raw = response.choices[0].message.content or "{}"
        result = json.loads(raw)

        # Validate required keys
        required = {"intent", "extracted_value", "english_translation", "confidence", "should_escalate"}
        if not required.issubset(result.keys()):
            logger.warning(f"UniversalClassifier: incomplete response: {result}")
            return _FALLBACK

        # Clamp confidence
        result["confidence"] = max(0.0, min(1.0, float(result.get("confidence", 0.5))))
        result.setdefault("graceful_response_hint", "")

        logger.debug(
            f"UniversalClassifier: state={current_state} lang={language} "
            f"intent={result['intent']} confidence={result['confidence']:.2f} "
            f"msg={message[:50]!r}"
        )
        return result

    except json.JSONDecodeError as e:
        logger.warning(f"UniversalClassifier: JSON parse error: {e}")
        return _FALLBACK
    except Exception as e:
        logger.warning(f"UniversalClassifier: API error: {e}")
        return _FALLBACK


def is_confusion(classification: Dict[str, Any], consecutive_irrelevant: int = 0) -> bool:
    """Return True if the chatbot should invoke the supervisor AI."""
    intent = classification.get("intent", "answer")
    confidence = classification.get("confidence", 1.0)
    should_escalate = classification.get("should_escalate", False)

    if should_escalate:
        return True
    if intent == "confusion":
        return True
    if intent == "irrelevant" and consecutive_irrelevant >= 2:
        return True
    if intent == "answer" and confidence < 0.25:
        return True
    return False


def needs_escalation(classification: Dict[str, Any]) -> bool:
    """Return True if this message should be routed to a human agent."""
    return bool(classification.get("should_escalate", False))
