"""record_field — persist a single extracted candidate field."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict

from app.utils.field_validators import validate

logger = logging.getLogger(__name__)


RECORD_FIELD_SCHEMA: Dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "record_field",
        "description": (
            "Record a single piece of candidate information the user just gave you. "
            "Call this BEFORE composing your reply for any answer that names a "
            "value (name, age, country, experience years, email, passport number, "
            "etc.). One call per field — call multiple times if the user volunteered "
            "several values in one message."
        ),
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "name": {
                    "type": "string",
                    "enum": [
                        "name", "age", "email", "country", "countries",
                        "experience_years", "passport_number", "nic",
                        "date_of_birth", "english_proficiency", "licenses",
                        "previous_employer", "job_role", "height_cm",
                        "alternative_phone",
                    ],
                    "description": "Which field this value belongs to."
                },
                "value": {
                    "type": "string",
                    "description": (
                        "The raw value as the user said it (e.g. 'twenty-eight', "
                        "'Dubai', 'two years'). Canonicalization happens server-side."
                    )
                },
                "source_turn_id": {
                    "type": "string",
                    "description": "Pass back the current turn id from the system prompt."
                },
                "confidence": {
                    "type": "number",
                    "minimum": 0.0,
                    "maximum": 1.0,
                    "description": (
                        "Your own confidence that this is a correct, well-formed "
                        "answer for this field. Low confidence triggers a clarifying "
                        "follow-up at sync time."
                    )
                }
            },
            "required": ["name", "value"]
        }
    }
}


# Fields that should be mirrored onto the Candidate ORM row (in addition to
# state.collected_data) so the CRM sees them on the next reconciliation.
_MIRRORED_FIELDS = {"name", "email", "age", "experience_years", "country"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def handle_record_field(args: Dict[str, Any], ctx) -> Dict[str, Any]:
    name = (args.get("name") or "").strip()
    raw_value = args.get("value")
    confidence = float(args.get("confidence") or 0.85)
    source_turn_id = args.get("source_turn_id") or ctx.current_turn_id

    if not name:
        return {"status": "error", "detail": "missing name"}
    if raw_value is None or raw_value == "":
        return {"status": "error", "detail": "missing value"}

    state = ctx.state
    collected = state.setdefault("collected_data", {})

    # Canonicalize via the existing validators registry. Falls back to
    # validate_generic which just trims and length-checks.
    result = validate(name, str(raw_value))
    if not result.ok:
        # Don't write a bad value to collected_data — but DO mark that we
        # observed an attempt, so the agent doesn't loop on the same field.
        log_entry = {
            "turn": ctx.current_turn_number,
            "field": name,
            "phrasing": None,
            "answered_value": None,
            "raw_attempt": str(raw_value),
            "validation_hint": result.hint,
            "ts": _now_iso(),
        }
        state.setdefault("asked_questions_log", []).append(log_entry)
        return {
            "status": "rejected",
            "field": name,
            "hint": result.hint,
            "detail": "value failed validation — re-ask with a hint"
        }

    canonical = result.value
    # If we already have the exact same value, treat as a no-op so the agent
    # doesn't double-count or re-bill validators.
    if collected.get(name) == canonical:
        return {"status": "noop", "field": name, "value": canonical}

    collected[name] = canonical
    state["collected_data"] = collected

    # Mirror common fields onto the ORM so the candidate row stays accurate
    # even if the next sync is deferred.
    if name in _MIRRORED_FIELDS and hasattr(ctx.candidate, name):
        try:
            setattr(ctx.candidate, name, canonical)
        except Exception as exc:    # noqa: BLE001
            logger.warning("Failed to mirror %s onto candidate ORM: %s", name, exc)

    # Backfill the most recent matching ASKED log entry. If none exists, append
    # a fresh "answered without being asked" row so the model still sees it.
    log = state.setdefault("asked_questions_log", [])
    backfilled = False
    for entry in reversed(log):
        if entry.get("field") == name and entry.get("answered_value") in (None, ""):
            entry["answered_value"] = canonical
            entry["ts"] = entry.get("ts") or _now_iso()
            backfilled = True
            break
    if not backfilled:
        log.append({
            "turn": ctx.current_turn_number,
            "field": name,
            "phrasing": None,
            "answered_value": canonical,
            "ts": _now_iso(),
        })
    # Cap the log at the last 50 entries.
    if len(log) > 50:
        del log[: len(log) - 50]

    # Store confidence on a parallel map for sync_validator to consult.
    confidences = state.setdefault("field_confidences", {})
    confidences[name] = {
        "confidence": confidence,
        "source": "user",
        "source_turn_id": source_turn_id,
    }

    # Early partial-lead sync: the moment we capture a name, persist the
    # candidate to the CRM (phone is always known from WhatsApp) so the lead is
    # never lost if they drop off. push() is idempotent on phone and saves
    # unknown-job leads to the general pool; later syncs enrich the same row.
    if name == "name" and not state.get("early_synced") and not state.get("cv_synced"):
        try:
            from app.services.recruitment_sync import recruitment_sync
            await recruitment_sync.push(ctx.candidate, ctx.db, cv_path=None)
            state["early_synced"] = True
        except Exception as exc:    # noqa: BLE001
            logger.warning("Early partial-lead sync failed: %s", exc)

    return {
        "status": "ok",
        "field": name,
        "value": canonical,
        "confidence": confidence,
    }
