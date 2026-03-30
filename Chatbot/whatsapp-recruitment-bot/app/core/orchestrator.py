"""Deterministic intake orchestrator with legacy-safe fallback."""

from __future__ import annotations

import logging
import re
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app import crud
from app.agents.intake_agent import intake_agent
from app.agents.recovery_agent import recovery_agent
from app.chatbot import chatbot
from app.config import settings
from app.services.intent_service import classify_message
from app.services.language_service import language_service
from app.services.handoff_service import handoff_service
from app.services.job_matching_service import job_matching_service
from app.services.vacancy_service import vacancy_service

logger = logging.getLogger(__name__)


class IntakeOrchestrator:
    """Core brain that routes candidate messages with explicit priorities."""

    async def process_text_message(
        self,
        db: Session,
        phone_number: str,
        message_text: str,
        source_message_type: str = "text",
    ) -> Any:
        candidate = crud.get_or_create_candidate(db, phone_number)
        state = self._ensure_agent_state(candidate)
        interactive_text = (message_text or "").strip().lower()

        if self._is_structured_interactive_token(interactive_text):
            state["confusion_count"] = 0
            candidate.handoff_flag = False
            self._save_agent_state(candidate, state)
            db.commit()
            return await self._route_interactive_action(db, candidate, state, interactive_text)

        # Priority 1: CV/media messages are handled in webhook media branches.
        # Text branch uses classifier + deterministic orchestration.
        analysis = await classify_message(message_text)
        self._merge_entities_from_analysis(state, analysis)
        resolved_language = language_service.resolve_language(
            user_text=message_text,
            locked_language=state.get("locked_language"),
        )
        self._apply_language_lock(db, candidate, state, resolved_language)
        candidate.confidence_score = float(analysis.confidence)

        if analysis.intent == "gibberish" or analysis.is_gibberish:
            state["confusion_count"] = int(state.get("confusion_count", 0)) + 1
            self._save_agent_state(candidate, state)
            if state["confusion_count"] >= settings.handoff_confusion_threshold:
                state["handoff_flag"] = True
                candidate.handoff_flag = True
                self._save_agent_state(candidate, state)
                await handoff_service.notify(candidate, reason="confusion_threshold")
                crud.update_candidate_state(db, candidate.id, chatbot.STATE_HUMAN_HANDOFF)
                candidate.conversation_state = chatbot.STATE_HUMAN_HANDOFF
            db.commit()
            if candidate.handoff_flag:
                return self._handoff_prompt(candidate)
            return self._recovery_prompt(candidate)

        state["confusion_count"] = 0
        candidate.handoff_flag = False
        self._save_agent_state(candidate, state)
        db.commit()

        # Deterministic routing with controlled handoff to legacy path.
        if analysis.intent == "apply_job" or analysis.intent == "greeting":
            return await self._route_apply_flow(db, candidate, state)

        if analysis.intent == "view_jobs":
            return await self._route_view_jobs(candidate, state)

        if analysis.intent == "ask_question":
            return await self._route_question(candidate, message_text, state)

        if analysis.intent == "upload_cv":
            return await chatbot.process_message(
                db=db,
                phone_number=phone_number,
                message_text=message_text,
                source_message_type=source_message_type,
            )

        return await chatbot.process_message(
            db=db,
            phone_number=phone_number,
            message_text=message_text,
            source_message_type=source_message_type,
        )

    async def process_media_message(
        self,
        db: Session,
        phone_number: str,
        media_content: bytes,
        media_type: str,
        media_filename: Optional[str] = None,
        media_url: Optional[str] = None,
        source_message_type: str = "document",
    ) -> Any:
        """CV/media priority interrupt path for modular mode."""
        candidate = crud.get_or_create_candidate(db, phone_number)
        state = self._ensure_agent_state(candidate)

        if media_type in {"document", "image"}:
            state["cv_uploaded"] = True
            state["step"] = "cv_received"
            self._save_agent_state(candidate, state)
            db.commit()

        return await chatbot.process_message(
            db=db,
            phone_number=phone_number,
            media_content=media_content,
            media_type=media_type,
            media_filename=media_filename,
            media_url=media_url,
            source_message_type=source_message_type,
        )

    async def _route_apply_flow(self, db: Session, candidate, state: Dict[str, Any]) -> str:
        next_field = intake_agent.next_missing_field(state)
        if next_field == "job_role":
            state["step"] = "collecting_job_role"
            crud.update_candidate_state(db, candidate.id, chatbot.STATE_AWAITING_JOB)
            candidate.conversation_state = chatbot.STATE_AWAITING_JOB
        elif next_field == "country":
            state["step"] = "collecting_country"
            crud.update_candidate_state(db, candidate.id, chatbot.STATE_AWAITING_COUNTRY)
            candidate.conversation_state = chatbot.STATE_AWAITING_COUNTRY
        elif next_field == "experience_years":
            state["step"] = "collecting_experience"
            crud.update_candidate_state(db, candidate.id, chatbot.STATE_AWAITING_EXPERIENCE)
            candidate.conversation_state = chatbot.STATE_AWAITING_EXPERIENCE
        else:
            state["step"] = "awaiting_cv"
            crud.update_candidate_state(db, candidate.id, chatbot.STATE_AWAITING_CV)
            candidate.conversation_state = chatbot.STATE_AWAITING_CV

        self._save_agent_state(candidate, state)
        db.commit()

        if next_field == "country":
            return self._country_prompt(candidate)
        if next_field == "experience_years":
            return self._experience_prompt(candidate)
        if next_field is None:
            return self._cv_prompt(candidate)

        lang = getattr(candidate.language_preference, "value", "en")
        return intake_agent.job_role_prompt(lang)

    async def _route_view_jobs(self, candidate, state: Dict[str, Any]) -> Dict[str, Any]:
        collected = state.get("collected_data", {}) if isinstance(state.get("collected_data"), dict) else {}
        ranked = await job_matching_service.get_ranked_matches(
            job_role=collected.get("job_role"),
            country=collected.get("country"),
            candidate_skills=collected.get("skills") if isinstance(collected.get("skills"), list) else [],
            experience_years=collected.get("experience_years"),
            limit=5,
        )
        state["step"] = "vacancy_browsing"
        self._save_agent_state(candidate, state)

        rows = []
        for idx, job in enumerate(ranked):
            title = str(job.get("title") or "Job").strip()[:24] or "Job"
            country = ""
            countries = job.get("countries") or []
            if countries:
                country = str(countries[0])
            desc = (country or str(job.get("category") or "Open position"))[:72]
            rows.append({
                "id": f"job_{idx}",
                "title": title,
                "description": desc,
            })

        if not rows:
            return {
                "type": "buttons",
                "body_text": "No active vacancies right now. Do you want to continue with a direct application?",
                "buttons": [
                    {"id": "action_apply", "title": "Apply"},
                    {"id": "action_question", "title": "Ask"},
                ],
            }

        return {
            "type": "list",
            "body_text": "Here are relevant vacancies. Select one to continue your application.",
            "button_label": "View Jobs",
            "sections": [{"title": "Available Vacancies", "rows": rows}],
        }

    async def _route_question(self, candidate, user_text: str, state: Dict[str, Any]) -> str:
        state["step"] = "answering_questions"
        self._save_agent_state(candidate, state)
        language = getattr(candidate.language_preference, "value", "en")
        return await vacancy_service.search_and_refine(
            user_message=user_text,
            language=language,
            entities={},
            candidate_info={"phone": candidate.phone_number},
        )

    async def _route_interactive_action(self, db: Session, candidate, state: Dict[str, Any], action: str) -> Any:
        if action == "action_apply":
            return await self._route_apply_flow(db, candidate, state)
        if action == "action_question":
            return await self._route_question(candidate, "", state)
        if re.match(r"^job_\d+$", action):
            state["step"] = "collecting_experience"
            self._save_agent_state(candidate, state)
            crud.update_candidate_state(db, candidate.id, chatbot.STATE_AWAITING_EXPERIENCE)
            candidate.conversation_state = chatbot.STATE_AWAITING_EXPERIENCE
            db.commit()
            return self._experience_prompt(candidate)
        return await self._route_apply_flow(db, candidate, state)

    def _is_structured_interactive_token(self, text: str) -> bool:
        return bool(re.match(r"^(job_\d+|action_apply|action_question)$", text or ""))

    def _merge_entities_from_analysis(self, state: Dict[str, Any], analysis) -> None:
        collected = state.get("collected_data")
        if not isinstance(collected, dict):
            collected = {}
            state["collected_data"] = collected

        if analysis.job_role and not collected.get("job_role"):
            collected["job_role"] = analysis.job_role
        if analysis.country and not collected.get("country"):
            collected["country"] = analysis.country
        if analysis.experience and not collected.get("experience_years"):
            match = re.search(r"\d+", str(analysis.experience))
            collected["experience_years"] = int(match.group(0)) if match else analysis.experience

    def _country_prompt(self, candidate) -> str:
        lang = getattr(candidate.language_preference, "value", "en")
        return intake_agent.country_prompt(lang)

    def _experience_prompt(self, candidate) -> str:
        lang = getattr(candidate.language_preference, "value", "en")
        return intake_agent.experience_prompt(lang)

    def _cv_prompt(self, candidate) -> str:
        lang = getattr(candidate.language_preference, "value", "en")
        return intake_agent.cv_prompt(lang)

    def _handoff_prompt(self, candidate) -> str:
        lang = getattr(candidate.language_preference, "value", "en")
        return recovery_agent.handoff_prompt(lang)

    def _ensure_agent_state(self, candidate) -> Dict[str, Any]:
        state = candidate.agent_state if isinstance(candidate.agent_state, dict) else None
        if state is None:
            extracted = candidate.extracted_data or {}
            state = extracted.get("agent_state") if isinstance(extracted.get("agent_state"), dict) else None
        if not isinstance(state, dict):
            state = {
                "step": "entry",
                "cv_uploaded": False,
                "collected_data": {},
                "confusion_count": 0,
                "handoff_flag": False,
                "locked_language": None,
            }
            self._save_agent_state(candidate, state)
        return state

    def _apply_language_lock(self, db: Session, candidate, state: Dict[str, Any], detected_language: str) -> None:
        if not detected_language:
            return
        if not state.get("locked_language") or state.get("locked_language") != detected_language:
            state["locked_language"] = detected_language
            self._save_agent_state(candidate, state)
            try:
                crud.update_candidate_language(db, candidate.id, detected_language)
            except Exception as exc:
                logger.debug("Language lock update fallback: %s", exc)

    def _save_agent_state(self, candidate, state: Dict[str, Any]) -> None:
        candidate.agent_state = state
        extracted = candidate.extracted_data or {}
        extracted["agent_state"] = state
        candidate.extracted_data = extracted

    def _recovery_prompt(self, candidate) -> str:
        lang = getattr(candidate.language_preference, "value", "en")
        return recovery_agent.recovery_prompt(lang)


intake_orchestrator = IntakeOrchestrator()
