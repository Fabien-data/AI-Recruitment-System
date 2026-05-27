"""Deterministic state machine for ad-sourced WhatsApp candidates.

A user who taps a Dewan job ad arrives with ``START:<job_uuid>`` already in
their first message. From that moment we want a strict, predictable flow:

    1. Language selection (buttons, native scripts)
    2. Branded welcome that names the specific job the user clicked
    3. Name → then each mandatory field from the job's
       ``required_fields_schema`` (validated, one-at-a-time, in order)
    4. CV upload
    5. Submission confirmation (creates the `applications` row downstream)

The AI supervisor still runs alongside this state machine — but only for
entity extraction (so "I'm 28" still fills the age slot) and FAQ grounding
(so off-topic questions get a short answer using ad_context_snippet). The
"what to ask next" decision is fully deterministic, which is what eliminates
the randomness the previous flow exhibited.

State lives in ``candidate.agent_state["ad_flow_step"]``:
    - ``awaiting_language``      → buttons sent, waiting for lang_ad_* reply
    - ``awaiting_field:<name>``  → currently prompting a specific field
    - ``awaiting_cv``            → all mandatory fields done, asking for CV
    - ``complete``               → application submitted; bot reverts to FAQ
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Tuple

from app.agents.intake_agent import intake_agent
from app.utils.field_validators import (
    ValidationResult,
    hint_text,
    validate_with_ai_hint,
)

logger = logging.getLogger(__name__)


LANG_BUTTON_IDS = {
    "lang_ad_en": "en",
    "lang_ad_si": "si",
    "lang_ad_ta": "ta",
}


class AdIntakeFlow:
    """Drives the per-job, deterministic onboarding for ad-sourced candidates."""

    # ─────────────────────────────────────────────────────────────────────
    # Entry: language selector
    # ─────────────────────────────────────────────────────────────────────
    def language_selector_payload(
        self,
        state: Dict[str, Any],
        job_title: str,
        country: str = "",
    ) -> Dict[str, Any]:
        """Return the trilingual welcome with 3 native-script language buttons.

        Stashes the pending welcome context (job_title + country) into state
        so we can render the personalised thank-you in the chosen language
        as soon as the user taps a button.
        """
        state["ad_flow_step"] = "awaiting_language"
        state["pending_job_welcome"] = {
            "job_title": job_title or "",
            "country": country or "",
        }
        return {
            "type": "buttons",
            "header_text": "Dewan Consultants",
            "body_text": (
                "Welcome to Dewan Consultants 🙏\n"
                "Dewan Consultants වෙත සාදරයෙන් පිළිගනිමු\n"
                "Dewan Consultants-க்கு வரவேற்கிறோம்\n\n"
                "Please choose your language / භාෂාව / மொழி:"
            ),
            "buttons": [
                {"id": "lang_ad_en", "title": "English"},
                {"id": "lang_ad_si", "title": "සිංහල"},
                {"id": "lang_ad_ta", "title": "தமிழ்"},
            ],
        }

    def is_language_button(self, action: str) -> bool:
        return action in LANG_BUTTON_IDS

    def language_for_button(self, action: str) -> str:
        return LANG_BUTTON_IDS.get(action, "en")

    # ─────────────────────────────────────────────────────────────────────
    # Post-language: welcome + first prompt in chosen language
    # ─────────────────────────────────────────────────────────────────────
    def welcome_and_first_prompt(
        self,
        state: Dict[str, Any],
        lang: str,
        pending: Optional[Dict[str, str]] = None,
    ) -> str:
        """Render the branded welcome (names the clicked job) followed by the
        first mandatory field's prompt. Both are sent as a single message so
        the user gets one tight greeting, not a chain of separate sends.

        Fallback: when there is NO ad context (candidate landed via the
        greeting fast-path without an ad), return the generic intake-agent
        name prompt instead of pretending we know which job they want. This
        keeps the legacy AI-driven flow intact for non-ad candidates even
        though the unified language-button IDs now route every tap through
        this same handler.
        """
        pending = pending or state.get("pending_job_welcome") or {}
        ad_ctx = state.get("ad_context") if isinstance(state.get("ad_context"), dict) else None
        has_ad_context = bool(ad_ctx) or bool(pending.get("job_title"))

        if not has_ad_context:
            # Non-ad candidate — keep them on the legacy AI flow. Clear any
            # stale ad-flow markers so the orchestrator's text path doesn't
            # later override AI behaviour for this candidate.
            state.pop("ad_flow_step", None)
            return intake_agent.name_prompt(lang)

        job_title = pending.get("job_title") or self._job_title_from_state(state)
        country = pending.get("country") or self._country_from_state(state)

        welcome = intake_agent.job_welcome_prompt(lang, job_title, country)

        # Resolve the first field that's actually missing — name is the
        # canonical first prompt but if name is somehow already collected
        # (e.g. AI extracted it from a verbose first message) we jump ahead.
        first_field = self._first_unsatisfied_field(state)
        if not first_field:
            # All mandatory fields somehow already filled — go straight to CV.
            state["ad_flow_step"] = "awaiting_cv"
            return f"{welcome}\n\n{intake_agent.cv_prompt(lang)}"

        state["ad_flow_step"] = f"awaiting_field:{first_field}"
        # When the first missing field IS name, the welcome already asks for
        # name — don't duplicate the question.
        if first_field == "name":
            return welcome
        prompt = intake_agent.get_prompt_for_field(first_field, lang)
        return f"{welcome}\n\n{prompt}"

    # ─────────────────────────────────────────────────────────────────────
    # Mid-flow: validate this turn's reply and advance
    # ─────────────────────────────────────────────────────────────────────
    def process_field_reply(
        self,
        state: Dict[str, Any],
        lang: str,
        user_text: str,
        ai_extracted: Optional[Any] = None,
        faq_answer: Optional[str] = None,
    ) -> str:
        """Validate the user's reply against the current field and emit the
        next message: either the next field's prompt, the CV ask, or a hint
        + re-ask. If the AI classified the turn as a FAQ (off-topic) and we
        have an answer to fold in, prepend it before the re-ask so the flow
        stays linear without ignoring the user."""
        current_field = self._current_field(state)
        if not current_field:
            # Shouldn't happen in normal flow — bail out gracefully.
            return intake_agent.cv_prompt(lang)

        result = validate_with_ai_hint(current_field, user_text, ai_extracted)
        collected = state.setdefault("collected_data", {})

        if result.ok:
            self._store_field(collected, current_field, result.value)
            state["collected_data"] = collected
            return self._advance(state, lang)

        # Invalid reply. If the AI handled this as a FAQ, share its answer +
        # re-ask the field in one message. Otherwise just hint and re-ask.
        hint = hint_text(result.hint or "generic_empty", lang)
        re_ask = intake_agent.get_prompt_for_field(current_field, lang)
        if faq_answer:
            return f"{faq_answer.strip()}\n\n{re_ask}"
        return f"{hint}\n\n{re_ask}"

    def re_ask_current(self, state: Dict[str, Any], lang: str) -> str:
        """Used when we want to re-prompt without validating (e.g. user sent
        a sticker / unsupported type for the field they're answering)."""
        current_field = self._current_field(state)
        if not current_field:
            return intake_agent.cv_prompt(lang)
        return intake_agent.get_prompt_for_field(current_field, lang)

    def cv_prompt(self, lang: str) -> str:
        return intake_agent.cv_prompt(lang)

    def is_awaiting_cv(self, state: Dict[str, Any]) -> bool:
        step = str(state.get("ad_flow_step") or "")
        return step in ("awaiting_cv", "awaiting_field:cv")

    def is_awaiting_field(self, state: Dict[str, Any]) -> bool:
        return str(state.get("ad_flow_step") or "").startswith("awaiting_field:")

    def is_complete(self, state: Dict[str, Any]) -> bool:
        return state.get("ad_flow_step") == "complete"

    def is_active(self, state: Dict[str, Any]) -> bool:
        """True whenever the ad-flow is steering the conversation."""
        step = str(state.get("ad_flow_step") or "")
        return step.startswith("awaiting_") or step == "complete"

    def completion_message(
        self,
        state: Dict[str, Any],
        lang: str,
    ) -> str:
        state["ad_flow_step"] = "complete"
        collected = state.get("collected_data") or {}
        name = collected.get("name") or ""
        job_title = self._job_title_from_state(state)
        return intake_agent.application_complete_prompt(lang, name, job_title)

    # ─────────────────────────────────────────────────────────────────────
    # Internal helpers
    # ─────────────────────────────────────────────────────────────────────
    def _current_field(self, state: Dict[str, Any]) -> Optional[str]:
        step = str(state.get("ad_flow_step") or "")
        if not step.startswith("awaiting_field:"):
            return None
        return step.split(":", 1)[1] or None

    def _mandatory_order(self, state: Dict[str, Any]) -> List[str]:
        """Mandatory field order from the picked job's schema, with sensible
        defaults if the schema is empty. Name is forced first so every
        candidate gets personalised early — matches existing intake_agent
        behaviour."""
        per_job = state.get("mandatory_fields")
        if isinstance(per_job, list) and per_job:
            order = [str(f) for f in per_job]
        else:
            order = ["name", "experience_years", "age", "email"]
        if "name" not in order:
            order = ["name", *order]
        else:
            order = ["name"] + [f for f in order if f != "name"]
        return order

    def _first_unsatisfied_field(self, state: Dict[str, Any]) -> Optional[str]:
        collected = state.get("collected_data") or {}
        for field in self._mandatory_order(state):
            if not self._field_satisfied(field, collected):
                return field
        return None

    def _field_satisfied(self, field: str, collected: Dict[str, Any]) -> bool:
        if field == "country":
            return bool(collected.get("country") or collected.get("countries"))
        if field == "countries":
            return bool(collected.get("countries") or collected.get("country"))
        value = collected.get(field)
        if isinstance(value, (int, float)):
            return value is not None
        return bool(value)

    def _store_field(
        self,
        collected: Dict[str, Any],
        field: str,
        value: Any,
    ) -> None:
        collected[field] = value
        # Keep the legacy single-country mirror in sync so downstream
        # services that read either key still resolve the value.
        if field == "countries" and isinstance(value, list) and value:
            collected.setdefault("country", value[0])
        elif field == "country" and not collected.get("countries"):
            collected["countries"] = [value]

    def _advance(self, state: Dict[str, Any], lang: str) -> str:
        """Move to the next mandatory field, or the CV ask, or completion."""
        next_field = self._first_unsatisfied_field(state)
        if next_field:
            state["ad_flow_step"] = f"awaiting_field:{next_field}"
            return intake_agent.get_prompt_for_field(next_field, lang)
        # Mandatory fields done — ask for CV unless one is already on file.
        if state.get("cv_uploaded"):
            return self.completion_message(state, lang)
        state["ad_flow_step"] = "awaiting_cv"
        return intake_agent.cv_prompt(lang)

    def _job_title_from_state(self, state: Dict[str, Any]) -> str:
        ad_ctx = state.get("ad_context") if isinstance(state.get("ad_context"), dict) else {}
        return (
            ad_ctx.get("job_title")
            or (state.get("collected_data") or {}).get("job_role")
            or "this role"
        )

    def _country_from_state(self, state: Dict[str, Any]) -> str:
        ad_ctx = state.get("ad_context") if isinstance(state.get("ad_context"), dict) else {}
        countries = ad_ctx.get("countries") or []
        if countries:
            return str(countries[0])
        collected = state.get("collected_data") or {}
        return collected.get("country") or ""


ad_intake_flow = AdIntakeFlow()
