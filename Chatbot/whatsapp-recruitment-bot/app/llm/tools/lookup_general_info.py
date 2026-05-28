"""lookup_general_info — live backend search for company / FAQ facts."""

from __future__ import annotations

import logging
import time
from typing import Any, Dict, Tuple

import httpx

from app.config import settings

logger = logging.getLogger(__name__)


LOOKUP_GENERAL_INFO_SCHEMA: Dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "lookup_general_info",
        "description": (
            "Search the company knowledge base for a non-job question — "
            "registration fees, office hours, address, hotline, application "
            "process, payment terms, contract length, return-to-Sri-Lanka "
            "support, etc. Returns up to 3 matching FAQs in the locked "
            "language. Do NOT use this for job-specific salary or country "
            "questions — those go through `lookup_job_info`."
        ),
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Plain-text question or topic to look up."
                }
            },
            "required": ["query"]
        }
    }
}


_CACHE: Dict[Tuple[str, str], Tuple[float, Dict[str, Any]]] = {}
_CACHE_TTL_SECONDS = 60.0


def _cache_get(key: Tuple[str, str]) -> Dict[str, Any] | None:
    hit = _CACHE.get(key)
    if not hit:
        return None
    ts, payload = hit
    if time.time() - ts > _CACHE_TTL_SECONDS:
        _CACHE.pop(key, None)
        return None
    return payload


def _cache_put(key: Tuple[str, str], payload: Dict[str, Any]) -> None:
    _CACHE[key] = (time.time(), payload)


async def handle_lookup_general_info(args: Dict[str, Any], ctx) -> Dict[str, Any]:
    query = (args.get("query") or "").strip()
    if not query:
        return {"status": "error", "detail": "query is required"}

    lang = (ctx.locked_language or "en").lower()
    if lang not in ("en", "si", "ta"):
        # Singlish/Tanglish reuse the English KB row but should still get
        # native answers — the system prompt already enforces the register.
        lang = "en"

    key = (query.lower(), lang)
    cached = _cache_get(key)
    if cached is not None:
        return cached

    url = f"{settings.recruitment_api_url.rstrip('/')}/api/chatbot/general-info"
    headers = {"x-chatbot-api-key": settings.chatbot_api_key or ""}

    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.get(url, headers=headers, params={"q": query, "lang": lang})
    except Exception as exc:    # noqa: BLE001
        logger.warning("lookup_general_info HTTP error: %s", exc)
        return {"status": "error", "detail": "backend unreachable"}

    if resp.status_code >= 300:
        return {"status": "error", "detail": f"backend {resp.status_code}"}

    body = resp.json() or {}
    results = body.get("results") or []
    payload = {
        "status": "ok",
        "query": query,
        "language": lang,
        "results": [
            {
                "category": r.get("category"),
                "question": r.get("question"),
                "answer": r.get("answer"),
            }
            for r in results[:3]
        ],
    }
    _cache_put(key, payload)
    return payload
