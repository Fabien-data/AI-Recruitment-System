"""
Pre-CRM-sync AI validation pass.

Before ``recruitment_sync.push()`` writes a candidate row to the CRM, this
service runs ONE more LLM call that re-reads the conversation transcript and
the collected fields, returning a structured payload that scores every
required field with confidence + source + source_turn_id, and flags
inconsistencies (e.g. user said 2 years but CV said 5).

The conversation agent only invokes ``recruitment_sync.push()`` when
``ready_to_sync == True``. Otherwise the agent asks one targeted clarifying
question per issue (max 2 rounds — after that, sync goes through with
``intervention_needed = True`` and the issues are persisted into
``applications.screening_details`` so a recruiter can finish the review.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict, List, Optional

from openai import AsyncOpenAI

from app import crud
from app.config import settings
from app.llm.schemas import (
    ValidatedCandidatePayload,
    ValidatedField,
    ValidationIssue,
)

logger = logging.getLogger(__name__)


_client: Optional[AsyncOpenAI] = None
_HISTORY_LIMIT_FOR_VALIDATION = 30


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        api_key = settings.openai_api_key or os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise RuntimeError("OPENAI_API_KEY is not configured.")
        _client = AsyncOpenAI(api_key=api_key)
    return _client


_VALIDATION_SYSTEM_PROMPT = """\
You are a recruitment data-quality auditor for Dewan Consultants. You read a
WhatsApp candidate conversation and a structured `collected_data` dict, then
return a JSON object that scores every required field for the job.

You must:
- For each required field, return value + confidence (0.0–1.0) + source
  ("user" | "cv" | "ad_prefill") + source_turn_id (the turn id the value was
  first heard in, or null if unknown).
- Flag inconsistencies (e.g. user told you 2 years experience but the CV says
  5; user said Dubai but CV resume header says Qatar).
- Flag missing mandatory fields.
- Flag low-confidence answers (a value that was likely the user being
  flippant, dodging, or misunderstood).
- Set ready_to_sync = true only when all mandatory fields are present with
  confidence >= 0.7 AND no "inconsistent" issues remain.
- overall_confidence = mean of per-field confidences for mandatory fields.

Do NOT invent values. If you can't find a field in the transcript or the
collected_data, mark it missing (confidence 0.0).
"""


_VALIDATION_RESPONSE_SCHEMA: Dict[str, Any] = {
    "type": "json_schema",
    "json_schema": {
        "name": "ValidatedCandidatePayload",
        "strict": False,
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "fields": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {
                            "name": {"type": "string"},
                            "value": {},
                            "confidence": {"type": "number"},
                            "source": {
                                "type": "string",
                                "enum": ["user", "cv", "ad_prefill"],
                            },
                            "source_turn_id": {
                                "type": ["string", "null"],
                            },
                        },
                        "required": ["name", "value", "confidence", "source"],
                    },
                },
                "overall_confidence": {"type": "number"},
                "ready_to_sync": {"type": "boolean"},
                "issues": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "additionalProperties": False,
                        "properties": {
                            "field": {"type": "string"},
                            "kind": {
                                "type": "string",
                                "enum": [
                                    "low_confidence",
                                    "missing",
                                    "format",
                                    "inconsistent",
                                ],
                            },
                            "detail": {"type": "string"},
                        },
                        "required": ["field", "kind", "detail"],
                    },
                },
            },
            "required": ["fields", "overall_confidence", "ready_to_sync", "issues"],
        },
    },
}


def _required_fields(state: Dict[str, Any]) -> List[str]:
    ad_ctx = state.get("ad_context") or {}
    schema = (
        ad_ctx.get("required_fields_schema")
        or ad_ctx.get("chatbot_config", {}).get("required_fields_schema")
        or {}
    )
    if isinstance(schema, dict) and schema:
        mandatory = [
            k for k, v in schema.items()
            if isinstance(v, dict) and v.get("mandatory")
        ]
        if mandatory:
            return mandatory
    inferred = ad_ctx.get("required_fields") \
        or ad_ctx.get("chatbot_config", {}).get("required_fields") \
        or []
    if inferred:
        return list(inferred)
    return ["name", "experience_years"]


def _transcript_text(db: Any, candidate_id: Any) -> str:
    try:
        rows = crud.get_conversation_history(db, candidate_id, limit=_HISTORY_LIMIT_FOR_VALIDATION)
    except Exception as exc:    # noqa: BLE001
        logger.warning("Failed to load conversation history for validation: %s", exc)
        return ""
    lines = []
    for conv in reversed(list(rows)):
        text = (getattr(conv, "message_text", "") or "").strip()
        if not text:
            continue
        direction = (getattr(conv, "direction", "") or "").lower()
        role = "BOT" if direction in ("outbound", "bot", "assistant") else "CANDIDATE"
        lines.append(f"{role}: {text}")
    return "\n".join(lines)


class SyncValidator:
    async def validate(self, candidate: Any, db: Any) -> ValidatedCandidatePayload:
        state = getattr(candidate, "agent_state", None) or {}
        required = _required_fields(state)
        collected = state.get("collected_data") or {}
        ad_ctx = state.get("ad_context") or {}
        cv_parsed = ad_ctx.get("cv_parsed") or {}
        transcript = _transcript_text(db, candidate.id)
        confidences = state.get("field_confidences") or {}

        user_prompt = (
            "JOB CONTEXT (the candidate is being screened for this role):\n"
            f"  title: {ad_ctx.get('job_title')}\n"
            f"  job_id: {ad_ctx.get('job_id')}\n"
            f"  requirements: {json.dumps(ad_ctx.get('job_requirements') or {}, ensure_ascii=False)[:600]}\n\n"
            f"REQUIRED FIELDS (mandatory for this job): {required}\n\n"
            f"COLLECTED_DATA (so far): {json.dumps(collected, ensure_ascii=False, default=str)}\n\n"
            f"FIELD_CONFIDENCES (model's prior self-reports): {json.dumps(confidences, ensure_ascii=False, default=str)}\n\n"
            f"CV_PARSED: {json.dumps(cv_parsed, ensure_ascii=False, default=str)[:800]}\n\n"
            f"AD_PREFILL: job_interest={ad_ctx.get('job_title')!r}, ad_job_id={ad_ctx.get('job_id')!r}\n\n"
            f"TRANSCRIPT (newest last):\n{transcript[:4000]}\n\n"
            "Return the JSON payload now."
        )

        try:
            client = _get_client()
            resp = await client.chat.completions.create(
                model=settings.pre_sync_validator_model,
                messages=[
                    {"role": "system", "content": _VALIDATION_SYSTEM_PROMPT},
                    {"role": "user", "content": user_prompt},
                ],
                temperature=0.0,
                response_format=_VALIDATION_RESPONSE_SCHEMA,
            )
            raw = resp.choices[0].message.content or "{}"
            data = json.loads(raw)
        except Exception as exc:    # noqa: BLE001
            logger.warning("sync_validator LLM call failed: %s — falling back to permissive sync", exc)
            return self._permissive_fallback(required, collected)

        # Pydantic validates the shape; gracefully fall back if the model
        # returned slightly off-spec JSON.
        try:
            return ValidatedCandidatePayload(**data)
        except Exception as exc:    # noqa: BLE001
            logger.warning("sync_validator schema parse failed (%s) — using permissive fallback", exc)
            return self._permissive_fallback(required, collected)

    @staticmethod
    def _permissive_fallback(required: List[str], collected: Dict[str, Any]) -> ValidatedCandidatePayload:
        """Used when the validator LLM is unreachable — sync goes ahead but
        every field gets a low default confidence so a recruiter can review."""
        fields = []
        issues = []
        missing_any = False
        for f in required:
            v = collected.get(f)
            present = v not in (None, "", [])
            fields.append(ValidatedField(
                name=f, value=v, confidence=0.5 if present else 0.0,
                source="user", source_turn_id=None,
            ))
            if not present:
                missing_any = True
                issues.append(ValidationIssue(
                    field=f, kind="missing",
                    detail="Field missing in collected_data",
                ))
        return ValidatedCandidatePayload(
            fields=fields,
            overall_confidence=0.5 if not missing_any else 0.0,
            ready_to_sync=not missing_any,
            issues=issues,
        )


sync_validator = SyncValidator()
