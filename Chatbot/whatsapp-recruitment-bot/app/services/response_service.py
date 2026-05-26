"""Natural-language response generator for modular orchestration actions."""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, Optional, Union

from app.config import settings

logger = logging.getLogger(__name__)

# Map register code → friendly name used in the prompt so GPT writes in the
# right script / dialect when refining raw DB data into a user-facing reply.
_LANG_NAMES = {
    "en": "English",
    "si": "Sinhala (native script)",
    "ta": "Tamil (native script)",
    "singlish": "Singlish (Romanized Sinhala mixed with English, Latin letters only)",
    "tanglish": "Tanglish (Romanized Tamil mixed with English, Latin letters only)",
}


class ResponseService:
    """Generate user-facing responses from high-level actions."""

    async def compose_reply_from_data(
        self,
        intent: str,
        raw_data: Union[Dict[str, Any], list],
        language: str = "en",
    ) -> str:
        """Convert raw DB data into a natural-language reply in the user's register.

        Single chokepoint that any place fetching DB rows (jobs, salaries, FAQ
        details) can call. Replaces ad-hoc string concatenation so all outputs
        get the same tone, length, and language treatment.
        """
        if not settings.openai_api_key:
            return self._fallback_for_intent(intent, language)

        lang_name = _LANG_NAMES.get(language, _LANG_NAMES["en"])
        data_str = json.dumps(raw_data, ensure_ascii=False)[:4000]

        prompt = (
            f"You are translating recruitment data into a natural {lang_name} WhatsApp reply.\n"
            f"Intent: {intent}\n"
            f"Data: {data_str}\n\n"
            "Be brief and conversational. Use 1–4 short sentences. No bullet symbols "
            "unless listing 3+ items; if listing, use clean dashes. Never expose raw "
            "JSON, IDs, or DB column names. If the data is empty, say so warmly and "
            "offer one helpful next step. Keep domain terms (CV, Apply, Upload, "
            "Experience) in English. End with one short call-to-action question."
        )

        try:
            from openai import AsyncOpenAI

            client = AsyncOpenAI(api_key=settings.openai_api_key)
            resp = await client.chat.completions.create(
                model=settings.llm_primary_model or "gpt-4o",
                temperature=0.5,
                messages=[{"role": "system", "content": prompt}],
                max_completion_tokens=220,
            )
            text = (resp.choices[0].message.content or "").strip()
            return text or self._fallback_for_intent(intent, language)
        except Exception as exc:
            logger.warning("compose_reply_from_data fell back due to error: %s", exc)
            return self._fallback_for_intent(intent, language)

    def _fallback_for_intent(self, intent: str, language: str) -> str:
        msgs = {
            "en": "I'll look that up and get back to you in a moment.",
            "si": "මම විස්තර බලලා කියන්නම්.",
            "ta": "நான் விவரம் பார்த்து சொல்கிறேன்.",
            "singlish": "Mama bala kiyannam tikkak.",
            "tanglish": "Naan paathu sollren da.",
        }
        return msgs.get(language, msgs["en"])

    async def generate_response(
        self,
        action: str,
        language: str,
        context: str = "",
        data: Optional[Dict[str, Any]] = None,
    ) -> str:
        if not settings.openai_api_key:
            return self._fallback(action, language)

        try:
            from openai import AsyncOpenAI

            client = AsyncOpenAI(api_key=settings.openai_api_key)
            prompt = (
                "You are a friendly Sri Lankan recruitment assistant. "
                "Use simple natural wording and keep core terms in English: Job, CV, Apply, Agency, Upload, Experience. "
                "Never output technical error messages. "
                f"Action: {action}. Language: {language}. Context: {context}. Data: {json.dumps(data or {}, ensure_ascii=False)}."
            )
            resp = await client.chat.completions.create(
                model=settings.llm_primary_model or "gpt-4o",
                temperature=0.6,
                messages=[{"role": "system", "content": prompt}],
                max_completion_tokens=180,
            )
            text = (resp.choices[0].message.content or "").strip()
            return text or self._fallback(action, language)
        except Exception as exc:
            logger.warning("response_service fell back due to error: %s", exc)
            return self._fallback(action, language)

    def _fallback(self, action: str, language: str) -> str:
        if action == "recover_conversation":
            if language == "si":
                return "hari, oyata job ekak apply karanna da, vacancies balanna da, nathnam prasnayak ahanna da?"
            if language == "ta":
                return "sari, neenga velai-ku apply panna venduma, vacancies paaka venduma, illa oru kelvi kekka venduma?"
            return "Do you want to Apply for a Job, View Vacancies, or Ask a Question?"
        return "Let us continue."


response_service = ResponseService()
