from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Dict, List, Optional

from openai import AsyncOpenAI
from pydantic import BaseModel, Field

from app.config import settings
from app.knowledge import get_general_knowledge, get_job_cache

logger = logging.getLogger(__name__)


def _get_company_faq_block() -> str:
    """
    Build the company FAQ block shown to candidates in post-onboarding mode.
    Reads live values from general_knowledge_store (pushed from CRM) with
    hardcoded defaults as fallback so the first deploy works out of the box.
    """
    gk = get_general_knowledge()

    ci       = (gk.get("company_info") or {}).get("data", {})
    hotline  = ci.get("hotline") or "0117324324"
    address  = ci.get("address") or "2nd Floor, No 52, Hospital St, 00100, Colombo, Sri Lanka"
    maps_url = ci.get("maps_url") or "https://share.google/ILCa5LUtejx5xzl9C"

    reg        = (gk.get("registration_fee") or {}).get("data", {})
    fee_amount = reg.get("amount") or "LKR 5,000"
    fee_desc   = reg.get("description") or (
        "one-time; includes visa processing support, medical test coordination, "
        "departure formalities & contract review"
    )

    # Derive countries dynamically from live job cache (most accurate source)
    live_countries: list = []
    for job in get_job_cache().values():
        if job.get("status") == "active":
            for c in (job.get("countries") or []):
                if c and c not in live_countries:
                    live_countries.append(c)
    gk_countries = (gk.get("active_countries") or {}).get("data", {}).get("list", [])
    countries_list = live_countries or gk_countries or [
        "UAE (Dubai/Abu Dhabi/Sharjah)", "Qatar", "Saudi Arabia", "Kuwait", "Malaysia", "Oman"
    ]
    countries_str = ", ".join(countries_list)

    return (
        f"- Registration cost and process: {fee_amount} registration fee ({fee_desc}).\n"
        f"- How to apply: 1) Share CV (done ✅) 2) Visit office or call {hotline} to confirm slot "
        f"3) Complete medical check & visa with our help.\n"
        f"- Available countries: {countries_str}.\n"
        f"- Hotline / contact agent: {hotline} (Monday–Saturday 8am–6pm Sri Lanka time).\n"
        f"- Company address: {address}\n"
        f"- Google Maps: {maps_url}"
    )


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
    _foreign_script_ban = (
        " ABSOLUTE PROHIBITION: Never include ANY character from Korean (Hangul 가-힣 / ㄱ-ㅎ), "
        "Chinese (CJK 一-龯), Japanese (あ-ん / ア-ン), Thai (ก-๛), Devanagari/Hindi (अ-ह), "
        "Arabic (ا-ي), Hebrew, or any other foreign script. Only the script defined above is allowed."
    )
    # Many of our candidates are blue-collar workers with limited literacy.
    # Mirror their writing style so the conversation feels natural, not like
    # filling a form. This applies to every register.
    _literacy_mirroring = (
        "\nLITERACY MIRRORING: If the user writes short broken phrases, drop articles "
        "and use 4–6 word sentences. If the user writes complete sentences, mirror that. "
        "If a prior assistant turn asked a question and the user's reply is off-topic, very "
        "short, or contains 'mokakda?' / 'enna?' / 'what?' / 'puriyala' / 'theerum naha' — "
        "rephrase the question with a concrete example in parentheses."
    )
    instructions: Dict[str, str] = {
        "en": (
            "LANGUAGE: Respond in clear, simple English only. "
            "Keep domain terms (Job, CV, Experience, Apply, Upload) in English. "
            "Do NOT mix in Sinhala, Tamil, Singlish, or Tanglish words.\n"
            "Concrete examples of the EXACT register you must use:\n"
            "  ✅ 'Welcome! What's your full name?'\n"
            "  ✅ 'Got it. Which country would you like to work in — UAE, Qatar, Saudi?'\n"
            "  ✅ 'How many years of experience do you have as a driver?'\n"
            "  ✅ 'Driver jobs in Qatar pay around QAR 1500 + accommodation. Want me to list them?'\n"
            "  ✅ 'No problem — for example, 0, 1, 2, or 5 years. How many?'"
            + _foreign_script_ban + "\n" + _tone + _literacy_mirroring
        ),
        "si": (
            "LANGUAGE: Respond EXCLUSIVELY in native Sinhala script (සිංහල අකුරු). "
            "You MUST write every word in Sinhala Unicode script. "
            "Domain terms Job, CV, Experience, Apply, Upload may remain in English. "
            "STRICT PURITY RULE — mixing Romanized Sinhala (Singlish) is FORBIDDEN:\n"
            "  ❌ WRONG: 'Oyage job eka mokada?' (this is Singlish — forbidden here)\n"
            "  ✅ CORRECT: 'ඔබ සොයන රැකියාව කුමක්ද?'\n"
            "  ✅ CORRECT: 'ඔබේ සම්පූර්ණ නම කියන්නද?'\n"
            "  ✅ CORRECT: 'කුමන රටකට වැඩට යන්න කැමතිද? (UAE, Qatar, Saudi)'\n"
            "  ✅ CORRECT: 'Driver ලෙස වසර කීයක අත්දැකීම් තිබේද?'\n"
            "  ✅ CORRECT: 'Qatar Driver වැටුප සති 1500 පමණයි. තවත් විස්තර ඕනේද?'\n"
            "  ✅ CORRECT: 'තේරුණේ නැද්ද? උදාහරණයක්: 0, 1, 2, 5 අවුරුදු.'\n"
            "  ✅ CORRECT: 'ඔබේ CV ලේඛනය හෝ ඡායාරූපයක් ඉදිරිපත් කරන්න.'"
            + _foreign_script_ban + "\n" + _tone + _literacy_mirroring
        ),
        "ta": (
            "LANGUAGE: Respond EXCLUSIVELY in native Tamil script (தமிழ் எழுத்து). "
            "You MUST write every word in Tamil Unicode script. "
            "Domain terms Job, CV, Experience, Apply, Upload may remain in English. "
            "STRICT PURITY RULE — mixing Romanized Tamil (Tanglish) is FORBIDDEN:\n"
            "  ❌ WRONG: 'Neenga enna job venumnu sollunga?' (this is Tanglish — forbidden here)\n"
            "  ✅ CORRECT: 'வணக்கம்! உங்கள் முழுப் பெயரை சொல்லுங்கள்?'\n"
            "  ✅ CORRECT: 'எந்த நாட்டிற்கு வேலைக்கு போக விரும்புகிறீர்கள்? (UAE, Qatar, Saudi)'\n"
            "  ✅ CORRECT: 'Driver-ஆக எத்தனை வருடம் அனுபவம் இருக்கிறது?'\n"
            "  ✅ CORRECT: 'Qatar Driver சம்பளம் QAR 1500 + தங்குமிடம். விவரம் வேண்டுமா?'\n"
            "  ✅ CORRECT: 'புரியவில்லையா? உதாரணம்: 0, 1, 2, 5 வருடம்.'\n"
            "  ✅ CORRECT: 'உங்கள் CV-யை அனுப்புங்கள்.'"
            + _foreign_script_ban + "\n" + _tone + _literacy_mirroring
        ),
        "singlish": (
            "LANGUAGE: Respond in Singlish — Romanized Sinhala naturally mixed with English. "
            "Write ALL words using Latin (Roman) letters only — NO Sinhala Unicode script. "
            "Sprinkle 1 friendly Singlish marker ('machang', 'aiyo', 'patta', 'aney') every "
            "3–4 turns to sound natural — NEVER in formal FAQ answers about salary/visa/fees.\n"
            "Concrete examples of the EXACT register you must use:\n"
            "  ✅ 'Ayubowan! Oyage full name kiyanna?'\n"
            "  ✅ 'Hari machang, kohe ratata yanna oneda? (UAE, Qatar, Saudi)'\n"
            "  ✅ 'Driver wage avurudu kiyak experience thiyenawada?'\n"
            "  ✅ 'Qatar Driver sambala QAR 1500 wage + accommodation tikat thiyenawa. Wadi visthara oneda?'\n"
            "  ✅ 'Therunne nadda? Udaharanayak: 0, 1, 2, 5 avurudu. Kochchara?'\n"
            "  ✅ 'Hari, dan CV eka upload karanna machang.'\n"
            "FORBIDDEN: Sinhala script (ස, ි, ා etc.), pure formal English paragraphs."
            + _foreign_script_ban + "\n" + _tone + _literacy_mirroring
        ),
        "tanglish": (
            "LANGUAGE: Respond in Tanglish — Romanized Tamil naturally mixed with English. "
            "Write ALL words using Latin (Roman) letters only — NO Tamil Unicode script. "
            "Sprinkle 1 friendly Tanglish marker ('machi', 'da', 'pa', 'aiyo', 'thambi', 'akka') "
            "every 3–4 turns to sound natural — NEVER in formal FAQ answers about salary/visa/fees.\n"
            "Concrete examples of the EXACT register you must use:\n"
            "  ✅ 'Vanakkam thambi! Unga full name sollunga?'\n"
            "  ✅ 'Sari da, enna naadu-ku poganum? (UAE, Qatar, Saudi)'\n"
            "  ✅ 'Driver-a evalo varusham experience irukku?'\n"
            "  ✅ 'Qatar Driver sambalam QAR 1500 + accommodation kidaikum. Innum vivaram venuma?'\n"
            "  ✅ 'Puriyala-na sollunga. Udharanam: 0, 1, 2, 5 varudam. Evvalo?'\n"
            "  ✅ 'Sari machi, CV upload pannunga.'\n"
            "FORBIDDEN: Tamil script (த, ம, ி etc.), pure formal English paragraphs."
            + _foreign_script_ban + "\n" + _tone + _literacy_mirroring
        ),
    }
    return instructions.get(lang or "en", instructions["en"])


# ─── Reply script purity guard ────────────────────────────────────────────────
# Multilingual LLMs sometimes leak Hangul/CJK/Thai/Devanagari tokens when
# generating in less common scripts (e.g. Sinhala). These helpers detect and
# strip such leaks so candidates never see foreign-script noise in their reply.

_ALLOWED_NATIVE_SCRIPT = {
    "si": (0x0D80, 0x0DFF),
    "ta": (0x0B80, 0x0BFF),
}


def _is_allowed_codepoint(cp: int, native_range: Optional[tuple]) -> bool:
    if cp < 0x0080:
        return True
    if cp <= 0x024F:
        return True
    if 0x2000 <= cp <= 0x214F:
        return True
    if 0x2190 <= cp <= 0x23FF:
        return True
    if 0x2600 <= cp <= 0x27BF:
        return True
    if cp == 0x200D or 0xFE00 <= cp <= 0xFE0F:
        return True
    if 0x1F000 <= cp <= 0x1FFFF:
        return True
    if native_range and native_range[0] <= cp <= native_range[1]:
        return True
    return False


def _is_reply_script_clean(text: str, lang: str) -> bool:
    if not text:
        return True
    native_range = _ALLOWED_NATIVE_SCRIPT.get(lang)
    return all(_is_allowed_codepoint(ord(ch), native_range) for ch in text)


def _strip_foreign_chars(text: str, lang: str) -> str:
    if not text:
        return text
    native_range = _ALLOWED_NATIVE_SCRIPT.get(lang)
    cleaned = "".join(ch for ch in text if _is_allowed_codepoint(ord(ch), native_range))
    return " ".join(cleaned.split()).strip()


_PURITY_RETRY_INSTRUCTION = (
    "CRITICAL CORRECTION: Your previous reply contained characters from a foreign script "
    "(Korean Hangul, Chinese, Japanese, Thai, Devanagari, Arabic, or similar). "
    "Regenerate the SAME JSON response but rewrite reply_message using ONLY the script "
    "appropriate for the user's language. Do NOT include any foreign-script character."
)


def _build_system_prompt(
    collected_data: Dict[str, Any],
    asked_questions: List[str],
    locked_language: str,
    cv_just_uploaded: bool,
    faq_context: Optional[str] = None,
    phone_number: Optional[str] = None,
    ad_context_snippet: Optional[str] = None,
    rephrase_mode: bool = False,
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
    # Check both key variants — orchestrator stores as "cv_uploaded", legacy as "cv"
    if not (collected_data.get("cv_uploaded") or collected_data.get("cv")):
        missing.append("cv")
    missing_str = ", ".join(missing) if missing else "NOTHING — all data collected, ready to sync"

    # --- FAQ mode (ungated) ---
    # Previously this was gated on `not missing` (all fields collected). That
    # silently swallowed every early FAQ ask. Now: if vacancy data is provided
    # we always make it answerable, and we separately add post-onboarding tone
    # rules when the profile is complete. The orchestrator decides whether to
    # populate `faq_context` based on ad_context presence or an FAQ heuristic.
    is_post_onboarding = not missing
    faq_section = ""
    ad_section = ""
    if ad_context_snippet:
        ad_section = (
            f"\nAD CONTEXT — the candidate arrived from a specific Meta ad. Ground every reply about this job in:\n"
            f"{ad_context_snippet}\n"
        )

    if faq_context:
        _company_block = _get_company_faq_block()
        _hotline = (get_general_knowledge().get("company_info") or {}).get("data", {}).get("hotline") or "0117324324"
        mode_tag = "POST-ONBOARDING FAQ MODE" if is_post_onboarding else "EARLY FAQ MODE (profile not yet complete)"
        # When profile is incomplete, the model must still keep collecting after
        # answering — never abandon the intake flow just because the user asked
        # a question.
        early_tail = (
            ""
            if is_post_onboarding
            else "\n- After answering, IMMEDIATELY ask the next missing field from WHAT STILL NEEDS COLLECTING."
        )
        faq_section = f"""
{mode_tag} — answer the candidate's question using live data.
COMPANY INFO:
{_company_block}
LIVE VACANCY DATA:
{faq_context}
RULES FOR FAQ MODE:
- Answer ANY question the candidate asks using the information above. No question should go unanswered.
- Use the live vacancy data for specific titles, salaries, countries — never guess.
- Keep replies concise (1–3 sentences). End every reply with one helpful call-to-action.
- NEVER say "I don't know" — if unsure, invite them to call {_hotline}.
- ALWAYS reply in the candidate's exact language register (Sinhala script / Tamil script / Singlish / Tanglish / English).{early_tail}
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

    rephrase_section = ""
    if rephrase_mode:
        rephrase_section = (
            "\nREPHRASE MODE ON — the user did not understand the previous question. "
            "Re-ask the SAME field but: (1) use the simplest words in the user's language register, "
            "(2) include 2 concrete examples in parentheses (e.g., country → 'like Dubai, Qatar, Saudi'; "
            "experience → '0, 1, 2, 5 years'), (3) keep it under 12 words.\n"
        )

    return f"""You are an Elite Sri Lankan Recruitment Agent working for Dewan Consultants.
Your goal: help candidates find overseas jobs by collecting their details smoothly and naturally.

WHAT I ALREADY KNOW ABOUT THIS CANDIDATE:
{known_summary}

WHAT STILL NEEDS COLLECTING (in priority order):
{missing_str}

ALREADY ASKED — DO NOT ASK AGAIN:
{asked_str}
{cv_section}{ad_section}{faq_section}{rephrase_section}
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
    # Neutral — does not ask for a specific field so we don't reset the
    # conversation state when the LLM is temporarily unavailable.
    return "Sorry, I'm having a small technical issue right now. Please give me a moment and try sending your message again. 🙏"


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
    ad_context_snippet: Optional[str] = None,
    rephrase_mode: bool = False,
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
        ad_context_snippet=ad_context_snippet,
        rephrase_mode=rephrase_mode,
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
            response = await asyncio.wait_for(
                client.chat.completions.create(
                    model=model_name,
                    messages=messages,
                    response_format={"type": "json_object"},
                    temperature=0.4,
                    max_completion_tokens=450,
                ),
                timeout=15.0,
            )
            content = response.choices[0].message.content or "{}"
            parsed = AIConversationState.model_validate_json(content)

            if _is_reply_script_clean(parsed.reply_message, effective_lang):
                return parsed

            # Foreign-script leak detected — retry once with a hardened instruction.
            logger.warning(
                "AI supervisor reply for lang=%s contained foreign-script chars; retrying",
                effective_lang,
            )
            retry_messages = list(messages) + [
                {"role": "system", "content": _PURITY_RETRY_INSTRUCTION}
            ]
            try:
                retry_response = await asyncio.wait_for(
                    client.chat.completions.create(
                        model=model_name,
                        messages=retry_messages,
                        response_format={"type": "json_object"},
                        temperature=0.2,
                        max_completion_tokens=450,
                    ),
                    timeout=15.0,
                )
                retry_content = retry_response.choices[0].message.content or "{}"
                retry_parsed = AIConversationState.model_validate_json(retry_content)
                if _is_reply_script_clean(retry_parsed.reply_message, effective_lang):
                    return retry_parsed
                parsed = retry_parsed  # fall through to strip-and-return
            except Exception as retry_exc:
                logger.warning("AI supervisor purity retry failed: %s", retry_exc)

            # Last-resort cleanup so the candidate never sees foreign characters.
            parsed.reply_message = _strip_foreign_chars(parsed.reply_message, effective_lang)
            return parsed
        except asyncio.TimeoutError:
            last_exc = asyncio.TimeoutError(model_name)
            logger.warning("AI supervisor model %s timed out after 15 s", model_name)
        except Exception as exc:
            last_exc = exc
            logger.warning("AI supervisor model %s failed, trying next: %s", model_name, exc)

    logger.error("All supervisor models failed; using neutral holding reply")
    return AIConversationState(
        extracted_name=None,
        experience_years=None,
        extracted_age=None,
        extracted_email=None,
        extracted_countries=None,
        job_interest=None,
        country=None,
        # Neutral holding message — does NOT ask for any field so the
        # conversation state is preserved and the user can retry.
        reply_message=_fallback_reply(),
        is_ready_to_sync=False,
        intervention_needed=False,
        next_question_type=None,
    )
