"""AI supervisor state and lightweight sync validator."""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field

from app.config import settings

logger = logging.getLogger(__name__)


class AIConversationState(BaseModel):
    """Structured output the AI supervisor returns for every text message."""

    extracted_name: Optional[str] = Field(default=None, description="Candidate full name")
    experience_years: Optional[int] = Field(default=None, description="Experience years as integer")
    job_interest: Optional[str] = Field(default=None, description="Job/field user is interested in")
    intent: str = Field(default="INQUIRY", description="GREETING, APPLYING, INQUIRY, or FRUSTRATED")
    intervention_needed: bool = Field(default=False, description="True if human intervention is needed")
    reply_message: str = Field(default="Thank you. I can help with jobs and applications.", description="Reply to user")


SYSTEM_PROMPT = """
You are an Elite Sri Lankan Recruitment Agent for 'NODE.io Solutions'.
RULES:
1. Speak naturally. If user uses Singlish/Tanglish, reply in a helpful matching mix.
2. DO NOT enforce a single language. Be fluid.
3. If user is talking about CV, job, or applying, intent is APPLYING.
4. If user repeatedly asks same thing, is angry, or asks for human, set intervention_needed=true.
5. Extract name, experience_years, and job_interest whenever possible.
6. Return valid JSON only.
""".strip()


@dataclass
class ValidationResult:
    is_valid: bool
    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)

    def __bool__(self) -> bool:
        return self.is_valid


_PHONE_RE = re.compile(r"^\+?[0-9]{7,15}$")


def validate_candidate(
    phone: Optional[str],
    name: Optional[str],
    email: Optional[str],
    job_interest: Optional[str],
    preferred_language: Optional[str],
    experience_years: Optional[Any],
    extracted_data: Optional[Dict] = None,
) -> ValidationResult:
    """Minimal safety validation before sync; non-blocking for language/register differences."""
    errors: List[str] = []
    warnings: List[str] = []

    if not phone or not isinstance(phone, str) or not _PHONE_RE.match(phone.replace(" ", "").replace("-", "")):
        errors.append("phone is required and must be E.164-like")

    if not name or len(str(name).strip()) < 2:
        warnings.append("name is missing or short")

    if not job_interest or len(str(job_interest).strip()) < 2:
        warnings.append("job_interest missing; using general pool")

    if experience_years is not None:
        try:
            exp = int(experience_years)
            if exp < 0 or exp > 60:
                warnings.append("experience_years outside expected range")
        except Exception:
            warnings.append("experience_years not parseable as integer")

    return ValidationResult(is_valid=(len(errors) == 0), errors=errors, warnings=warnings)


async def run_ai_supervisor(
    *,
    user_text: str,
    history: Optional[List[Dict[str, str]]] = None,
    force_applying: bool = False,
) -> AIConversationState:
    """Single-pass AI supervisor for intent, extraction, intervention, and reply."""
    text = (user_text or "").strip()
    if not text:
        return AIConversationState(intent="INQUIRY", reply_message="Please send your message and I will help.")

    if not settings.openai_api_key:
        return _fallback_supervisor(text, force_applying)

    try:
        from openai import AsyncOpenAI

        client = AsyncOpenAI(api_key=settings.openai_api_key)
        messages: List[Dict[str, str]] = [{"role": "system", "content": SYSTEM_PROMPT}]
        for item in (history or [])[-10:]:
            role = item.get("role") if item.get("role") in {"assistant", "user"} else "user"
            content = str(item.get("content") or "").strip()
            if content:
                messages.append({"role": role, "content": content})

        content = text if not force_applying else f"{text}\n\n[Context: user is currently applying.]"
        messages.append({"role": "user", "content": content})

        response = await client.chat.completions.create(
            model=settings.classifier_model or settings.llm_primary_model,
            temperature=0.2,
            response_format={"type": "json_object"},
            messages=messages,
            max_completion_tokens=320,
        )

        raw = response.choices[0].message.content or "{}"
        parsed = AIConversationState.model_validate(json.loads(raw))
        return parsed
    except Exception as exc:
        logger.warning("AI supervisor fallback triggered: %s", exc)
        return _fallback_supervisor(text, force_applying)


def _fallback_supervisor(text: str, force_applying: bool) -> AIConversationState:
    lower = text.lower()
    frustrated = any(k in lower for k in ["human", "agent", "angry", "frustrated", "annoyed", "help me", "operator"])
    intent = "APPLYING" if force_applying or any(k in lower for k in ["apply", "job", "cv", "resume", "velai", "රැකියා"]) else "INQUIRY"

    name = None
    m_name = re.search(r"\b(i am|i'm|my name is)\s+([a-zA-Z][a-zA-Z\s]{1,40})", text, flags=re.IGNORECASE)
    if m_name:
        name = m_name.group(2).strip().title()

    exp = None
    m_exp = re.search(r"\b(\d{1,2})\b", text)
    if m_exp:
        exp = int(m_exp.group(1))

    reply = "Thanks. I can help you apply for jobs. Please share your name, experience, and preferred job."
    if frustrated:
        reply = "I understand. A human agent will assist you shortly."

    return AIConversationState(
        extracted_name=name,
        experience_years=exp,
        job_interest="General" if intent == "APPLYING" else None,
        intent="FRUSTRATED" if frustrated else intent,
        intervention_needed=frustrated,
        reply_message=reply,
    )
