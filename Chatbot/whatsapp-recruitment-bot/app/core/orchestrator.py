"""Deterministic modular intake orchestrator (no legacy fallback)."""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app import crud
from app.agents.intake_agent import intake_agent
from app.agents.recovery_agent import recovery_agent
from app.services.ad_context_service import ad_context_service
from app.services.ad_intake_flow import ad_intake_flow
from app.services.cv_service import cv_service
from app.services.language_service import language_service
from app.services.handoff_service import handoff_service
from app.services.intent_service import looks_like_faq_question
from app.services.job_matching_service import job_matching_service
from app.services.recruitment_sync import recruitment_sync
from app.services.vacancy_service import vacancy_service
from app.nlp.language_detector import detect_language_switch_request
from app.utils.candidate_validator import run_ai_supervisor

logger = logging.getLogger(__name__)


class IntakeOrchestrator:
    """Core brain that routes candidate messages with explicit priorities."""

    def _candidate_language(self, candidate) -> str:
        """Resolve candidate language safely across new and legacy schemas."""
        extracted = candidate.extracted_data if isinstance(candidate.extracted_data, dict) else {}
        register = extracted.get("language_register") or extracted.get("agent_state", {}).get("reply_register")
        if register:
            return str(register).lower()

        language_pref = getattr(candidate, "language_preference", None)
        language_value = getattr(language_pref, "value", language_pref)
        if language_value:
            return str(language_value).lower()

        legacy_pref = getattr(candidate, "preferred_language", None)
        legacy_value = getattr(legacy_pref, "value", legacy_pref)
        if legacy_value:
            return str(legacy_value).lower()

        return "en"

    def _conversation_role(self, conversation) -> str:
        """Map stored message type to LLM role without assuming Enum shape."""
        raw_type = getattr(conversation, "message_type", None)
        normalized = str(getattr(raw_type, "value", raw_type) or "").strip().lower()
        return "assistant" if normalized in {"bot", "assistant"} else "user"

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

        # Meta Click-to-WhatsApp ad trigger ("START:ad_ref_xyz"). Pre-fills
        # job_interest, country, and full ad context so we skip questions the
        # ad source already answers. Processed once per session.
        if not state.get("ad_processed") and ad_context_service.is_ad_trigger(message_text):
            ad_reply = await self._handle_ad_trigger(db, candidate, state, message_text)
            if ad_reply is not None:
                return ad_reply

        # Detect whether this message is an explicit language-switch request so
        # the lock can be updated; otherwise the existing lock is preserved.
        is_explicit_switch = bool(detect_language_switch_request(message_text or ""))
        resolved_language = language_service.resolve_language(
            user_text=message_text,
            locked_language=state.get("locked_language"),
        )
        prev_locked = state.get("locked_language")
        self._apply_language_lock(
            db, candidate, state, resolved_language, is_explicit_switch=is_explicit_switch
        )
        locked_language = state.get("locked_language") or resolved_language or "en"

        # Pass full context to AI supervisor so it knows what's already collected/asked.
        collected = state.get("collected_data") if isinstance(state.get("collected_data"), dict) else {}
        asked_questions = state.get("asked_questions") if isinstance(state.get("asked_questions"), list) else []
        asked_log = state.get("asked_questions_log") if isinstance(state.get("asked_questions_log"), list) else []
        prev_question = state.get("next_question_type")
        collected_before = dict(collected)

        # Build conversation history (last 15 messages for full context).
        history_items = []
        for conv in reversed(crud.get_conversation_history(db, candidate.id, limit=15)):
            role = self._conversation_role(conv)
            content = str(conv.message_text or "").strip()
            if content:
                history_items.append({"role": role, "content": content})

        # If the language just changed, inject a marker so the AI understands
        # why the register of historical messages differs from the current one.
        if is_explicit_switch and prev_locked and prev_locked != locked_language:
            history_items.append({
                "role": "system",
                "content": (
                    f"[Language preference updated to: {locked_language}. "
                    f"All replies from this point MUST be in {locked_language}.]"
                ),
            })

        # Build FAQ context whenever vacancies exist AND either (a) the user came
        # from an ad (ad_context present), or (b) the message looks like an FAQ.
        # Previously this was gated on full onboarding, which silently swallowed
        # early FAQ asks. Cap at 8 vacancies to stay inside the token budget.
        faq_context: Optional[str] = None
        ad_context_snippet: Optional[str] = None
        ad_context = state.get("ad_context") if isinstance(state.get("ad_context"), dict) else None
        wants_faq = bool(ad_context) or looks_like_faq_question(message_text)
        if wants_faq:
            try:
                vacancies = vacancy_service.get_all_vacancies()
                if vacancies:
                    lines = []
                    for v in vacancies[:8]:
                        title = v.get("job_title") or v.get("title") or "Unknown Role"
                        country = v.get("country") or v.get("location") or ""
                        if not country:
                            countries = v.get("countries") or []
                            if countries:
                                country = str(countries[0])
                        salary = v.get("salary_range") or v.get("salary") or ""
                        line = f"- {title} | {country}".rstrip(" |")
                        if salary:
                            line += f" | {salary}"
                        lines.append(line)
                    faq_context = "\n".join(lines)
            except Exception as _faq_exc:
                logger.debug("FAQ vacancy fetch skipped: %s", _faq_exc)

        if ad_context:
            ad_lines = []
            if ad_context.get("job_title"):
                ad_lines.append(f"Ad job: {ad_context['job_title']}")
            if ad_context.get("job_salary"):
                ad_lines.append(f"Salary: {ad_context['job_salary']}")
            if ad_context.get("client_name"):
                ad_lines.append(f"Client: {ad_context['client_name']}")
            if ad_context.get("interview_date"):
                ad_lines.append(f"Interview: {ad_context['interview_date']}")
            for faq in (ad_context.get("faqs") or [])[:3]:
                q = (faq.get("question") or "").strip()
                a = (faq.get("answer") or "").strip()
                if q and a:
                    ad_lines.append(f"FAQ — {q}: {a}")
            if ad_lines:
                ad_context_snippet = "\n".join(ad_lines)

        ai_decision = await run_ai_supervisor(
            user_text=message_text,
            history=history_items,
            force_applying=bool(state.get("cv_uploaded")),
            collected_data=collected,
            asked_questions=asked_questions,
            locked_language=locked_language,
            cv_just_uploaded=False,
            faq_context=faq_context,
            ad_context_snippet=ad_context_snippet,
            rephrase_mode=bool(state.get("rephrase_mode")),
            phone_number=phone_number,
        )

        # Merge extracted entities into collected_data and candidate model.
        if ai_decision.extracted_name and not candidate.name:
            candidate.name = ai_decision.extracted_name
        if ai_decision.extracted_name and not collected.get("name"):
            collected["name"] = ai_decision.extracted_name
        if ai_decision.experience_years is not None:
            try:
                years = int(ai_decision.experience_years)
                candidate.experience_years = years
                collected["experience_years"] = years
            except Exception:
                pass
        if ai_decision.extracted_age is not None:
            try:
                age_val = int(ai_decision.extracted_age)
                candidate.age = age_val
                collected["age"] = age_val
            except Exception:
                pass
        if ai_decision.extracted_email and not collected.get("email"):
            candidate.email = ai_decision.extracted_email
            collected["email"] = ai_decision.extracted_email
        if ai_decision.extracted_countries:
            collected["countries"] = ai_decision.extracted_countries
            # Keep legacy single-country field as the first preference
            if not collected.get("country") and ai_decision.extracted_countries:
                collected["country"] = ai_decision.extracted_countries[0]
        if ai_decision.job_interest:
            collected["job_role"] = ai_decision.job_interest
        if ai_decision.country and not collected.get("country"):
            collected["country"] = ai_decision.country

        state["collected_data"] = collected

        # Rephrase detection (Phase 2.4): if the AI asked the same field as the
        # previous turn and the user's reply produced no new data for that field,
        # flip rephrase_mode on so the NEXT turn re-asks in plainer language.
        next_q = ai_decision.next_question_type
        same_field_again = bool(next_q and prev_question and next_q == prev_question)
        no_progress = collected == collected_before
        if same_field_again and no_progress:
            state["rephrase_mode"] = True
        else:
            state["rephrase_mode"] = False

        # Force-pick guard (Phase 1.2): if the AI tries to ask for something
        # we already collected (and already asked once), override with the next
        # genuinely missing mandatory field using the deterministic dispatcher.
        mandatory_order = self._mandatory_order(state)
        if next_q and next_q in asked_questions and self._field_satisfied(next_q, collected):
            replacement = self._next_unasked_missing(mandatory_order, collected, asked_questions)
            if replacement and replacement != next_q:
                logger.info(
                    "Force-pick override: AI asked '%s' (already known) → asking '%s'",
                    next_q, replacement,
                )
                next_q = replacement
                deterministic_prompt = intake_agent.get_prompt_for_field(replacement, locked_language)
                if deterministic_prompt:
                    ai_decision.reply_message = deterministic_prompt
                    ai_decision.next_question_type = replacement

        # Ad-intake override: when the deterministic ad-flow is steering this
        # conversation, we trust the AI's *entity extraction* (already merged
        # above) but replace the AI's reply with the validated next-field
        # prompt. Off-topic questions get the AI's FAQ-grounded answer prepended
        # before the re-ask so the candidate is heard without losing the flow.
        if ad_intake_flow.is_awaiting_field(state):
            current_field = state["ad_flow_step"].split(":", 1)[1]
            ai_extracted = self._ai_extracted_value(ai_decision, current_field)
            faq_answer = None
            # The AI may have produced a short FAQ reply when the user asked
            # something off-topic. Detect this heuristically: AI's reply isn't
            # asking for the current field AND the user's text didn't satisfy
            # the field. We pass the AI reply through as the FAQ answer.
            user_text_str = (message_text or "").strip()
            if user_text_str and ai_decision.reply_message:
                faq_answer = ai_decision.reply_message
            ad_reply = ad_intake_flow.process_field_reply(
                state=state,
                lang=locked_language,
                user_text=user_text_str,
                ai_extracted=ai_extracted,
                faq_answer=faq_answer if not self._field_satisfied(current_field, collected) else None,
            )
            ai_decision.reply_message = ad_reply
            ai_decision.next_question_type = self._current_ad_field(state)
            next_q = ai_decision.next_question_type
        elif ad_intake_flow.is_awaiting_cv(state):
            # CV is the only acceptable input here — text replies get a gentle
            # nudge back to upload. (Off-topic FAQ answer is still surfaced.)
            user_text_str = (message_text or "").strip()
            cv_prompt = ad_intake_flow.cv_prompt(locked_language)
            if user_text_str and ai_decision.reply_message and not self._looks_like_cv_intent(user_text_str):
                ai_decision.reply_message = f"{ai_decision.reply_message.strip()}\n\n{cv_prompt}"
            else:
                ai_decision.reply_message = cv_prompt
            ai_decision.next_question_type = "cv"
            next_q = "cv"
        elif ad_intake_flow.is_complete(state):
            # Ad-flow already submitted — let the AI handle further chitchat
            # (FAQ / general questions). No override needed.
            pass

        # Store next_question_type so the NEXT turn can detect rephrase and
        # avoid re-asking. Write-after-send: the append happens here because
        # we are about to return the reply to the user.
        state["next_question_type"] = next_q
        if next_q and next_q not in asked_questions:
            asked_questions.append(next_q)
        if next_q:
            asked_log.append({
                "field": next_q,
                "ts": datetime.now(timezone.utc).isoformat(),
                "turn": len(asked_log) + 1,
            })
            # Keep the log bounded so state JSON does not grow forever.
            if len(asked_log) > 50:
                asked_log = asked_log[-50:]
        state["asked_questions"] = list(dict.fromkeys(asked_questions))  # deduplicate
        state["asked_questions_log"] = asked_log

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

        # Sync as soon as we have a name or a CV — don't wait for all fields.
        # IMPORTANT: only mark cv_synced=True if push() actually succeeded.
        # Marking it True on a deferred sync (e.g. job_role not yet collected)
        # permanently blocked subsequent retries, leaving candidates stranded
        # on the chatbot side and never landing in CRM.
        can_sync = bool(candidate.name or collected.get("name") or state.get("cv_uploaded"))
        if can_sync and not state.get("cv_synced"):
            try:
                synced = await recruitment_sync.push(candidate, db)
                if synced:
                    state["cv_synced"] = True
            except Exception as exc:
                logger.warning("Recruitment sync failed during AI supervisor flow: %s", exc)

        # Fire thank-you message exactly once when profile is complete.
        if ai_decision.is_ready_to_sync and not state.get("thank_you_sent"):
            state["thank_you_sent"] = True
            self._save_agent_state(candidate, state)
            db.commit()
            from app.llm.prompt_templates import PromptTemplates  # local import to avoid circular
            import random
            templates = PromptTemplates.GREETINGS.get(locked_language, PromptTemplates.GREETINGS["en"])
            closing_msgs = templates.get("application_complete", [])
            if closing_msgs:
                name_val = candidate.name or collected.get("name") or ""
                return random.choice(closing_msgs).format(
                    name=name_val, company_name="Dewan Consultants"
                )

        self._save_agent_state(candidate, state)
        db.commit()

        return ai_decision.reply_message

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
        """CV/media priority interrupt path — AI-driven post-CV response."""
        candidate = crud.get_or_create_candidate(db, phone_number)
        state = self._ensure_agent_state(candidate)

        if media_type not in {"document", "image"}:
            return self._recovery_prompt(candidate)

        # --- 1. Extract CV data ---
        extracted = await cv_service.process_cv(
            file_content=media_content,
            filename=media_filename or ("cv.jpg" if media_type == "image" else "cv.pdf"),
            media_url=media_url,
        )

        # --- 1a. Reject images that are not CVs (selfies, unrelated photos) ---
        if extracted.get("_not_cv_image"):
            locked_language = state.get("locked_language") or "en"
            _not_cv_msgs = {
                "en": "That doesn't look like a CV or resume. Please upload a document or a clear photo of your CV.",
                "si": "ඔබ යැවූ රූපය CV ලෙස හඳුනාගත නොහැකිය. කරුණාකර ඔබේ CV ලේඛනය හෝ පැහැදිලි ඡායාරූපයක් ඉදිරිපත් කරන්න.",
                "ta": "நீங்கள் அனுப்பிய படம் CV அல்ல. உங்கள் CV ஆவணம் அல்லது தெளிவான படத்தை பதிவேற்றவும்.",
                "singlish": "Oyage picture eka CV ekak wage nehe. Karuna karala oba CV document eka hodama upload karanna.",
                "tanglish": "Neenga anupida picture CV mathiri theriyala. CV document-a sari-a upload pannunga.",
            }
            return _not_cv_msgs.get(locked_language, _not_cv_msgs["en"])

        # --- 2. Gate on extraction confidence — ignore low-quality extractions ---
        _CONFIDENCE_MIN = 0.55
        extraction_confidence = extracted.pop("_extraction_confidence", 1.0) or 1.0
        if extraction_confidence < _CONFIDENCE_MIN:
            logger.warning(
                "CV extraction confidence too low (%.2f) for %s — ignoring extracted fields",
                extraction_confidence,
                media_filename,
            )
            extracted = {}

        # --- 3. Merge extracted data into collected_data ---
        # Trust CV for skills and experience_years (most authoritative source).
        # Keep chat-provided name and job_role (user's stated preference wins).
        state["cv_uploaded"] = True
        state["step"] = "cv_received"
        collected = state.get("collected_data") if isinstance(state.get("collected_data"), dict) else {}

        for key, value in extracted.items():
            if key.startswith("_"):
                continue  # skip internal sentinel keys
            if value is not None:
                # Only overwrite if not already set via prior chat conversation
                if key not in collected or not collected[key]:
                    collected[key] = value

        # CV is authoritative for skills and experience — always trust it
        if extracted.get("skills"):
            collected["skills"] = extracted["skills"]
        if extracted.get("experience_years") is not None:
            collected["experience_years"] = extracted["experience_years"]

        state["collected_data"] = collected

        # --- 4. Update candidate model columns from CV ---
        if extracted.get("name") and not candidate.name:
            candidate.name = extracted["name"]
        if extracted.get("experience_years") is not None and candidate.experience_years is None:
            try:
                candidate.experience_years = int(float(extracted["experience_years"]))
            except Exception:
                pass

        self._save_agent_state(candidate, state)
        db.commit()

        # --- 4. Immediate sync — don't wait for user confirmation ---
        # Only mark cv_synced=True on actual success so deferred syncs retry.
        if not state.get("cv_synced"):
            try:
                cv_path = getattr(candidate, "resume_file_path", None)
                synced = await recruitment_sync.push(candidate, db, cv_path=cv_path)
                if synced:
                    state["cv_synced"] = True
                    self._save_agent_state(candidate, state)
                    db.commit()
            except Exception as exc:
                logger.warning("Immediate CV sync failed: %s", exc)

        # --- 5. Resolve language from prior conversation state ---
        locked_language = state.get("locked_language") or "en"

        # --- 5a. Ad-flow short-circuit ---
        # If the deterministic ad-flow was waiting for the CV (or even still
        # mid-field — a candidate can upload opportunistically), close the
        # loop now: emit the branded completion message and skip the generic
        # AI post-CV response. Only fires when the ad-flow is the steering
        # state machine for this conversation.
        if ad_intake_flow.is_active(state) and not ad_intake_flow.is_complete(state):
            completion = ad_intake_flow.completion_message(state, locked_language)
            self._save_agent_state(candidate, state)
            db.commit()
            return completion

        # --- 6. Load conversation history for AI context ---
        history_items = []
        for conv in reversed(crud.get_conversation_history(db, candidate.id, limit=15)):
            role = self._conversation_role(conv)
            content = str(conv.message_text or "").strip()
            if content:
                history_items.append({"role": role, "content": content})

        # --- 7. AI generates contextual post-CV response ---
        # "[CV_UPLOADED]" sentinel tells AI this is a CV event, not a chat message.
        asked_questions = state.get("asked_questions") if isinstance(state.get("asked_questions"), list) else []

        ai_decision = await run_ai_supervisor(
            user_text="[CV_UPLOADED]",
            history=history_items,
            force_applying=True,
            collected_data=collected,
            asked_questions=asked_questions,
            locked_language=locked_language,
            cv_just_uploaded=True,
            phone_number=phone_number,
        )

        # Track which field the AI is asking for next
        if ai_decision.next_question_type:
            if ai_decision.next_question_type not in asked_questions:
                asked_questions.append(ai_decision.next_question_type)
            state["asked_questions"] = asked_questions

        # Merge any additional data the AI extracted
        if ai_decision.extracted_name and not candidate.name:
            candidate.name = ai_decision.extracted_name
        if ai_decision.extracted_name and not collected.get("name"):
            collected["name"] = ai_decision.extracted_name
        if ai_decision.experience_years is not None and candidate.experience_years is None:
            try:
                candidate.experience_years = int(ai_decision.experience_years)
                collected["experience_years"] = candidate.experience_years
            except Exception:
                pass
        if ai_decision.extracted_age is not None and not collected.get("age"):
            try:
                age_val = int(ai_decision.extracted_age)
                candidate.age = age_val
                collected["age"] = age_val
            except Exception:
                pass
        if ai_decision.extracted_email and not collected.get("email"):
            candidate.email = ai_decision.extracted_email
            collected["email"] = ai_decision.extracted_email
        if ai_decision.extracted_countries and not collected.get("countries"):
            collected["countries"] = ai_decision.extracted_countries
        if ai_decision.country and not collected.get("country"):
            collected["country"] = ai_decision.country

        state["collected_data"] = collected

        if ai_decision.intervention_needed:
            candidate.intervention_needed = True
            state["handoff_flag"] = True
            candidate.handoff_flag = True
            await handoff_service.notify(candidate, reason="ai_intervention_needed")
            crud.update_candidate_state(db, candidate.id, "human_handoff")
            candidate.conversation_state = "human_handoff"

        # Fire thank-you message exactly once when profile is complete.
        if ai_decision.is_ready_to_sync and not state.get("thank_you_sent"):
            state["thank_you_sent"] = True
            self._save_agent_state(candidate, state)
            db.commit()
            from app.llm.prompt_templates import PromptTemplates  # local import to avoid circular
            import random
            templates = PromptTemplates.GREETINGS.get(locked_language, PromptTemplates.GREETINGS["en"])
            closing_msgs = templates.get("application_complete", [])
            if closing_msgs:
                name_val = candidate.name or collected.get("name") or ""
                return random.choice(closing_msgs).format(
                    name=name_val, company_name="Dewan Consultants"
                )

        self._save_agent_state(candidate, state)
        db.commit()

        return ai_decision.reply_message

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

        lang = self._candidate_language(candidate)
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

        rows = []
        matched_map: Dict[str, Dict[str, Any]] = {}
        for idx, job in enumerate(ranked):
            title = str(job.get("title") or "Job").strip()[:24] or "Job"
            country = ""
            countries = job.get("countries") or []
            if countries:
                country = str(countries[0])
            desc = (country or str(job.get("category") or "Open position"))[:72]
            rid = f"job_{idx}"
            rows.append({
                "id": rid,
                "title": title,
                "description": desc,
            })
            matched_map[rid] = job
        # Stash so the next interactive turn can resolve "job_<idx>" → real job.
        state["matched_jobs"] = matched_map

        if not rows:
            # No matches for the candidate's preference. Don't dead-end the lead:
            # offer urgent/recent jobs first, then a "Keep me informed" option
            # that saves them into the general pool with their preferences as
            # remarks. (Phase 3 swaps get_recent_active → get_urgent.)
            urgent = await vacancy_service.get_recent_active(limit=3)
            urgent_rows = []
            urgent_map: Dict[str, Dict[str, Any]] = {}
            for idx, job in enumerate(urgent):
                title = str(job.get("title") or "Job").strip()[:24] or "Job"
                countries = job.get("countries") or []
                country = str(countries[0]) if countries else ""
                desc = (country or str(job.get("category") or "Active opening"))[:72]
                rid = f"urgent_{idx}"
                urgent_rows.append({"id": rid, "title": title, "description": desc})
                urgent_map[rid] = job
            state["urgent_jobs"] = urgent_map
            self._save_agent_state(candidate, state)

            general_pool_row = {
                "id": "action_general_pool",
                "title": "Keep me informed",
                "description": "Save my preferences for future jobs",
            }
            if urgent_rows:
                return {
                    "type": "list",
                    "body_text": (
                        "No exact match for that preference right now — here are our most active openings. "
                        "Or I can save your preferences and message you when something matches."
                    ),
                    "button_label": "See Options",
                    "sections": [
                        {"title": "Active Openings", "rows": urgent_rows},
                        {"title": "Other Options", "rows": [general_pool_row]},
                    ],
                }
            return {
                "type": "buttons",
                "body_text": (
                    "No active vacancies match your preference right now. "
                    "Want me to save your details and notify you when a matching job opens?"
                ),
                "buttons": [
                    {"id": "action_general_pool", "title": "Keep me informed"},
                    {"id": "action_apply", "title": "Apply anyway"},
                ],
            }

        self._save_agent_state(candidate, state)
        return {
            "type": "list",
            "body_text": "Here are relevant vacancies. Select one to continue your application.",
            "button_label": "View Jobs",
            "sections": [{"title": "Available Vacancies", "rows": rows}],
        }

    async def _route_question(self, candidate, user_text: str, state: Dict[str, Any]) -> str:
        state["step"] = "answering_questions"
        self._save_agent_state(candidate, state)
        language = self._candidate_language(candidate)
        return await vacancy_service.search_and_refine(
            user_message=user_text,
            language=language,
            entities={},
            candidate_info={"phone": candidate.phone_number},
        )

    async def _route_interactive_action(self, db: Session, candidate, state: Dict[str, Any], action: str) -> Any:
        # Ad-flow language pick: lock the chosen language, then send the
        # branded job welcome + first intake prompt in that language.
        if ad_intake_flow.is_language_button(action):
            lang = ad_intake_flow.language_for_button(action)
            self._apply_language_lock(db, candidate, state, lang, is_explicit_switch=True)
            pending = state.pop("pending_job_welcome", None)
            reply = ad_intake_flow.welcome_and_first_prompt(state, lang, pending)
            self._save_agent_state(candidate, state)
            db.commit()
            return reply

        if action == "action_apply":
            return await self._route_apply_flow(db, candidate, state)
        if action == "action_question":
            return await self._route_question(candidate, "", state)
        if action == "action_general_pool":
            return await self._route_general_pool_signup(db, candidate, state)
        if re.match(r"^urgent_\d+$", action):
            # Treat picking an urgent job exactly like picking a regular job —
            # capture the job id from state and continue the standard flow.
            urgent_map = state.get("urgent_jobs") if isinstance(state.get("urgent_jobs"), dict) else {}
            picked = urgent_map.get(action)
            if picked:
                state["active_job_id"] = picked.get("job_id") or picked.get("id")
                if picked.get("title") and not state.get("collected_data", {}).get("job_role"):
                    collected = state.setdefault("collected_data", {})
                    collected["job_role"] = picked["title"]
                self._apply_required_fields_schema(state, picked)
            state["step"] = "collecting_experience"
            self._save_agent_state(candidate, state)
            crud.update_candidate_state(db, candidate.id, "intake_collecting_experience")
            candidate.conversation_state = "intake_collecting_experience"
            db.commit()
            next_field = self._next_unasked_missing(
                self._mandatory_order(state),
                state.get("collected_data", {}) or {},
                state.get("asked_questions", []) or [],
            )
            if next_field:
                prompt = intake_agent.get_prompt_for_field(next_field, self._candidate_language(candidate))
                if prompt:
                    return prompt
            return self._experience_prompt(candidate)
        if re.match(r"^job_\d+$", action):
            # Look up the actual job the user picked and load its per-job
            # required-fields schema so we ask the right questions for the
            # specific role (mandatory first, optional opportunistically).
            matched_map = state.get("matched_jobs") if isinstance(state.get("matched_jobs"), dict) else {}
            picked = matched_map.get(action)
            if picked:
                state["active_job_id"] = picked.get("id") or picked.get("job_id")
                if picked.get("title") and not state.get("collected_data", {}).get("job_role"):
                    collected = state.setdefault("collected_data", {})
                    collected["job_role"] = picked["title"]
                self._apply_required_fields_schema(state, picked)
            state["step"] = "collecting_experience"
            self._save_agent_state(candidate, state)
            crud.update_candidate_state(db, candidate.id, "intake_collecting_experience")
            candidate.conversation_state = "intake_collecting_experience"
            db.commit()
            # If schema was applied and we have a next mandatory field, prompt that
            # field directly. Otherwise fall back to the legacy experience prompt.
            next_field = self._next_unasked_missing(
                self._mandatory_order(state),
                state.get("collected_data", {}) or {},
                state.get("asked_questions", []) or [],
            )
            if next_field:
                prompt = intake_agent.get_prompt_for_field(next_field, self._candidate_language(candidate))
                if prompt:
                    return prompt
            return self._experience_prompt(candidate)
        return await self._route_apply_flow(db, candidate, state)

    def _is_structured_interactive_token(self, text: str) -> bool:
        return bool(re.match(
            r"^(job_\d+|urgent_\d+|action_apply|action_question|action_general_pool|lang_ad_(?:en|si|ta))$",
            text or "",
        ))

    async def _handle_ad_trigger(
        self,
        db: Session,
        candidate,
        state: Dict[str, Any],
        message_text: str,
    ) -> Optional[Any]:
        """Process a `START:<job_uuid>` first message from a Meta ad click.

        Hands the conversation off to the deterministic ``ad_intake_flow`` —
        either by sending the trilingual language selector (new user) or by
        going straight to the branded welcome + first prompt in the language
        the candidate previously locked. Either way we (a) load full ad
        context, (b) pre-fill job_interest + destination from the ad, and
        (c) apply the picked job's required_fields_schema so subsequent turns
        ask the right questions for the role.
        """
        context = await ad_context_service.detect_and_load(message_text, candidate, db)
        if not context:
            return None

        state["ad_processed"] = True
        prefilled = (context.get("chatbot_config") or {}).get("prefilled") or {}
        job = context.get("job") or {}
        project = context.get("project") or {}
        job_interest = prefilled.get("job_interest") or job.get("title")
        countries = project.get("countries") or []
        destination = prefilled.get("destination_country") or (
            countries[0] if countries else None
        )

        collected = state.setdefault("collected_data", {})
        asked_questions = state.setdefault("asked_questions", [])

        if job_interest and not collected.get("job_role"):
            collected["job_role"] = job_interest
            if "job_role" not in asked_questions:
                asked_questions.append("job_role")
        if destination and not collected.get("country"):
            collected["country"] = destination
            collected.setdefault("countries", [destination])
            if "countries" not in asked_questions:
                asked_questions.append("countries")

        # Persist full ad context for FAQ grounding + downstream sync.
        state["ad_context"] = (candidate.extracted_data or {}).get("ad_context")
        state["active_job_id"] = job.get("id")
        state["step"] = "ad_landed"

        # Per-job required_fields_schema → mandatory_fields list used by the
        # ad-intake flow to drive question order. Falls back to defaults if
        # the job didn't define a schema (handled inside the flow).
        self._apply_required_fields_schema(state, job)

        # Branch: returning user (language locked) skips the language step.
        locked = state.get("locked_language")
        if locked:
            reply = ad_intake_flow.welcome_and_first_prompt(
                state,
                locked,
                {"job_title": job.get("title") or "", "country": destination or ""},
            )
        else:
            reply = ad_intake_flow.language_selector_payload(
                state,
                job_title=job.get("title") or "",
                country=destination or "",
            )

        self._save_agent_state(candidate, state)
        db.commit()
        return reply

    async def _route_general_pool_signup(
        self,
        db: Session,
        candidate,
        state: Dict[str, Any],
    ) -> str:
        """Save the candidate into the general pool with their preferences as
        remarks so the lead is never lost when no current job matches."""
        collected = state.get("collected_data", {}) if isinstance(state.get("collected_data"), dict) else {}
        job_role = collected.get("job_role") or "any role"
        country = collected.get("country") or (collected.get("countries") or [None])[0] or "any country"
        exp = collected.get("experience_years")
        exp_part = f", {exp}y exp" if exp is not None else ""
        remarks = f"Wants: {job_role}, {country}{exp_part} (saved from no-match fallback)"

        # Mirror into state so the next sync picks it up. Phase 3 backend stores
        # these in dedicated columns; until then extra metadata is ignored.
        collected["general_pool_optin"] = True
        state["collected_data"] = collected
        state["remarks"] = remarks
        log = state.get("preferences_log") if isinstance(state.get("preferences_log"), list) else []
        log.append({
            "job_role": job_role,
            "country": country,
            "experience_years": exp,
            "ts": datetime.now(timezone.utc).isoformat(),
            "source": "no_match_fallback",
        })
        state["preferences_log"] = log
        if hasattr(candidate, "is_general_pool"):
            try:
                candidate.is_general_pool = True
            except Exception:
                pass

        self._save_agent_state(candidate, state)
        db.commit()

        try:
            await recruitment_sync.push(candidate, db)
        except Exception as exc:
            logger.warning("General-pool sync failed for %s: %s", candidate.phone_number, exc)

        lang = state.get("locked_language") or self._candidate_language(candidate)
        confirmations = {
            "en": (
                "Saved your preferences. We'll WhatsApp you as soon as a matching job opens. "
                "Anything else I can help with?"
            ),
            "si": (
                "ඔබේ අවශ්‍යතා සුරක්ෂිත කළා. ගැලපෙන රැකියාවක් එනවිට වහාම WhatsApp කරන්නම්. "
                "තවත් උදව්වක් ඕනේද?"
            ),
            "ta": (
                "உங்கள் தேவைகள் சேமிக்கப்பட்டன. பொருந்தும் வேலை திறக்கும்போது உடனே WhatsApp செய்வோம். "
                "இன்னும் ஏதாவது உதவி வேண்டுமா?"
            ),
            "singlish": (
                "Oyage preferences save kaala. Match wena job ekak avoth wahama WhatsApp karannam. "
                "Thawath udawwak onada?"
            ),
            "tanglish": (
                "Unga preferences save panniten. Match aana job vandhuduchu-na udane WhatsApp pannuven. "
                "Innum ethavadhu help venuma?"
            ),
        }
        return confirmations.get(lang, confirmations["en"])

    def _mandatory_order(self, state: Dict[str, Any]) -> List[str]:
        """Return the mandatory-field order. Per-job `required_fields_schema`
        (set when the user picks a specific job) wins over the static default."""
        per_job = state.get("mandatory_fields")
        if isinstance(per_job, list) and per_job:
            return [str(f) for f in per_job]
        return ["name", "job_role", "country", "experience_years", "age", "email"]

    def _apply_required_fields_schema(self, state: Dict[str, Any], job: Dict[str, Any]) -> None:
        """Extract `required_fields_schema` from the picked job and stash the
        ordered mandatory / optional field lists in state so subsequent turns
        ask the right questions for the role."""
        schema = job.get("required_fields_schema")
        if not isinstance(schema, dict) or not schema:
            # No per-job schema — keep defaults.
            return
        # Order: explicit `ask_after` chain first; everything else in dict order.
        # We resolve `ask_after` by topological-ish sort: place fields after their
        # dependency if it is present, otherwise append at the end.
        mandatory = [f for f, meta in schema.items() if isinstance(meta, dict) and meta.get("mandatory")]
        optional = [f for f, meta in schema.items() if isinstance(meta, dict) and not meta.get("mandatory")]

        def _sort_by_dep(fields: List[str]) -> List[str]:
            ordered: List[str] = []
            remaining = list(fields)
            guard = 0
            while remaining and guard < len(fields) * 2 + 1:
                progressed = False
                for f in list(remaining):
                    after = (schema.get(f) or {}).get("ask_after")
                    if not after or after in ordered or after not in fields:
                        ordered.append(f)
                        remaining.remove(f)
                        progressed = True
                if not progressed:
                    ordered.extend(remaining)
                    break
                guard += 1
            return ordered

        state["mandatory_fields"] = _sort_by_dep(mandatory)
        state["optional_fields"] = _sort_by_dep(optional)

    def _current_ad_field(self, state: Dict[str, Any]) -> Optional[str]:
        step = str(state.get("ad_flow_step") or "")
        if step.startswith("awaiting_field:"):
            return step.split(":", 1)[1] or None
        if step in ("awaiting_cv", "awaiting_field:cv"):
            return "cv"
        return None

    def _ai_extracted_value(self, ai_decision, field: str) -> Optional[Any]:
        """Surface the AI-supervisor's structured extraction for the field
        we're currently asking, so a verbose reply like 'I'm Ahmed and I'm 28'
        can satisfy the name step via ai_decision.extracted_name."""
        mapping = {
            "name": getattr(ai_decision, "extracted_name", None),
            "age": getattr(ai_decision, "extracted_age", None),
            "email": getattr(ai_decision, "extracted_email", None),
            "experience_years": getattr(ai_decision, "experience_years", None),
            "country": getattr(ai_decision, "country", None),
            "job_role": getattr(ai_decision, "job_interest", None),
        }
        return mapping.get(field)

    def _looks_like_cv_intent(self, text: str) -> bool:
        """Heuristic: did the user signal they're about to upload/lack a CV?
        Used in the ad-flow CV step so a 'sending now' / 'I don't have one'
        message doesn't get a redundant CV nudge tacked on."""
        if not text:
            return False
        lowered = text.lower()
        keywords = (
            "cv", "resume", "uploading", "sending", "send karanna", "send pannuven",
            "no cv", "don't have", "dont have", "haven't", "havent",
        )
        return any(k in lowered for k in keywords)

    def _field_satisfied(self, field: str, collected: Dict[str, Any]) -> bool:
        if not field:
            return False
        if field == "country":
            return bool(collected.get("country") or collected.get("countries"))
        if field == "countries":
            return bool(collected.get("countries") or collected.get("country"))
        if field == "cv":
            return bool(collected.get("cv_uploaded") or collected.get("cv"))
        value = collected.get(field)
        if isinstance(value, (int, float)):
            return value is not None
        return bool(value)

    def _next_unasked_missing(
        self,
        order: List[str],
        collected: Dict[str, Any],
        asked: List[str],
    ) -> Optional[str]:
        for field in order:
            if self._field_satisfied(field, collected):
                continue
            if field in asked:
                continue
            return field
        return None

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
        lang = self._candidate_language(candidate)
        return intake_agent.country_prompt(lang)

    def _experience_prompt(self, candidate) -> str:
        lang = self._candidate_language(candidate)
        return intake_agent.experience_prompt(lang)

    def _cv_prompt(self, candidate) -> str:
        lang = self._candidate_language(candidate)
        return intake_agent.cv_prompt(lang)

    def _handoff_prompt(self, candidate) -> str:
        lang = self._candidate_language(candidate)
        return recovery_agent.handoff_prompt(lang)

    def _ensure_agent_state(self, candidate) -> Dict[str, Any]:
        state = candidate.agent_state if isinstance(candidate.agent_state, dict) else None
        if state is None:
            extracted = candidate.extracted_data if isinstance(candidate.extracted_data, dict) else {}
            state = extracted.get("agent_state") if isinstance(extracted.get("agent_state"), dict) else None
        if not isinstance(state, dict):
            state = {
                "step": "entry",
                "cv_uploaded": False,
                "collected_data": {},
                "confusion_count": 0,
                "handoff_flag": False,
                "locked_language": None,
                "asked_questions": [],
                "asked_questions_log": [],
                "cv_synced": False,
                "ad_processed": False,
                "rephrase_mode": False,
                "urgent_jobs": {},
                "preferences_log": [],
            }
            self._save_agent_state(candidate, state)
        else:
            # Backfill new keys for existing sessions without them
            if "asked_questions" not in state:
                state["asked_questions"] = []
            if "asked_questions_log" not in state:
                state["asked_questions_log"] = []
            if "cv_synced" not in state:
                state["cv_synced"] = False
            if "ad_processed" not in state:
                state["ad_processed"] = False
            if "rephrase_mode" not in state:
                state["rephrase_mode"] = False
            if "urgent_jobs" not in state:
                state["urgent_jobs"] = {}
            if "preferences_log" not in state:
                state["preferences_log"] = []
            # Fix 6: recover cv_uploaded from the DB-level resume_file_path column
            # so the flag survives a state flush or agent_state column reset.
            if not state.get("cv_uploaded") and getattr(candidate, "resume_file_path", None):
                state["cv_uploaded"] = True
        # Only clear asked_questions if collected_data is completely empty (a truly
        # new session).  Do NOT clear it just because name is missing — that would
        # reset the question tracker mid-conversation after a restart.
        collected_check = state.get("collected_data") if isinstance(state.get("collected_data"), dict) else {}
        if not collected_check and not state.get("asked_questions"):
            state["asked_questions"] = []
        return state

    def _apply_language_lock(
        self,
        db: Session,
        candidate,
        state: Dict[str, Any],
        detected_language: str,
        is_explicit_switch: bool = False,
    ) -> None:
        if not detected_language:
            return
        state["reply_register"] = detected_language
        existing_lock = state.get("locked_language")
        # Once a lock exists, only an explicit "speak Tamil / switch to Singlish"
        # request from the user may change it.  Single-word answers like "Dubai"
        # or "28" must never flip the lock back to English.
        if existing_lock and not is_explicit_switch:
            return
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

        extracted_source = candidate.extracted_data if isinstance(candidate.extracted_data, dict) else {}
        extracted = dict(extracted_source)
        extracted["agent_state"] = dict(safe_state)
        candidate.extracted_data = extracted

    def _recovery_prompt(self, candidate) -> str:
        lang = self._candidate_language(candidate)
        return recovery_agent.recovery_prompt(lang)


intake_orchestrator = IntakeOrchestrator()
