from __future__ import annotations

import logging
import os
from typing import Any, Dict, List, Optional

from openai import AsyncOpenAI
from pydantic import BaseModel, Field

from app.config import settings

logger = logging.getLogger(__name__)


class AIConversationState(BaseModel):
    """Structured output for the AI supervisor."""
    extracted_name: Optional[str] = Field(None, description="The user's name if mentioned")
    experience_years: Optional[int] = Field(None, description="Years of experience as an integer")
    job_interest: Optional[str] = Field(None, description="Job role or interest if mentioned")
    country: Optional[str] = Field(None, description="Preferred country to work in if mentioned")
    reply_message: str = Field(..., description="Reply in the exact language/register the user used")
    is_ready_to_sync: bool = Field(False, description="True when name, experience_years, job_interest, and country are all captured")
    intervention_needed: bool = Field(False, description="True if the user asks for a human or sounds frustrated")
    next_question_type: Optional[str] = Field(
        None,
        description="The field name you are asking for in this reply (name/job_role/experience_years/country/cv). Null if not asking for anything."
    )


_client: Optional[AsyncOpenAI] = None


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        api_key = settings.openai_api_key or os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise ValueError("OPENAI_API_KEY environment variable is not set.")
        _client = AsyncOpenAI(api_key=api_key)
    return _client


def _build_language_instruction(lang: str) -> str:
    instructions: Dict[str, str] = {
        "en": (
            "LANGUAGE: Respond in clear, simple English. "
            "Keep domain terms (Job, CV, Experience, Apply, Upload) in English."
        ),
        "si": (
            "LANGUAGE: Respond ONLY in native Sinhala script (සිංහල). "
            "Keep domain terms like Job, CV, Experience, Apply in English."
        ),
        "ta": (
            "LANGUAGE: Respond ONLY in native Tamil script (தமிழ்). "
            "Keep domain terms like Job, CV, Experience, Apply in English."
        ),
        "singlish": (
            "LANGUAGE: Respond in Singlish — Romanized Sinhala naturally mixed with English. "
            "Concrete examples of the register you must use:\n"
            "  - 'Oyata mokada job ekata apply karanna?' (What job do you want to apply for?)\n"
            "  - 'Kochchara avurudu experience thiyenawada?' (How many years of experience do you have?)\n"
            "  - 'Hari, dan CV eka upload karanna.' (Okay, please upload your CV now.)\n"
            "  - 'Kohomada, mama oyata help karanna innawa.' (Hello, I'm here to help you.)\n"
            "  - 'Sthuthi! Oyage CV eka labuna.' (Thank you! I received your CV.)\n"
            "NEVER switch to Sinhala script or pure English paragraphs."
        ),
        "tanglish": (
            "LANGUAGE: Respond in Tanglish — Romanized Tamil naturally mixed with English. "
            "Concrete examples of the register you must use:\n"
            "  - 'Neenga yeh job-ku apply panna virumbureenga?' (Which job do you want to apply for?)\n"
            "  - 'Evalo varusham experience irukku?' (How many years of experience do you have?)\n"
            "  - 'Sari, CV upload pannunga.' (Okay, please upload your CV.)\n"
            "  - 'Vanakkam, unga ku help panna ready-a irukken.' (Hello, I'm ready to help you.)\n"
            "  - 'Nandri! Unga CV kedaichuchu.' (Thank you! I received your CV.)\n"
            "NEVER switch to Tamil script or pure English paragraphs."
        ),
    }
    return instructions.get(lang or "en", instructions["en"])


def _build_system_prompt(
    collected_data: Dict[str, Any],
    asked_questions: List[str],
    locked_language: str,
    cv_just_uploaded: bool,
) -> str:
    # --- Build "already known" summary ---
    known_parts: List[str] = []
    if collected_data.get("name"):
        known_parts.append(f"name: {collected_data['name']}")
    if collected_data.get("job_role"):
        known_parts.append(f"job_role: {collected_data['job_role']}")
    if collected_data.get("experience_years") is not None:
        known_parts.append(f"experience_years: {collected_data['experience_years']}")
    if collected_data.get("country"):
        known_parts.append(f"country: {collected_data['country']}")
    if collected_data.get("skills"):
        known_parts.append("skills: captured")
    if collected_data.get("cv_uploaded"):
        known_parts.append("cv: uploaded")
    known_summary = ", ".join(known_parts) if known_parts else "nothing yet"

    # --- Build "still missing" list ---
    missing: List[str] = []
    if not collected_data.get("name"):
        missing.append("name")
    if not collected_data.get("job_role"):
        missing.append("job_role")
    if collected_data.get("experience_years") is None:
        missing.append("experience_years")
    if not collected_data.get("country"):
        missing.append("country")
    if not collected_data.get("cv_uploaded"):
        missing.append("cv")
    missing_str = ", ".join(missing) if missing else "NOTHING — all data collected, ready to sync"

    # --- CV confirmation section ---
    cv_section = ""
    if cv_just_uploaded:
        cv_section = """
CV WAS JUST RECEIVED:
- Thank the user warmly (in their language register).
- Tell them specifically what you extracted from their CV (mention name/role/experience/skills if present in WHAT I ALREADY KNOW).
- Only ask for fields listed in WHAT STILL NEEDS COLLECTING.
- DO NOT ask for anything already in WHAT I ALREADY KNOW.
"""

    lang_instruction = _build_language_instruction(locked_language)

    asked_str = ", ".join(asked_questions) if asked_questions else "nothing yet"

    return f"""You are an Elite Sri Lankan Recruitment Agent working for Dewan Consultants.
Your goal: help candidates find overseas jobs by collecting their details smoothly and naturally.

WHAT I ALREADY KNOW ABOUT THIS CANDIDATE:
{known_summary}

WHAT STILL NEEDS COLLECTING (in priority order):
{missing_str}

ALREADY ASKED — DO NOT ASK AGAIN:
{asked_str}
{cv_section}
COLLECTION GOAL — gather these fields (skip any already known):
1. name — candidate's full name
2. job_role — what job they are looking for
3. experience_years — total years of work experience (integer)
4. country — which country they want to work in
5. cv — ask them to upload their CV document or photo (only if not yet uploaded)

{lang_instruction}

RULES:
1. NEVER ask for a field already listed in WHAT I ALREADY KNOW.
2. NEVER ask for a field listed in ALREADY ASKED unless the user just gave a new answer to it.
3. Ask only ONE question per reply. Do not bundle multiple questions.
4. Keep replies short and conversational (1–3 sentences max).
5. If the user asks for a human agent or sounds clearly frustrated, set intervention_needed to true.
6. When all 5 items are done (name, job_role, experience_years, country, cv uploaded), set is_ready_to_sync to true.
7. If your reply asks for a specific field, set next_question_type to that field name exactly: name / job_role / experience_years / country / cv.
8. If not asking for any field (e.g. just acknowledging), set next_question_type to null.

Return ONLY valid JSON with these exact keys:
extracted_name, experience_years, job_interest, country, reply_message, is_ready_to_sync, intervention_needed, next_question_type
"""


def _fallback_reply() -> str:
    return "Thanks for your message. Could you please tell me your name and what job you are looking for?"


async def run_ai_supervisor(
    user_text: str,
    history: Optional[List[Dict[str, str]]] = None,
    force_applying: bool = False,
    collected_data: Optional[Dict[str, Any]] = None,
    asked_questions: Optional[List[str]] = None,
    locked_language: Optional[str] = None,
    cv_just_uploaded: bool = False,
) -> AIConversationState:
    effective_collected = collected_data or {}
    effective_asked = asked_questions or []
    effective_lang = locked_language or "en"

    system_prompt = _build_system_prompt(
        collected_data=effective_collected,
        asked_questions=effective_asked,
        locked_language=effective_lang,
        cv_just_uploaded=cv_just_uploaded,
    )

    messages: List[Dict[str, str]] = [{"role": "system", "content": system_prompt}]

    if history:
        messages.extend(history)

    if force_applying and not cv_just_uploaded:
        messages.append({
            "role": "system",
            "content": "The candidate has already uploaded a CV. Only ask for fields that are genuinely still missing.",
        })

    messages.append({"role": "user", "content": user_text or ""})

    try:
        client = _get_client()
        response = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=messages,
            response_format={"type": "json_object"},
            temperature=0.3,
            max_completion_tokens=320,
        )
        content = response.choices[0].message.content or "{}"
        return AIConversationState.model_validate_json(content)
    except Exception as exc:
        logger.warning("AI supervisor fallback used: %s", exc)
        return AIConversationState(
            extracted_name=None,
            experience_years=None,
            job_interest=None,
            country=None,
            reply_message=_fallback_reply(),
            is_ready_to_sync=False,
            intervention_needed=False,
            next_question_type=None,
        )
