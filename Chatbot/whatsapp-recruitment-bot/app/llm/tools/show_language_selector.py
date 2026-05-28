"""show_language_selector — emit the trilingual language-buttons payload."""

from __future__ import annotations

from typing import Any, Dict


SHOW_LANGUAGE_SELECTOR_SCHEMA: Dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "show_language_selector",
        "description": (
            "Send the WhatsApp language-selection buttons (English / සිංහල / "
            "தமிழ்). Call this only when the candidate has NOT yet locked a "
            "language — almost always just the very first contact, before "
            "any other tool call. The orchestrator handles the actual button "
            "rendering; this tool just signals intent."
        ),
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "properties": {}
        }
    }
}


async def handle_show_language_selector(args: Dict[str, Any], ctx) -> Dict[str, Any]:
    state = ctx.state
    # Marker the orchestrator reads after the tool loop to inject the
    # interactive button payload instead of a plain text reply.
    state["pending_language_selector"] = True
    state["ad_flow_step"] = "awaiting_language"
    return {"status": "ok"}
