"""request_cv — flag that the bot is now waiting for the candidate's CV."""

from __future__ import annotations

from typing import Any, Dict


REQUEST_CV_SCHEMA: Dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "request_cv",
        "description": (
            "Mark the conversation as waiting for the candidate's CV. The "
            "next media upload (PDF/image) will be processed as their CV. "
            "Call this when all mandatory text fields are collected and the "
            "candidate has not yet uploaded a CV."
        ),
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "reason": {
                    "type": "string",
                    "enum": ["first_ask", "gentle_nudge", "reupload_low_quality"],
                    "description": "Why you're asking — first time, follow-up, or asking for a clearer copy."
                }
            },
            "required": ["reason"]
        }
    }
}


async def handle_request_cv(args: Dict[str, Any], ctx) -> Dict[str, Any]:
    state = ctx.state
    reason = (args.get("reason") or "first_ask").strip()

    if state.get("cv_uploaded"):
        return {"status": "already_uploaded", "reason": reason}

    state["awaiting_cv"] = True
    state["last_cv_request_reason"] = reason
    state["last_cv_request_turn"] = ctx.current_turn_number

    return {"status": "ok", "reason": reason}
