"""
General-info client — pulls company/FAQ facts live from the backend.

Replaces the hardcoded multilingual FAQ block previously baked into
``app/llm/prompt_templates.py::FAQ_TOPICS`` and the
``_get_company_faq_block()`` helper in candidate_validator.py. The chatbot
no longer ships any FAQ text in code; everything is fetched on demand from
``GET /api/chatbot/general-info?q=...`` and cached process-locally for 60s.

This service is what ``app/llm/tools/lookup_general_info.py`` thinly wraps,
but it's also called directly by orchestrator code paths that need a default
packet (e.g. the application-complete reply needs the office address).
"""

from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Optional, Tuple

import httpx

from app.config import settings

logger = logging.getLogger(__name__)


_CACHE: Dict[Tuple[str, str], Tuple[float, List[Dict[str, Any]]]] = {}
_CACHE_TTL_SECONDS = 60.0


class GeneralInfoService:
    async def fetch(self, query: str, lang: str = "en") -> List[Dict[str, Any]]:
        normalized_lang = lang if lang in ("en", "si", "ta") else "en"
        key = ((query or "").lower().strip(), normalized_lang)

        hit = _CACHE.get(key)
        if hit and time.time() - hit[0] <= _CACHE_TTL_SECONDS:
            return hit[1]

        url = f"{settings.recruitment_api_url.rstrip('/')}/api/chatbot/general-info"
        headers = {"x-chatbot-api-key": settings.chatbot_api_key or ""}
        params: Dict[str, Any] = {"lang": normalized_lang}
        if query:
            params["q"] = query

        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                resp = await client.get(url, headers=headers, params=params)
        except Exception as exc:    # noqa: BLE001
            logger.warning("general-info HTTP error: %s", exc)
            return []

        if resp.status_code >= 300:
            logger.warning("general-info backend returned %s", resp.status_code)
            return []

        body = resp.json() or {}
        results = body.get("results") or []
        _CACHE[key] = (time.time(), results)
        return results

    async def default_packet(self, lang: str = "en") -> Dict[str, str]:
        """Convenience accessor for the address / hotline / fee fallback."""
        rows = await self.fetch(query="", lang=lang)
        # The backend's empty-query fallback returns these three by ID.
        packet = {"address": "", "hotline": "", "registration_fee": ""}
        for r in rows:
            rid = (r.get("id") or r.get("category") or "").lower()
            answer = (r.get("answer") or "").strip()
            if "address" in rid and not packet["address"]:
                packet["address"] = answer
            elif "hotline" in rid and not packet["hotline"]:
                packet["hotline"] = answer
            elif "fee" in rid and not packet["registration_fee"]:
                packet["registration_fee"] = answer
        return packet


general_info_service = GeneralInfoService()
