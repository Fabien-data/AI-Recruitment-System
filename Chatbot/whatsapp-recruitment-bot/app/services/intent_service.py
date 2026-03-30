"""Intent classification service for multilingual recruitment intake."""

from __future__ import annotations

import json
import logging
import re
from typing import Optional

from pydantic import BaseModel, Field

from app.config import settings

logger = logging.getLogger(__name__)


class MessageAnalysis(BaseModel):
    """Structured message analysis output."""

    language: str = Field(default="en")
    intent: str = Field(default="ask_question")
    job_role: Optional[str] = Field(default=None)
    country: Optional[str] = Field(default=None)
    experience: Optional[str] = Field(default=None)
    is_gibberish: bool = Field(default=False)
    confidence: float = Field(default=0.5)


_INTENT_HINTS = {
    "apply_job": ["apply", "job", "work", "vacancy", " රැක", "வேலை", "job ekak", "velai"],
    "view_jobs": ["vacancy", "openings", "jobs", "list", "show jobs", "රැකියා", "வேலை வாய்ப்பு"],
    "ask_question": ["?", "how", "what", "why", "salary", "visa", "process", "mokak", "enna"],
    "greeting": ["hi", "hello", "hey", "ayubowan", "vanakkam", "hii", "yo"],
}

_ROLE_HINTS = [
    "driver", "security", "housemaid", "helper", "cook", "welder", "electrician",
    "cleaner", "nurse", "caregiver", "factory", "construction",
]

_COUNTRIES = {
    "uae": "United Arab Emirates",
    "qatar": "Qatar",
    "saudi": "Saudi Arabia",
    "kuwait": "Kuwait",
    "oman": "Oman",
    "malaysia": "Malaysia",
    "korea": "South Korea",
}

_GIBBERISH_RE = re.compile(r"^[^A-Za-z0-9\u0B80-\u0DFF]{4,}$")


async def classify_message(user_message: str) -> MessageAnalysis:
    """
    Classify user message with GPT model and deterministic fallback.

    This function is intentionally resilient: if the model call fails,
    it falls back to low-cost regex/keyword heuristics.
    """
    text = (user_message or "").strip()
    if not text:
        return MessageAnalysis(intent="gibberish", is_gibberish=True, confidence=0.95)

    # Fast local fallback for obvious gibberish to save model tokens.
    if len(text) <= 2 or _GIBBERISH_RE.match(text):
        return MessageAnalysis(intent="gibberish", is_gibberish=True, confidence=0.9)

    if not settings.enable_ai_classifier:
        return _heuristic_classification(text)

    try:
        from openai import AsyncOpenAI

        client = AsyncOpenAI(api_key=settings.openai_api_key)
        response = await client.chat.completions.create(
            model=settings.classifier_model,
            temperature=0,
            response_format={"type": "json_object"},
            messages=[
                {
                    "role": "system",
                    "content": (
                        "Classify Sri Lankan recruitment chat messages. "
                        "Return strict JSON with keys: language, intent, job_role, country, "
                        "experience, is_gibberish, confidence. "
                        "Allowed intents: apply_job, view_jobs, ask_question, upload_cv, greeting, gibberish."
                    ),
                },
                {"role": "user", "content": text},
            ],
            max_completion_tokens=180,
        )
        raw = response.choices[0].message.content or "{}"
        parsed = json.loads(raw)
        result = MessageAnalysis.model_validate(parsed)
        result.confidence = max(0.0, min(1.0, float(result.confidence)))
        return result
    except Exception as exc:
        logger.warning("AI classifier failed; using heuristic fallback: %s", exc)
        return _heuristic_classification(text)


def _heuristic_classification(text: str) -> MessageAnalysis:
    text_l = text.lower()

    if _looks_like_gibberish(text_l):
        return MessageAnalysis(intent="gibberish", is_gibberish=True, confidence=0.8)

    role = _extract_job_role(text_l)
    country = _extract_country(text_l)
    experience = _extract_experience(text_l)

    for intent, hints in _INTENT_HINTS.items():
        if any(h in text_l for h in hints):
            return MessageAnalysis(
                intent=intent,
                confidence=0.55,
                job_role=role,
                country=country,
                experience=experience,
            )

    return MessageAnalysis(
        intent="ask_question",
        confidence=0.45,
        job_role=role,
        country=country,
        experience=experience,
    )


def _looks_like_gibberish(text: str) -> bool:
    if len(text) < 3:
        return True
    if _GIBBERISH_RE.match(text):
        return True
    alpha = sum(1 for c in text if c.isalpha())
    return alpha == 0


def _extract_job_role(text: str) -> Optional[str]:
    for role in _ROLE_HINTS:
        if role in text:
            return role.title()
    return None


def _extract_country(text: str) -> Optional[str]:
    for key, value in _COUNTRIES.items():
        if key in text:
            return value
    return None


def _extract_experience(text: str) -> Optional[str]:
    match = re.search(r"(\d+)\s*(year|years|yr|yrs)", text)
    if match:
        return match.group(1)
    return None
