"""Natural-language response generator for modular orchestration actions."""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, Optional

from app.config import settings

logger = logging.getLogger(__name__)


class ResponseService:
    """Generate user-facing responses from high-level actions."""

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
                model=settings.llm_primary_model or "gpt-5",
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
