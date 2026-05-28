"""lookup_job_info — live backend fetch for one job's details."""

from __future__ import annotations

import logging
import time
from typing import Any, Dict, Tuple

import httpx

from app.config import settings

logger = logging.getLogger(__name__)


LOOKUP_JOB_INFO_SCHEMA: Dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "lookup_job_info",
        "description": (
            "Look up a fresh fact about a specific job from the backend. "
            "Use when ACTIVE_JOBS / CURRENT_JOB_CONTEXT doesn't include the "
            "detail the candidate is asking about (rare — most details are "
            "already in the system prompt). Returns the requested field "
            "value verbatim from the CRM."
        ),
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "job_id": {
                    "type": "string",
                    "description": "UUID of the job to look up."
                },
                "field": {
                    "type": "string",
                    "enum": [
                        "salary", "benefits", "countries", "requirements",
                        "start_date", "interview_date", "positions_remaining",
                        "description", "full",
                    ],
                    "description": "Which field to return. Use 'full' to get the whole job record."
                }
            },
            "required": ["job_id", "field"]
        }
    }
}


# Process-local cache — 60s TTL keyed by (job_id, field). Bounds backend load
# when the model asks for the same fact several times in one conversation.
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


def _project_field(job: Dict[str, Any], field: str) -> Any:
    if field == "full":
        return job
    if field == "salary":
        return job.get("salary_range") or job.get("salary_info")
    if field == "benefits":
        return job.get("benefits")
    if field == "countries":
        return job.get("countries")
    if field == "requirements":
        return job.get("requirements")
    if field == "start_date":
        return job.get("start_date")
    if field == "interview_date":
        return job.get("interview_date")
    if field == "positions_remaining":
        return job.get("positions_available")
    if field == "description":
        return job.get("description")
    return None


async def handle_lookup_job_info(args: Dict[str, Any], ctx) -> Dict[str, Any]:
    job_id = (args.get("job_id") or "").strip()
    field = (args.get("field") or "").strip()
    if not job_id or not field:
        return {"status": "error", "detail": "job_id and field are required"}

    cached = _cache_get((job_id, field))
    if cached is not None:
        return cached

    url = f"{settings.recruitment_api_url.rstrip('/')}/api/chatbot/job-info/{job_id}"
    headers = {"x-chatbot-api-key": settings.chatbot_api_key or ""}

    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.get(url, headers=headers)
    except Exception as exc:    # noqa: BLE001
        logger.warning("lookup_job_info HTTP error: %s", exc)
        return {"status": "error", "detail": "backend unreachable"}

    if resp.status_code == 404:
        result = {"status": "not_found", "job_id": job_id}
        _cache_put((job_id, field), result)
        return result
    if resp.status_code >= 300:
        return {"status": "error", "detail": f"backend {resp.status_code}"}

    job = resp.json() or {}
    value = _project_field(job, field)
    result = {
        "status": "ok",
        "job_id": job_id,
        "field": field,
        "value": value,
        "title": job.get("title"),
    }
    _cache_put((job_id, field), result)
    return result
