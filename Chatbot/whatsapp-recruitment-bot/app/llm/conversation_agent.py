"""
GPT-5.5 conversation agent — the single brain that drives every user turn.

Replaces the legacy ``candidate_validator.run_ai_supervisor`` +
``agent_router.route_user_message`` split. One call per user message:

  1. Assemble the per-turn system prompt (with STATE / CURRENT_JOB_CONTEXT /
     ACTIVE_JOBS / MISMATCH_HINT).
  2. Call OpenAI chat.completions with the tool registry.
  3. Loop: execute any tool calls the model emitted, append tool_result
     messages, call the model again. Hard cap of 4 rounds per turn.
  4. Apply silent overrides (no-repeat guard, language stickiness).
  5. Return the final user-facing text the orchestrator should send.

The orchestrator stays thin — it owns webhook IO, language-button routing,
state persistence — but the actual recruitment dialogue lives here.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from typing import Any, Dict, List, Optional, Tuple

from openai import AsyncOpenAI

from app import crud
from app.config import settings
from app.knowledge import get_job_cache

from .system_prompt import build_system_prompt
from .tools import TOOL_HANDLERS, TOOL_SCHEMAS, ToolContext, dispatch

logger = logging.getLogger(__name__)


_MAX_TOOL_ROUNDS = 4
_HISTORY_LIMIT = 15

_client: Optional[AsyncOpenAI] = None


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        api_key = settings.openai_api_key or os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise RuntimeError("OPENAI_API_KEY is not configured.")
        _client = AsyncOpenAI(api_key=api_key)
    return _client


# ---------------------------------------------------------------------------
# Context assembly helpers
# ---------------------------------------------------------------------------


def _required_fields_for(state: Dict[str, Any]) -> List[str]:
    """Pull the mandatory field names for the current job."""
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
    # Fallback list comes from the backend's inferRequiredFields() and is
    # already in ad_ctx.chatbot_config.required_fields.
    inferred = ad_ctx.get("required_fields") \
        or ad_ctx.get("chatbot_config", {}).get("required_fields") \
        or []
    if inferred:
        return list(inferred)
    # Last-resort safety net for cold-path conversations with no ad context.
    return ["name", "experience_years"]


# Cap on how many advertised jobs we list in the system prompt. Bounds token
# spend if many campaigns run at once; the cross-suggestion ranker still
# considers the full cache, so a deeper match isn't lost by this display cap.
_ACTIVE_JOBS_PROMPT_CAP = 10


def _active_jobs_summary() -> List[Dict[str, Any]]:
    """Return the active+advertised jobs from the in-memory cache (newest first).

    The cache is populated from /api/chatbot/jobs which only returns jobs with
    a live ad campaign, so this is the set the bot may discuss with cold
    candidates and suggest as alternatives.
    """
    cache = get_job_cache() or {}
    active = [
        j for j in cache.values()
        if (j.get("status") or "").lower() == "active"
        and j.get("has_active_ad", True)
    ]
    active.sort(
        key=lambda j: j.get("created_at") or j.get("updated_at") or "",
        reverse=True,
    )
    out = []
    for j in active[:_ACTIVE_JOBS_PROMPT_CAP]:
        out.append({
            "job_id": j.get("job_id") or j.get("id"),
            "title": j.get("title"),
            "category": j.get("category"),
            "countries": j.get("countries") or [],
            "requirements": j.get("requirements") or {},
            "positions_available": j.get("positions_available"),
        })
    return out


def _current_job_for(state: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Resolve the job the candidate is currently being screened for."""
    ad_ctx = state.get("ad_context") or {}
    if ad_ctx and ad_ctx.get("job_id"):
        return ad_ctx
    active_id = state.get("active_job_id")
    if active_id:
        cache = get_job_cache() or {}
        return cache.get(active_id)
    # Cold path with no active_job_id yet — let the model decide from
    # ACTIVE_JOBS by asking the candidate.
    return None


def _build_history(db: Any, candidate_id: Any) -> List[Dict[str, str]]:
    """Last N turns as plain {role, content} dicts — no tool_result replay."""
    out: List[Dict[str, str]] = []
    try:
        rows = crud.get_conversation_history(db, candidate_id, limit=_HISTORY_LIMIT)
    except Exception as exc:    # noqa: BLE001
        logger.warning("Failed to load conversation history: %s", exc)
        return out
    for conv in reversed(list(rows)):
        text = (getattr(conv, "message_text", "") or "").strip()
        if not text:
            continue
        direction = (getattr(conv, "direction", "") or "").lower()
        if direction in ("outbound", "bot", "assistant"):
            role = "assistant"
        else:
            role = "user"
        out.append({"role": role, "content": text})
    return out


def _next_missing_field(required: List[str], collected: Dict[str, Any]) -> Optional[str]:
    for f in required:
        v = collected.get(f)
        if v in (None, "", []):
            return f
    return None


# ---------------------------------------------------------------------------
# No-repeat safety net — runs AFTER the model returns its final text. If the
# model proposed asking a field that's already answered, we silently rewrite
# the reply by replacing the question with the next genuinely missing field.
# This used to live in orchestrator._force_pick; it moves here so the rest of
# the orchestrator can stay model-agnostic.
# ---------------------------------------------------------------------------


def _apply_no_repeat_guard(
    reply_text: str,
    state: Dict[str, Any],
    required: List[str],
) -> Tuple[str, Optional[str]]:
    """Return (possibly-rewritten reply, override_reason or None)."""
    if not reply_text:
        return reply_text, None
    collected = state.get("collected_data") or {}
    log = state.get("asked_questions_log") or []
    if not log:
        return reply_text, None

    last_entry = log[-1]
    last_field = last_entry.get("field")
    if not last_field:
        return reply_text, None

    # If the LAST question we asked is still pending AND the field IS already
    # in collected_data, the model is asking a question that's already
    # answered — silently nudge it onto the next missing one. We don't fully
    # rewrite the sentence (we can't guess phrasing); instead we annotate so
    # the orchestrator can emit a short re-prompt.
    if (
        last_entry.get("answered_value") in (None, "")
        and collected.get(last_field) not in (None, "", [])
    ):
        next_field = _next_missing_field(required, collected)
        if next_field and next_field != last_field:
            return reply_text, f"silent_pivot:{last_field}->{next_field}"
    return reply_text, None


# ---------------------------------------------------------------------------
# Mismatch hint — wraps cross_suggestion_service so the system prompt has
# direct access to the gate decision.
# ---------------------------------------------------------------------------


async def _build_mismatch_hint(state: Dict[str, Any], current_job: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    try:
        from app.services.cross_suggestion_service import cross_suggestion_service
        return await cross_suggestion_service.build_hint(state, current_job)
    except Exception as exc:    # noqa: BLE001
        logger.debug("cross_suggestion_service.build_hint failed: %s", exc)
        return {"status": "no_mismatch"}


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


async def run_turn(
    *,
    candidate: Any,
    db: Any,
    state: Dict[str, Any],
    locked_language: str,
    user_message: str,
) -> Dict[str, Any]:
    """
    Drive one conversational turn end-to-end.

    Returns a dict the orchestrator unpacks:
        {
            "reply_text": str | None,
            "interactive": dict | None,   # button payload if show_language_selector fired
            "terminal": bool,             # True if handoff or mark_complete synced
            "override_reason": str | None,
            "tool_calls": list[dict],     # diagnostic record
        }
    """
    turn_id = uuid.uuid4().hex[:12]
    state["turn_counter"] = int(state.get("turn_counter") or 0) + 1
    turn_number = state["turn_counter"]

    required = _required_fields_for(state)
    active_jobs = _active_jobs_summary()
    current_job = _current_job_for(state)
    mismatch_hint = await _build_mismatch_hint(state, current_job)

    # Track mismatch turn counter — increment when hint is "too_early".
    if mismatch_hint.get("status") == "too_early":
        state["turns_since_mismatch_detected"] = int(
            state.get("turns_since_mismatch_detected") or 0
        ) + 1
    elif mismatch_hint.get("status") == "no_mismatch":
        state["turns_since_mismatch_detected"] = 0

    system_prompt = build_system_prompt({
        "locked_language": locked_language,
        "phone": getattr(candidate, "phone_number", ""),
        "collected_data": state.get("collected_data") or {},
        "required_fields": required,
        "asked_questions_log": state.get("asked_questions_log") or [],
        "cv_uploaded": bool(state.get("cv_uploaded")),
        "turns_since_mismatch": int(state.get("turns_since_mismatch_detected") or 0),
        "alternatives_offered": state.get("alternatives_offered") or [],
        "current_job": current_job,
        "active_jobs": active_jobs,
        "mismatch_hint": mismatch_hint,
    })

    history = _build_history(db, candidate.id)
    messages: List[Dict[str, Any]] = [{"role": "system", "content": system_prompt}]
    messages.extend(history)
    messages.append({"role": "user", "content": user_message or ""})

    ctx = ToolContext(
        candidate=candidate,
        state=state,
        db=db,
        locked_language=locked_language,
        current_turn_id=turn_id,
        current_turn_number=turn_number,
    )

    client = _get_client()
    diagnostic_calls: List[Dict[str, Any]] = []
    interactive_payload: Optional[Dict[str, Any]] = None
    terminal = False
    final_text: Optional[str] = None

    for round_idx in range(_MAX_TOOL_ROUNDS):
        resp = await client.chat.completions.create(
            model=settings.chat_model,
            messages=messages,
            tools=TOOL_SCHEMAS,
            tool_choice="auto",
            temperature=0.4,
        )
        choice = resp.choices[0]
        msg = choice.message
        # Persist this assistant turn in the running messages array so the
        # next round (if any) sees the same context.
        assistant_msg: Dict[str, Any] = {
            "role": "assistant",
            "content": msg.content or "",
        }
        if msg.tool_calls:
            assistant_msg["tool_calls"] = [
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {
                        "name": tc.function.name,
                        "arguments": tc.function.arguments,
                    },
                }
                for tc in msg.tool_calls
            ]
        messages.append(assistant_msg)

        if not msg.tool_calls:
            final_text = (msg.content or "").strip()
            break

        for tc in msg.tool_calls:
            name = tc.function.name
            try:
                args = json.loads(tc.function.arguments or "{}")
            except json.JSONDecodeError:
                args = {}
            try:
                result = await dispatch(name, args, ctx)
            except Exception as exc:    # noqa: BLE001
                logger.exception("Tool %s crashed: %s", name, exc)
                result = {"status": "error", "detail": str(exc)}
            diagnostic_calls.append({"name": name, "args": args, "result": result})
            messages.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": json.dumps(result, ensure_ascii=False, default=str),
            })

            if name == "show_language_selector" and result.get("status") == "ok":
                # We'll let the orchestrator pull the actual button payload
                # from app.services.ad_intake_flow.language_selector_payload.
                interactive_payload = {"kind": "language_selector"}
            if name == "handoff_to_human" and result.get("status") == "ok":
                terminal = True
            if name == "mark_complete" and result.get("status") in (
                "synced", "intervention_needed"
            ):
                terminal = True

        if terminal:
            # Give the model one more chance to produce the user-facing
            # acknowledgment after a terminal tool, but don't keep looping.
            resp = await client.chat.completions.create(
                model=settings.chat_model,
                messages=messages,
                temperature=0.4,
            )
            final_text = (resp.choices[0].message.content or "").strip()
            break
    else:
        # Loop exited via for/else — hit the round cap. Use whatever the last
        # assistant message had.
        final_text = (messages[-1].get("content") or "").strip() if messages else None
        logger.warning(
            "conversation_agent hit max tool rounds (%s) for candidate %s",
            _MAX_TOOL_ROUNDS, getattr(candidate, "id", "?"),
        )

    # No-repeat safety net (runs only if we have a plain-text reply).
    override_reason: Optional[str] = None
    if final_text:
        final_text, override_reason = _apply_no_repeat_guard(final_text, state, required)
        if override_reason and override_reason.startswith("silent_pivot:"):
            # Append the next-field hint inline so the candidate isn't stuck.
            _, _, transition = override_reason.partition(":")
            _, _, next_field = transition.partition("->")
            final_text = (
                f"{final_text.rstrip(' ?.')}.\n"
                f"(Internal: next field to ask is {next_field}.)"
            )

    # Track the question we just asked (best-effort: field name picked from
    # the next missing slot). If the agent didn't ask anything because it
    # called mark_complete, skip.
    if final_text and not terminal:
        next_missing = _next_missing_field(
            required, state.get("collected_data") or {}
        )
        if next_missing:
            log = state.setdefault("asked_questions_log", [])
            log.append({
                "turn": turn_number,
                "field": next_missing,
                "phrasing": final_text,
                "answered_value": None,
                "ts": None,
            })
            if len(log) > 50:
                del log[: len(log) - 50]

    return {
        "reply_text": final_text,
        "interactive": interactive_payload,
        "terminal": terminal,
        "override_reason": override_reason,
        "tool_calls": diagnostic_calls,
        "turn_id": turn_id,
    }
