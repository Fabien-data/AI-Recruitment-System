"""
Translation service.

Translates short, recruiter-authored snippets (e.g. interview instructions:
dress code, documents to bring, where to report) into the candidate's selected
language before they are embedded in an outbound WhatsApp message.

Reuses the same AsyncOpenAI client + primary model the rest of the bot uses.
Always degrades gracefully: on any error or missing key it returns the original
text so the message still sends (just untranslated).
"""
import logging
import os
from typing import Optional

from openai import AsyncOpenAI

from app.config import settings

logger = logging.getLogger(__name__)

_openai_api_key = settings.openai_api_key or os.getenv("OPENAI_API_KEY")
_client = AsyncOpenAI(api_key=_openai_api_key) if _openai_api_key else None

# Human-readable target descriptions for the prompt. Codes match the rest of
# the system (en / si / ta) plus the romanized registers the bot supports.
_LANG_NAMES = {
    "en": "English",
    "si": "Sinhala (native script)",
    "ta": "Tamil (native script)",
    "singlish": "Singlish (romanized Sinhala using English letters)",
    "tanglish": "Tanglish (romanized Tamil using English letters)",
}


async def translate_text(text: Optional[str], target_lang: str) -> Optional[str]:
    """
    Translate ``text`` into ``target_lang``.

    Returns the original text unchanged when:
    - text is empty/whitespace,
    - target is English (templates are authored in English already),
    - the OpenAI client is unavailable, or
    - translation fails for any reason.
    """
    if not text or not text.strip():
        return text

    lang = (target_lang or "en").lower()
    if lang == "en":
        return text

    if _client is None:
        logger.warning("translate_text: OpenAI client unavailable; returning original text")
        return text

    target_name = _LANG_NAMES.get(lang, lang)
    system_prompt = (
        "You are a translator for a Sri Lankan recruitment agency. "
        f"Translate the user's message into {target_name}. "
        "Keep it natural and professional for a job candidate. "
        "Preserve line breaks, bullet points, numbers, dates, times, and proper "
        "nouns (names, places). Do NOT add, remove, or explain anything. "
        "Return ONLY the translated text."
    )

    try:
        response = await _client.chat.completions.create(
            model=settings.llm_primary_model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": text},
            ],
            temperature=0.2,
            max_completion_tokens=600,
        )
        translated = (response.choices[0].message.content or "").strip()
        return translated or text
    except Exception as exc:  # noqa: BLE001 — never block the send on translation
        logger.warning("translate_text failed (%s); returning original text", exc)
        return text
