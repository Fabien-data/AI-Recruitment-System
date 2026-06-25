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
import re
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


# Link-safe, cached translation for the (possibly long) recruiter-authored interview
# details block. URLs are masked with placeholders before translation and restored
# after, so map links (https://share.google/…) can never be mangled by the model.
# Results are cached by (lang, text) because the SAME block is sent to every
# candidate in a bulk interview batch — without this we'd re-translate it N times.
_URL_RE = re.compile(r"https?://\S+")
_notes_cache: dict = {}
_NOTES_CACHE_MAX = 500


async def translate_interview_notes(text: Optional[str], target_lang: str) -> Optional[str]:
    """Translate the interview-details block into ``target_lang`` while preserving
    URLs verbatim. Falls back to the original text on any error. English / empty
    input is returned unchanged."""
    if not text or not text.strip():
        return text
    lang = (target_lang or "en").lower()
    if lang == "en":
        return text
    if _client is None:
        logger.warning("translate_interview_notes: OpenAI client unavailable; returning original text")
        return text

    cache_key = (lang, text)
    cached = _notes_cache.get(cache_key)
    if cached is not None:
        return cached

    # Mask URLs so the model only has to keep the placeholders intact.
    urls: list = []

    def _stash(match: "re.Match") -> str:
        urls.append(match.group(0))
        return f"[[LINK{len(urls) - 1}]]"

    masked = _URL_RE.sub(_stash, text)

    target_name = _LANG_NAMES.get(lang, lang)
    system_prompt = (
        "You are a translator for a Sri Lankan recruitment agency. "
        f"Translate the user's interview-details message into {target_name}. "
        "Keep it natural and professional for a job candidate. "
        "CRITICAL: keep these EXACTLY as-is, unchanged and in their original places — "
        "any placeholder of the form [[LINK0]], [[LINK1]] etc.; all street addresses, "
        "building names, city names, and postal codes; and all numbers, dates and times. "
        "Preserve line breaks, bullet points and emojis. Do NOT add, remove, or explain "
        "anything. Return ONLY the translated text."
    )

    try:
        response = await _client.chat.completions.create(
            model=settings.llm_primary_model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": masked},
            ],
            temperature=0.2,
            max_completion_tokens=1500,
        )
        translated = (response.choices[0].message.content or "").strip() or masked
    except Exception as exc:  # noqa: BLE001 — never block the send on translation
        logger.warning("translate_interview_notes failed (%s); returning original text", exc)
        translated = masked

    # Restore the original URLs.
    for i, url in enumerate(urls):
        translated = translated.replace(f"[[LINK{i}]]", url)

    # Safety net: if the model dropped any placeholder, fall back to the original
    # (untranslated) text rather than risk a message missing its map links.
    if any(f"[[LINK{i}]]" in translated for i in range(len(urls))):
        logger.warning("translate_interview_notes: placeholder lost; falling back to original text")
        translated = text

    if len(_notes_cache) >= _NOTES_CACHE_MAX:
        _notes_cache.clear()
    _notes_cache[cache_key] = translated
    return translated
