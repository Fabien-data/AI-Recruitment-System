"""
Tool registry for the GPT-5.5 conversation agent.

Each tool has two parts:
1. A JSON schema in ``TOOL_SCHEMAS`` — sent to OpenAI as the ``tools=`` argument.
2. A handler in ``TOOL_HANDLERS`` — async callable ``(args: dict, ctx: ToolContext) -> dict``.

The agent loop in ``app.llm.conversation_agent`` calls ``dispatch(name, args, ctx)``
for every tool call the model emits, appends the JSON-encoded result back as a
``tool`` role message, and recurs until either the model returns a final
assistant message or a terminal tool (``mark_complete``, ``handoff_to_human``)
fires.

Handlers MUST be idempotent — Meta retries webhooks, and the agent loop itself
may retry a tool if the model called it twice in one turn by mistake.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, List, Optional

from .record_field import RECORD_FIELD_SCHEMA, handle_record_field
from .request_cv import REQUEST_CV_SCHEMA, handle_request_cv
from .mark_complete import MARK_COMPLETE_SCHEMA, handle_mark_complete
from .suggest_alternative_job import (
    SUGGEST_ALTERNATIVE_JOB_SCHEMA,
    handle_suggest_alternative_job,
)
from .handoff_to_human import (
    HANDOFF_TO_HUMAN_SCHEMA,
    handle_handoff_to_human,
)
from .lookup_job_info import LOOKUP_JOB_INFO_SCHEMA, handle_lookup_job_info
from .lookup_general_info import (
    LOOKUP_GENERAL_INFO_SCHEMA,
    handle_lookup_general_info,
)
from .show_language_selector import (
    SHOW_LANGUAGE_SELECTOR_SCHEMA,
    handle_show_language_selector,
)


@dataclass
class ToolContext:
    """Bundle of references each tool handler may need.

    Built fresh by ``conversation_agent.run_turn`` once per user message and
    passed unchanged through every tool call in that turn.
    """

    candidate: Any           # SQLAlchemy Candidate ORM instance
    state: Dict[str, Any]    # candidate.agent_state (mutable dict)
    db: Any                  # SQLAlchemy Session
    locked_language: str     # 'en' | 'si' | 'ta' | 'singlish' | 'tanglish'
    current_turn_id: str     # uuid for this user-message turn
    current_turn_number: int # monotonic per-conversation counter


TOOL_SCHEMAS: List[Dict[str, Any]] = [
    RECORD_FIELD_SCHEMA,
    REQUEST_CV_SCHEMA,
    MARK_COMPLETE_SCHEMA,
    SUGGEST_ALTERNATIVE_JOB_SCHEMA,
    HANDOFF_TO_HUMAN_SCHEMA,
    LOOKUP_JOB_INFO_SCHEMA,
    LOOKUP_GENERAL_INFO_SCHEMA,
    SHOW_LANGUAGE_SELECTOR_SCHEMA,
]


TOOL_HANDLERS: Dict[str, Callable[[Dict[str, Any], ToolContext], Awaitable[Dict[str, Any]]]] = {
    "record_field": handle_record_field,
    "request_cv": handle_request_cv,
    "mark_complete": handle_mark_complete,
    "suggest_alternative_job": handle_suggest_alternative_job,
    "handoff_to_human": handle_handoff_to_human,
    "lookup_job_info": handle_lookup_job_info,
    "lookup_general_info": handle_lookup_general_info,
    "show_language_selector": handle_show_language_selector,
}


# Tools whose successful return ends the turn — the agent should NOT call the
# model again after one of these fires. ``mark_complete`` either commits the
# CRM sync (terminal) or returns ``needs_clarification`` (the agent loops once
# more so the model can ask the targeted question), so it's only terminal when
# its return ``status`` is ``"synced"`` or ``"intervention_needed"``.
TERMINAL_TOOLS = {"handoff_to_human"}


async def dispatch(
    name: str,
    args: Dict[str, Any],
    ctx: ToolContext,
) -> Dict[str, Any]:
    handler = TOOL_HANDLERS.get(name)
    if handler is None:
        return {"status": "unknown_tool", "tool": name}
    return await handler(args or {}, ctx)
