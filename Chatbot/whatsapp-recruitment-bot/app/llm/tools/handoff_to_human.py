"""handoff_to_human — escalate the conversation to a recruiter."""

from __future__ import annotations

import logging
from typing import Any, Dict

from app.services.handoff_service import handoff_service

logger = logging.getLogger(__name__)


HANDOFF_TO_HUMAN_SCHEMA: Dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "handoff_to_human",
        "description": (
            "Escalate to a human recruiter. Call this when the candidate "
            "explicitly asks for a person, sounds clearly frustrated, or "
            "presents a complex case you can't reasonably handle (e.g. "
            "they're a returnee with prior placement disputes). The bot "
            "will freeze for this candidate until a recruiter clears the "
            "flag, so do NOT use this casually."
        ),
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "reason": {
                    "type": "string",
                    "enum": [
                        "user_requested",
                        "frustration",
                        "complex_case",
                        "repeated_misunderstanding",
                    ]
                },
                "notes": {
                    "type": "string",
                    "description": "Free-form context for the recruiter (one or two sentences)."
                }
            },
            "required": ["reason", "notes"]
        }
    }
}


async def handle_handoff_to_human(args: Dict[str, Any], ctx) -> Dict[str, Any]:
    state = ctx.state
    candidate = ctx.candidate
    reason = (args.get("reason") or "user_requested").strip()
    notes = (args.get("notes") or "").strip()

    already_flagged = bool(getattr(candidate, "intervention_needed", False))

    try:
        setattr(candidate, "intervention_needed", True)
    except Exception as exc:    # noqa: BLE001
        logger.warning("Couldn't set intervention_needed on candidate: %s", exc)

    state["handoff_flag"] = True
    state["handoff_reason"] = reason
    state["handoff_notes"] = notes
    state["handoff_at_turn"] = ctx.current_turn_number
    state["step"] = "human_handoff"
    try:
        candidate.conversation_state = "human_handoff"
    except Exception:    # noqa: BLE001
        pass

    if not already_flagged:
        try:
            await handoff_service.notify(candidate, reason=reason)
        except Exception as exc:    # noqa: BLE001
            logger.warning("handoff_service.notify failed: %s", exc)

    return {"status": "ok", "reason": reason}
