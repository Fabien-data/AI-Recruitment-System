"""suggest_alternative_job — offer the candidate a better-fit role."""

from __future__ import annotations

from typing import Any, Dict


SUGGEST_ALTERNATIVE_JOB_SCHEMA: Dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "suggest_alternative_job",
        "description": (
            "Gently suggest an alternative active job that fits the candidate "
            "better. The HARD RULE: this MUST NOT be called before "
            "TURNS_SINCE_MISMATCH_DETECTED reaches 2 (the MISMATCH_HINT in "
            "the system prompt tells you when it is allowed). The handler "
            "refuses early calls with status='too_early'."
        ),
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "job_id": {
                    "type": "string",
                    "description": "UUID of the alternative job — must be in ACTIVE_JOBS."
                },
                "reason": {
                    "type": "string",
                    "enum": [
                        "skill_mismatch",
                        "country_mismatch",
                        "age_mismatch",
                        "experience_mismatch",
                    ],
                    "description": "Why the candidate fits the alternative better than the original."
                },
                "transition_phrasing": {
                    "type": "string",
                    "description": (
                        "The gentle one-sentence pivot you will send to the "
                        "candidate immediately after this tool call returns."
                    )
                }
            },
            "required": ["job_id", "reason", "transition_phrasing"]
        }
    }
}


async def handle_suggest_alternative_job(args: Dict[str, Any], ctx) -> Dict[str, Any]:
    state = ctx.state
    job_id = (args.get("job_id") or "").strip()
    reason = (args.get("reason") or "").strip()
    transition = (args.get("transition_phrasing") or "").strip()

    if not job_id or not reason:
        return {"status": "error", "detail": "job_id and reason are required"}

    turns_since = int(state.get("turns_since_mismatch_detected") or 0)
    if turns_since < 2:
        return {
            "status": "too_early",
            "turns_since_mismatch_detected": turns_since,
            "detail": "Cross-suggestion gate requires at least 2 turns of advocating the original job first."
        }

    offers = state.setdefault("alternatives_offered", [])
    # Refuse if we've already offered this job and it wasn't declined.
    for prior in offers:
        if prior.get("job_id") == job_id and prior.get("outcome") != "declined":
            return {
                "status": "already_offered",
                "job_id": job_id,
                "outcome": prior.get("outcome"),
            }

    offers.append({
        "job_id": job_id,
        "reason": reason,
        "offered_at_turn": ctx.current_turn_number,
        "outcome": "pending",
        "transition_phrasing": transition,
    })
    # Reset the mismatch counter — we just acted on it. The next turn will
    # re-detect mismatch only if the candidate keeps the original job and the
    # numbers still don't line up.
    state["turns_since_mismatch_detected"] = 0

    return {"status": "ok", "job_id": job_id, "reason": reason}
