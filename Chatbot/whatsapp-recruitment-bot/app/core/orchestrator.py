"""Deterministic modular intake orchestrator (no legacy fallback)."""

from __future__ import annotations

import logging
import re
from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app import crud
from app.agents.intake_agent import intake_agent
from app.agents.recovery_agent import recovery_agent
from app.config import settings
from app.services.intent_service import classify_message
from app.services.cv_service import cv_service
from app.services.language_service import language_service
from app.services.handoff_service import handoff_service
from app.services.job_matching_service import job_matching_service
from app.services.recruitment_sync import recruitment_sync
from app.services.vacancy_service import vacancy_service
from app.utils.candidate_validator import run_ai_supervisor

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

        # AI supervisor rewrite: one-pass extraction, intent, intervention, and reply.
        history_items = []
        for conv in reversed(crud.get_conversation_history(db, candidate.id, limit=6)):
            role = "assistant" if str(conv.message_type.value) == "bot" else "user"
            content = str(conv.message_text or "").strip()
            if content:
                history_items.append({"role": role, "content": content})

        ai_decision = await run_ai_supervisor(
            user_text=message_text,
            history=history_items,
            force_applying=bool(state.get("cv_uploaded")),
        )

        collected = state.get("collected_data") if isinstance(state.get("collected_data"), dict) else {}
        if ai_decision.extracted_name:
            candidate.name = ai_decision.extracted_name
        if ai_decision.experience_years is not None:
            try:
                years = int(ai_decision.experience_years)
                candidate.experience_years = years
                collected["experience_years"] = years
            except Exception:
                pass
        if ai_decision.job_interest:
            collected["job_role"] = ai_decision.job_interest

        state["collected_data"] = collected

        if ai_decision.intervention_needed:
            candidate.intervention_needed = True
            candidate.intervention_reason = "AI detected user frustration or explicit request."
            state["handoff_flag"] = True
            candidate.handoff_flag = True
            self._save_agent_state(candidate, state)
            await handoff_service.notify(candidate, reason="ai_intervention_needed")
            crud.update_candidate_state(db, candidate.id, "human_handoff")
            candidate.conversation_state = "human_handoff"
            db.commit()
            return ai_decision.reply_message

        if candidate.name and candidate.experience_years is not None:
            try:
                await recruitment_sync.push(candidate, db)
            except Exception as exc:
                logger.warning("Recruitment sync failed during AI supervisor flow: %s", exc)

        resolved_language = language_service.resolve_language(
            user_text=message_text,
            locked_language=state.get("locked_language"),
        )
        self._apply_language_lock(db, candidate, state, resolved_language)
        self._save_agent_state(candidate, state)
        db.commit()

        return ai_decision.reply_message

        # Priority 1: CV/media messages are handled in webhook media branches.
        # Text branch uses classifier + deterministic orchestration.
        analysis = await classify_message(message_text)
        self._merge_entities_from_analysis(state, analysis, message_text)
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
                crud.update_candidate_state(db, candidate.id, "human_handoff")
                candidate.conversation_state = "human_handoff"
            db.commit()
            if candidate.handoff_flag:
                return self._handoff_prompt(candidate)
            return self._recovery_prompt(candidate)

        state["confusion_count"] = 0
        candidate.handoff_flag = False
        self._save_agent_state(candidate, state)
        db.commit()

        # Deterministic modular routing.
        if analysis.intent == "apply_job" or analysis.intent == "greeting":
            return await self._route_apply_flow(db, candidate, state)

        if analysis.intent == "view_jobs":
            return await self._route_view_jobs(candidate, state)

        if analysis.intent == "ask_question":
            return await self._route_question(candidate, message_text, state)

        if analysis.intent == "upload_cv":
            return self._cv_prompt(candidate)

        return self._recovery_prompt(candidate)

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

        if media_type not in {"document", "image"}:
            return self._recovery_prompt(candidate)

        extracted = await cv_service.process_cv(
            file_content=media_content,
            filename=media_filename or ("cv.jpg" if media_type == "image" else "cv.pdf"),
            media_url=media_url,
        )

        state["cv_uploaded"] = True
        state["step"] = "cv_received"
        collected = state.get("collected_data") if isinstance(state.get("collected_data"), dict) else {}
        collected.update({k: v for k, v in extracted.items() if v is not None})
        state["collected_data"] = collected
        self._save_agent_state(candidate, state)
        db.commit()

        return await self._route_apply_flow(db, candidate, state)

    async def _route_apply_flow(self, db: Session, candidate, state: Dict[str, Any]) -> str:
        next_field = intake_agent.next_missing_field(state)
        if next_field == "job_role":
            state["step"] = "collecting_job_role"
            crud.update_candidate_state(db, candidate.id, "intake_collecting_job_role")
            candidate.conversation_state = "intake_collecting_job_role"
        elif next_field == "country":
            state["step"] = "collecting_country"
            crud.update_candidate_state(db, candidate.id, "intake_collecting_country")
            candidate.conversation_state = "intake_collecting_country"
        elif next_field == "experience_years":
            state["step"] = "collecting_experience"
            crud.update_candidate_state(db, candidate.id, "intake_collecting_experience")
            candidate.conversation_state = "intake_collecting_experience"
        else:
            state["step"] = "intake_ready_for_matching"
            crud.update_candidate_state(db, candidate.id, "intake_ready_for_matching")
            candidate.conversation_state = "intake_ready_for_matching"

        self._save_agent_state(candidate, state)
        db.commit()

        if next_field == "country":
            return self._country_prompt(candidate)
        if next_field == "experience_years":
            return self._experience_prompt(candidate)
        if next_field is None:
            try:
                await recruitment_sync.push(candidate, db)
            except Exception as exc:
                logger.warning("Recruitment sync failed during modular flow: %s", exc)
            jobs_payload = await self._route_view_jobs(candidate, state)
            if isinstance(jobs_payload, dict):
                return jobs_payload
            return "Great. Your profile is ready."

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
            crud.update_candidate_state(db, candidate.id, "intake_collecting_experience")
            candidate.conversation_state = "intake_collecting_experience"
            db.commit()
            return self._experience_prompt(candidate)
        return await self._route_apply_flow(db, candidate, state)

    def _is_structured_interactive_token(self, text: str) -> bool:
        return bool(re.match(r"^(job_\d+|action_apply|action_question)$", text or ""))

    def _merge_entities_from_analysis(self, state: Dict[str, Any], analysis, user_text: str) -> None:
        collected = state.get("collected_data")
        if not isinstance(collected, dict):
            collected = {}
            state["collected_data"] = collected

        if analysis.job_role and not collected.get("job_role"):
            collected["job_role"] = analysis.job_role
        if analysis.country and not collected.get("country"):
            collected["country"] = analysis.country

        experience_value = None
        if analysis.experience:
            experience_value = self._parse_multilingual_experience(str(analysis.experience))
        if experience_value is None:
            experience_value = self._parse_multilingual_experience(user_text or "")

        current_step = str(state.get("step") or "")
        expects_experience = current_step in {"collecting_experience", "intake_collecting_experience"}
        if experience_value is not None and (not collected.get("experience_years") or expects_experience):
            collected["experience_years"] = int(experience_value)

    def _parse_multilingual_experience(self, text: str) -> Optional[int]:
        if not text:
            return None

        digit_map = str.maketrans("෦෧෨෩෪෫෬෭෮෯௦௧௨௩௪௫௬௭௮௯", "01234567890123456789")
        normalized = text.translate(digit_map).lower()

        scoped = re.search(
            r"\b(\d{1,2})\b\s*(year|years|yr|yrs|avurudu|awurudu|varudam|varusham|வருடம்|ஆண்டு|අවුරුදු)",
            normalized,
        )
        if scoped:
            return int(scoped.group(1))

        tokens = re.findall(r"[\w\u0B80-\u0DFF]+", normalized)
        word_map = {
            "eka": 1,
            "deka": 2,
            "dekai": 2,
            "rendu": 2,
            "irandu": 2,
            "thuna": 3,
            "naangu": 4,
            "paha": 5,
            "anju": 5,
            "haya": 6,
            "aaru": 6,
            "hatha": 7,
            "ezhu": 7,
            "ata": 8,
            "ettu": 8,
            "navaya": 9,
            "onbadhu": 9,
            "dahaya": 10,
            "pathu": 10,
            "එක": 1,
            "එකයි": 1,
            "දෙක": 2,
            "දෙකයි": 2,
            "තුන": 3,
            "හතර": 4,
            "පහ": 5,
            "හය": 6,
            "හත": 7,
            "අට": 8,
            "නවය": 9,
            "දහය": 10,
            "ஒன்று": 1,
            "ஒரு": 1,
            "இரண்டு": 2,
            "ரெண்டு": 2,
            "மூன்று": 3,
            "நான்கு": 4,
            "ஐந்து": 5,
            "ஆறு": 6,
            "ஏழு": 7,
            "எட்டு": 8,
            "ஒன்பது": 9,
            "பத்து": 10,
        }
        for token in tokens:
            if token in word_map:
                return int(word_map[token])

        plain_digit = re.search(r"\b(\d{1,2})\b", normalized)
        if plain_digit:
            return int(plain_digit.group(1))

        return None

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
        state["reply_register"] = detected_language
        if not state.get("locked_language") or state.get("locked_language") != detected_language:
            state["locked_language"] = detected_language
            self._save_agent_state(candidate, state)
            try:
                crud.update_candidate_language(db, candidate.id, detected_language)
            except Exception as exc:
                logger.debug("Language lock update fallback: %s", exc)

    def _save_agent_state(self, candidate, state: Dict[str, Any]) -> None:
        # Avoid sharing the same MutableDict instance across two JSON columns.
        # Reusing one mutable object for both `agent_state` and `extracted_data["agent_state"]`
        # can cause SQLAlchemy mutation tracking errors in production.
        safe_state = dict(state or {})
        candidate.agent_state = dict(safe_state)

        extracted = dict(candidate.extracted_data or {})
        extracted["agent_state"] = dict(safe_state)
        candidate.extracted_data = extracted

    def _recovery_prompt(self, candidate) -> str:
        lang = getattr(candidate.language_preference, "value", "en")
        return recovery_agent.recovery_prompt(lang)


intake_orchestrator = IntakeOrchestrator()
