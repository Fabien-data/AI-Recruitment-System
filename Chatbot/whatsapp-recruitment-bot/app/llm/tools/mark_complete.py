"""mark_complete — run pre-sync AI validation and (if green) push to CRM."""

from __future__ import annotations

import logging
from typing import Any, Dict

logger = logging.getLogger(__name__)


MARK_COMPLETE_SCHEMA: Dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "mark_complete",
        "description": (
            "Call this when every required field for the current job is "
            "collected AND a CV has been uploaded. Triggers a final AI "
            "validation pass; on green it syncs the candidate to the CRM. "
            "On amber it returns issues you must clarify with the user. "
            "Do not call before both conditions are met."
        ),
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "summary": {
                    "type": "string",
                    "description": (
                        "One-sentence summary of the candidate (used in the "
                        "branded application-complete reply if sync succeeds)."
                    )
                }
            },
            "required": ["summary"]
        }
    }
}


async def handle_mark_complete(args: Dict[str, Any], ctx) -> Dict[str, Any]:
    state = ctx.state

    if state.get("cv_synced"):
        return {"status": "already_synced"}

    # Lazy imports to avoid circular dependencies — both sync_validator and
    # recruitment_sync import from app.llm.schemas which this package owns.
    from app.services.sync_validator import sync_validator
    from app.services.recruitment_sync import recruitment_sync

    # Safety net: backfill any details the per-turn tools missed (e.g. summed
    # multi-stint experience, licenses, employers) from the transcript before
    # the final validation + sync. Best-effort — never blocks completion.
    try:
        from app.services.profile_extractor import backfill as _profile_backfill
        await _profile_backfill(ctx.candidate, ctx.db, state)
    except Exception as exc:    # noqa: BLE001
        logger.debug("profile backfill skipped: %s", exc)

    validation = await sync_validator.validate(ctx.candidate, ctx.db)
    state["validation"] = validation.model_dump()

    if not validation.ready_to_sync:
        # Surface the most urgent issues so the agent can ask one clarifying
        # question. Capped at 3 to keep the prompt focused.
        issues = [i.model_dump() for i in validation.issues[:3]]
        # Track clarification attempts so we don't loop forever.
        attempts = int(state.get("validation_clarify_attempts") or 0) + 1
        state["validation_clarify_attempts"] = attempts
        if attempts <= 2:
            return {
                "status": "needs_clarification",
                "summary": args.get("summary"),
                "issues": issues,
                "attempts": attempts,
            }
        # Two clarification rounds exhausted — sync anyway with
        # intervention_needed so a recruiter can sort it out.
        try:
            setattr(ctx.candidate, "intervention_needed", True)
        except Exception as exc:    # noqa: BLE001
            logger.warning("Couldn't set intervention_needed: %s", exc)
        try:
            await recruitment_sync.push(ctx.candidate, ctx.db, cv_path=None)
            state["cv_synced"] = True
            state["step"] = "completed"
        except Exception as exc:    # noqa: BLE001
            logger.error("recruitment_sync.push failed during forced sync: %s", exc)
            return {"status": "sync_failed", "error": str(exc)}
        return {
            "status": "intervention_needed",
            "issues": issues,
            "summary": args.get("summary"),
        }

    try:
        await recruitment_sync.push(ctx.candidate, ctx.db, cv_path=None)
    except Exception as exc:    # noqa: BLE001
        logger.error("recruitment_sync.push failed: %s", exc)
        return {"status": "sync_failed", "error": str(exc)}

    state["cv_synced"] = True
    state["step"] = "completed"
    return {
        "status": "synced",
        "summary": args.get("summary"),
        "overall_confidence": validation.overall_confidence,
    }
