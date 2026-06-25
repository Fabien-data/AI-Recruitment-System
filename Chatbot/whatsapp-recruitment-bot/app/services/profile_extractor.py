"""
Profile-extraction safety net.

Runs ONE cheap LLM pass over the recent transcript at completion time to backfill
structured candidate fields that the per-turn `record_field` tool missed — e.g.
a candidate who said "I have 20 years Sri Lanka Army and 5 years Qatar security"
(→ experience_years 25, previous_employer ...) without the agent recording it.

Only fills fields that are currently empty; never overwrites captured values.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict

from openai import AsyncOpenAI

from app import crud
from app.config import settings

logger = logging.getLogger(__name__)

_client: AsyncOpenAI | None = None

# Fields we attempt to backfill (the high-value, recruiter-facing ones).
_TARGET = ["experience_years", "age", "height_cm", "skills", "previous_employer", "licenses", "country"]


def _get_client() -> AsyncOpenAI | None:
    global _client
    if _client is None:
        key = settings.openai_api_key or os.getenv("OPENAI_API_KEY")
        if not key:
            return None
        _client = AsyncOpenAI(api_key=key)
    return _client


async def backfill(candidate, db, state: Dict[str, Any]) -> Dict[str, Any]:
    """Fill missing target fields from the transcript. Returns the filled subset."""
    collected = state.get("collected_data") if isinstance(state.get("collected_data"), dict) else {}
    missing = [f for f in _TARGET if collected.get(f) in (None, "", [])]
    if not missing:
        return {}

    client = _get_client()
    if client is None:
        return {}

    try:
        rows = crud.get_conversation_history(db, candidate.id, limit=20)
    except Exception as exc:    # noqa: BLE001
        logger.debug("profile backfill: history load failed: %s", exc)
        return {}

    convo = []
    for r in reversed(list(rows)):
        txt = (getattr(r, "message_text", "") or "").strip()
        if not txt:
            continue
        mt = getattr(r, "message_type", None)
        mt_val = str(getattr(mt, "value", mt) or "").lower()
        who = "Candidate" if mt_val in ("user", "inbound") else "Agent"
        convo.append(f"{who}: {txt}")
    if not convo:
        return {}
    transcript = "\n".join(convo[-30:])

    prompt = (
        "From this recruitment WhatsApp chat, extract ONLY the candidate fields listed "
        "as missing, and ONLY if the candidate clearly stated them (in any language: "
        "English, Sinhala, Tamil, Singlish, Tanglish). Omit anything not clearly stated. "
        "If they mention multiple jobs/stints, SUM the years into experience_years.\n\n"
        f"MISSING FIELDS: {missing}\n\n"
        "Return a JSON object using only these keys when present: "
        "experience_years (integer), age (integer), height_cm (integer), "
        "skills (array of short strings), previous_employer (string), "
        "licenses (string), country (string).\n\n"
        f"CHAT:\n{transcript}"
    )

    try:
        resp = await client.chat.completions.create(
            model=getattr(settings, "classifier_model", "gpt-4o-mini"),
            messages=[
                {"role": "system", "content": "You extract structured recruitment fields. Return valid JSON only."},
                {"role": "user", "content": prompt},
            ],
            response_format={"type": "json_object"},
            temperature=0.0,
        )
        data = json.loads(resp.choices[0].message.content or "{}")
    except Exception as exc:    # noqa: BLE001
        logger.warning("profile backfill LLM call failed: %s", exc)
        return {}

    filled: Dict[str, Any] = {}
    for f in missing:
        v = data.get(f)
        if v in (None, "", []):
            continue
        if f == "skills":
            new_items = v if isinstance(v, list) else [s.strip() for s in str(v).split(",") if s.strip()]
            existing = collected.get("skills")
            existing = existing if isinstance(existing, list) else []
            lower = {e.lower() for e in existing}
            for s in new_items:
                s = str(s).strip()
                if s and s.lower() not in lower:
                    existing.append(s)
                    lower.add(s.lower())
            collected["skills"] = existing[:25]
            filled["skills"] = collected["skills"]
        elif f in ("experience_years", "age", "height_cm"):
            try:
                iv = int(float(v))
            except Exception:
                continue
            collected[f] = iv
            filled[f] = iv
            if f == "age" and getattr(candidate, "age", None) in (None, 0):
                candidate.age = iv
            if f == "experience_years" and candidate.experience_years is None:
                candidate.experience_years = iv
        else:
            collected[f] = v
            filled[f] = v

    state["collected_data"] = collected
    if filled:
        logger.info("profile backfill filled %s for %s", list(filled.keys()), getattr(candidate, "phone_number", "?"))
    return filled
