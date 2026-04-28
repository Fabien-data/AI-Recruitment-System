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
    extracted_age: Optional[int] = Field(None, description="The user's age as an integer if mentioned")
    extracted_email: Optional[str] = Field(None, description="The user's email address if mentioned")
    extracted_countries: Optional[list] = Field(None, description="List of preferred countries to work in if mentioned (e.g. ['UAE', 'Qatar'])")
    job_interest: Optional[str] = Field(None, description="Job role or interest if mentioned")
    country: Optional[str] = Field(None, description="Primary preferred country to work in if mentioned")
    reply_message: str = Field(..., description="Reply in the exact language/register the user used")
    is_ready_to_sync: bool = Field(False, description="True when name, job_interest, countries, age, email, experience_years, and cv are all captured")
    intervention_needed: bool = Field(False, description="True if the user asks for a human or sounds frustrated")
    next_question_type: Optional[str] = Field(
        None,
        description="The field name you are asking for in this reply (name/job_role/countries/age/email/experience_years/cv). Null if not asking for anything."
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
    _tone = (
        "TONE: Be warm, concise, and professional — like a knowledgeable HR consultant. "
        "Never sound robotic or copy-paste. Vary phrasing. Do not over-explain. "
        "One question at a time. Keep each message under 3 sentences unless answering an FAQ."
    )
    instructions: Dict[str, str] = {
        "en": (
            "LANGUAGE: Respond in clear, simple English only. "
            "Keep domain terms (Job, CV, Experience, Apply, Upload) in English. "
            "Do NOT mix in Sinhala, Tamil, Singlish, or Tanglish words.\n" + _tone
        ),
        "si": (
            "LANGUAGE: Respond EXCLUSIVELY in native Sinhala script (සිංහල අකුරු). "
            "You MUST write every word in Sinhala Unicode script. "
            "Domain terms Job, CV, Experience, Apply, Upload may remain in English. "
            "STRICT PURITY RULE — mixing Romanized Sinhala (Singlish) is FORBIDDEN:\n"
            "  ❌ WRONG: 'Oyage job eka mokada?' (this is Singlish — forbidden here)\n"
            "  ✅ CORRECT: 'ඔබ සොයන රැකියාව කුමක්ද?'\n"
            "  ❌ WRONG: 'Kohomada, mama help karanna innawa.'\n"
            "  ✅ CORRECT: 'ආයුබෝවන්, මා ඔබට සහාය වීමට සූදානම්.'\n"
            "  ✅ CORRECT: 'ඔබේ CV ලේඛනය හෝ ඡායාරූපයක් ඉදිරිපත් කරන්න.'\n"
            "  ✅ CORRECT: 'ඔබේ වයස කීයද?'\n"
            "  ✅ CORRECT: 'ඔබේ ඊමේල් ලිපිනය කුමක්ද?'\n"
            "  ✅ CORRECT: 'ඔබේ රැකියා අත්දැකීම් වසර කීයක්ද?'\n" + _tone
        ),
        "ta": (
            "LANGUAGE: Respond EXCLUSIVELY in native Tamil script (தமிழ் எழுத்து). "
            "You MUST write every word in Tamil Unicode script. "
            "Domain terms Job, CV, Experience, Apply, Upload may remain in English. "
            "STRICT PURITY RULE — mixing Romanized Tamil (Tanglish) is FORBIDDEN:\n"
            "  ❌ WRONG: 'Neenga enna job venumnu sollunga?' (this is Tanglish — forbidden here)\n"
            "  ✅ CORRECT: 'நீங்கள் எந்த வேலையை விரும்புகிறீர்கள்?'\n"
            "  ❌ WRONG: 'Vanakkam, ungaluku help panna ready-a irukken.'\n"
            "  ✅ CORRECT: 'வணக்கம், நான் உங்களுக்கு உதவ தயாராக இருக்கிறேன்.'\n" + _tone
        ),
        "singlish": (
            "LANGUAGE: Respond in Singlish — Romanized Sinhala naturally mixed with English. "
            "Write ALL words using Latin (Roman) letters only — NO Sinhala Unicode script. "
            "Concrete examples of the EXACT register you must use:\n"
            "  ✅ 'Oyata mokada job ekata apply karanna?' (not 'ඔබට')  \n"
            "  ✅ 'Kochchara avurudu experience thiyenawada?'\n"
            "  ✅ 'Hari, dan CV eka upload karanna.'\n"
            "  ✅ 'Sthuthi! Oyage CV eka labuna.'\n"
            "  ✅ 'Kohomada, mama oyata help karanna innawa.'\n"
            "FORBIDDEN: Sinhala script (ස, ි, ා etc.), pure formal English paragraphs.\n" + _tone
        ),
        "tanglish": (
            "LANGUAGE: Respond in Tanglish — Romanized Tamil naturally mixed with English. "
            "Write ALL words using Latin (Roman) letters only — NO Tamil Unicode script. "
            "Concrete examples of the EXACT register you must use:\n"
            "  ✅ 'Neenga yeh job-ku apply panna virumbureenga?' (not 'நீங்கள்')\n"
            "  ✅ 'Evalo varusham experience irukku?'\n"
            "  ✅ 'Sari, CV upload pannunga.'\n"
            "  ✅ 'Nandri! Unga CV kedaichuchu.'\n"
            "  ✅ 'Vanakkam, ungaluku help panna ready-a irukken.'\n"
            "FORBIDDEN: Tamil script (த, ம, ி etc.), pure formal English paragraphs.\n" + _tone
        ),
    }
    return instructions.get(lang or "en", instructions["en"])


def _build_system_prompt(
    collected_data: Dict[str, Any],
    asked_questions: List[str],
    locked_language: str,
    cv_just_uploaded: bool,
    faq_context: Optional[str] = None,
    phone_number: Optional[str] = None,
) -> str:
    # --- Build "already known" summary ---
    known_parts: List[str] = []
    if phone_number:
        known_parts.append(f"whatsapp_phone: {phone_number} (already captured — NEVER ask for this)")
    if collected_data.get("name"):
        known_parts.append(f"name: {collected_data['name']}")
    if collected_data.get("job_role"):
        known_parts.append(f"job_role: {collected_data['job_role']}")
    if collected_data.get("countries"):
        known_parts.append(f"countries: {collected_data['countries']}")
    elif collected_data.get("country"):
        known_parts.append(f"country: {collected_data['country']}")
    if collected_data.get("age") is not None:
        known_parts.append(f"age: {collected_data['age']}")
    if collected_data.get("email"):
        known_parts.append(f"email: {collected_data['email']}")
    if collected_data.get("experience_years") is not None:
        known_parts.append(f"experience_years: {collected_data['experience_years']}")
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
    has_countries = bool(collected_data.get("countries") or collected_data.get("country"))
    if not has_countries:
        missing.append("countries")
    if collected_data.get("age") is None:
        missing.append("age")
    if not collected_data.get("email"):
        missing.append("email")
    if collected_data.get("experience_years") is None:
        missing.append("experience_years")
    if not collected_data.get("cv_uploaded"):
        missing.append("cv")
    missing_str = ", ".join(missing) if missing else "NOTHING — all data collected, ready to sync"

    # --- Post-onboarding FAQ mode ---
    is_post_onboarding = not missing  # All data collected
    faq_section = ""
    if is_post_onboarding or faq_context:
        faq_section = f"""
POST-ONBOARDING MODE — The candidate's profile is complete. Switch to helpful FAQ mode.
You can now answer questions about:
- Registration cost and process: LKR 5,000 registration fee (one-time); includes visa processing support, medical test coordination, departure formalities & contract review.
- How to apply: 1) Share CV (done ✅) 2) Visit office or call 0117324324 to confirm slot 3) Complete medical check & visa with our help.
- Available countries: UAE (Dubai/Abu Dhabi/Sharjah), Qatar, Saudi Arabia, Kuwait, Malaysia, Oman.
- Job details / vacancies: Roles include Driver, Nurse, Electrician, Mason, Cook, Factory Worker, Security Guard, Cleaner and more. Use LIVE VACANCY DATA below if provided.
- Hotline / contact agent: 0117324324 (Monday–Saturday 8am–6pm Sri Lanka time).
- Company address: 2nd Floor, No 52, Hospital St, 00100, Colombo, Sri Lanka.
- Google Maps: https://share.google/ILCa5LUtejx5xzl9C
{f"LIVE VACANCY DATA:{chr(10)}{faq_context}" if faq_context else ""}
RULES FOR FAQ MODE:
- Answer ANY question the candidate asks using the information above. No question should go unanswered.
- If live vacancy data is provided, use it to give specific vacancy counts and job titles.
- Keep replies concise (1–3 sentences). End every reply with one helpful call-to-action.
- NEVER say "I don't know" — if unsure, invite them to call 0117324324.
- ALWAYS reply in the candidate's exact language register (Sinhala script / Tamil script / Singlish / Tanglish / English).
- Do NOT introduce the onboarding closing message again if it was already sent.
"""

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
{cv_section}{faq_section}
COLLECTION GOAL — gather these fields in order (skip any already known):
1. name — candidate's full name
2. job_role — what job they are looking for (e.g. Driver, Nurse, Cook, Mason, Electrician)
3. countries — which countries they want to work in (accept multiple, e.g. "UAE and Qatar")
4. age — candidate's age in years (integer)
5. email — candidate's email address (WhatsApp phone is already captured; ask for email as backup/official contact)
6. experience_years — total years of work experience (integer)
7. cv — ask them to upload their CV document or photo (only if not yet uploaded)

{lang_instruction}

RULES:
1. NEVER ask for a field already listed in WHAT I ALREADY KNOW. Violations cause a poor candidate experience.
2. NEVER ask for a field listed in ALREADY ASKED. If it is in that list, treat it as collected and move on.
3. NEVER ask for the phone number — it is already captured from WhatsApp (see WHAT I ALREADY KNOW).
4. Ask only ONE question per reply. Do not bundle multiple questions.
5. Keep replies short and conversational (1–3 sentences max).
6. If the user asks for a human agent or sounds clearly frustrated, set intervention_needed to true.
7. When all 7 items are done (name, job_role, countries, age, email, experience_years, cv uploaded), set is_ready_to_sync to true.
8. If your reply asks for a specific field, set next_question_type to that field name exactly: name / job_role / countries / age / email / experience_years / cv.
9. If not asking for any field (e.g. just acknowledging or answering FAQ), set next_question_type to null.
10. For 'countries', if the user mentions multiple countries, capture all of them in extracted_countries as a list.
11. For 'age', extract only a plain integer (e.g. 28).
12. For 'email', only accept a valid email format (name@domain.com). If they give only a phone number, note it but ask for email separately.
13. Validate every answer contextually: if the user's reply clearly answers the current question, accept it and move to the next field — do not ask the same question again just because the answer was brief.
14. LANGUAGE CONSISTENCY: Every reply must be in the same language register the candidate has been using throughout the conversation. Never switch languages between messages.
15. NEVER infer or assume job_role from a country name, city, or any indirect context. A country name (e.g. "Dubai", "Qatar") is NOT a job role. Only set job_interest if the candidate has explicitly stated the position they want (e.g. "I want to work as a driver", "nurse", "mason").

Return ONLY valid JSON with these exact keys:
extracted_name, experience_years, extracted_age, extracted_email, extracted_countries, job_interest, country, reply_message, is_ready_to_sync, intervention_needed, next_question_type
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
    faq_context: Optional[str] = None,
    phone_number: Optional[str] = None,
) -> AIConversationState:
    effective_collected = collected_data or {}
    effective_asked = asked_questions or []
    effective_lang = locked_language or "en"

    system_prompt = _build_system_prompt(
        collected_data=effective_collected,
        asked_questions=effective_asked,
        locked_language=effective_lang,
        cv_just_uploaded=cv_just_uploaded,
        faq_context=faq_context,
        phone_number=phone_number,
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

    model_candidates = [settings.llm_primary_model]
    if settings.llm_fallback_model and settings.llm_fallback_model not in model_candidates:
        model_candidates.append(settings.llm_fallback_model)

    client = _get_client()
    last_exc: Optional[Exception] = None
    for model_name in model_candidates:
        try:
            response = await client.chat.completions.create(
                model=model_name,
                messages=messages,
                response_format={"type": "json_object"},
                temperature=0.4,
                max_completion_tokens=450,
            )
            content = response.choices[0].message.content or "{}"
            return AIConversationState.model_validate_json(content)
        except Exception as exc:
            last_exc = exc
            logger.warning("AI supervisor model %s failed, trying next: %s", model_name, exc)

    logger.error("All supervisor models failed; using static fallback")
    return AIConversationState(
        extracted_name=None,
        experience_years=None,
        extracted_age=None,
        extracted_email=None,
        extracted_countries=None,
        job_interest=None,
        country=None,
        reply_message=_fallback_reply(),
        is_ready_to_sync=False,
        intervention_needed=False,
        next_question_type=None,
    )
