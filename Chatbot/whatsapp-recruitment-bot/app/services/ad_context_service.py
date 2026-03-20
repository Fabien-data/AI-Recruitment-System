"""
Ad Context Service
==================
Detects the Meta Click-to-WhatsApp "START:ad_ref" trigger message
and fetches the corresponding job/project context from the recruitment
system so the chatbot can have an instantly personalised conversation.

Usage (in chatbot.py):
    from app.services.ad_context_service import ad_context_service

    context = await ad_context_service.detect_and_load(message_text, candidate, db)
    if context:
        # context is a dict with job, project, chatbot_config
        prefilled = context["chatbot_config"]["prefilled"]
        greeting = context["chatbot_config"]["greeting_override"]
"""

import re
import os
import logging
import httpx
from typing import Optional, Dict, Any

from sqlalchemy.orm import Session
from app import crud

logger = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────
RECRUITMENT_API_URL = os.getenv("RECRUITMENT_API_URL", "http://localhost:3000")
CHATBOT_API_KEY = os.getenv("CHATBOT_API_KEY", "")
SYNC_ENABLED = os.getenv("RECRUITMENT_SYNC_ENABLED", "true").lower() == "true"

# "START:job_abc123" — case insensitive, allows most URL-safe chars in the ref
_START_PATTERN = re.compile(r'^START:([A-Za-z0-9_\-]{3,100})$', re.IGNORECASE)


class AdContextService:
    """
    Handles detection of Meta ad click triggers and fetching job context
    from the recruitment system.
    """

    @staticmethod
    def is_ad_trigger(message_text: str) -> Optional[str]:
        """
        Returns the ad_ref if this message is a Meta ad click trigger,
        or None if it's a normal message.

        Example:
            >>> is_ad_trigger("START:job_3f9a12b4")
            'job_3f9a12b4'
            >>> is_ad_trigger("Hello, I want to apply")
            None
        """
        if not message_text:
            return None
        match = _START_PATTERN.match(message_text.strip())
        return match.group(1) if match else None

    async def detect_and_load(
        self,
        message_text: str,
        candidate,
        db: Session
    ) -> Optional[Dict[str, Any]]:
        """
        Main entry point. Call this at the start of every STATE_INITIAL
        message before the normal state machine logic.

        Returns:
            Context dict (job, project, chatbot_config) if this is an ad click,
            or None if it's a regular first message.

        Side effects:
            - Saves ad_context, job_interest, destination_country into
              candidate.extracted_data
            - Does NOT change conversation_state (caller handles that)
        """
        ad_ref = self.is_ad_trigger(message_text)
        if not ad_ref:
            return None

        logger.info(f"Ad click detected: ref='{ad_ref}' candidate={candidate.id}")

        if not SYNC_ENABLED:
            logger.info("RECRUITMENT_SYNC_ENABLED=false — skipping ad context fetch")
            return None

        context = await self._fetch_context(ad_ref)
        if not context:
            logger.warning(f"Could not load context for ad_ref='{ad_ref}' — proceeding as normal first message")
            return None

        # ── Pre-fill candidate data from ad context ────────────────────────
        await self._prefill_candidate(candidate, context, ad_ref, db)

        return context

    async def _fetch_context(self, ad_ref: str) -> Optional[Dict[str, Any]]:
        """Fetch job/project context from recruitment system public endpoint."""
        url = f"{RECRUITMENT_API_URL}/api/public/job-context/{ad_ref}"
        headers = {"x-chatbot-api-key": CHATBOT_API_KEY}

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(url, headers=headers)

            if response.status_code == 200:
                data = response.json()
                logger.info(
                    f"Context loaded for ad_ref='{ad_ref}': "
                    f"job='{data.get('job', {}).get('title', '?')}'"
                )
                return data

            if response.status_code == 404:
                logger.warning(f"Ad ref '{ad_ref}' not found in recruitment system (404)")
                return None

            logger.error(
                f"Unexpected status {response.status_code} fetching context for '{ad_ref}': "
                f"{response.text[:200]}"
            )
            return None

        except httpx.TimeoutException:
            logger.error(f"Timeout fetching ad context for '{ad_ref}' from {url}")
            return None
        except httpx.ConnectError:
            logger.error(f"Cannot connect to recruitment system at {RECRUITMENT_API_URL} — is it running?")
            return None
        except Exception as e:
            logger.error(f"Unexpected error fetching ad context: {e}", exc_info=True)
            return None

    async def _prefill_candidate(
        self,
        candidate,
        context: Dict[str, Any],
        ad_ref: str,
        db: Session
    ):
        """
        Store ad context into candidate.extracted_data so the entire
        conversation has access to the pre-known job details.
        """
        job = context.get("job", {})
        project = context.get("project", {})
        chatbot_cfg = context.get("chatbot_config", {})
        prefilled = chatbot_cfg.get("prefilled", {})

        countries = project.get("countries", [])
        destination_country = countries[0] if countries else None

        # Merge with any existing extracted_data (preserve previous keys)
        existing = candidate.extracted_data or {}

        updated = {
            **existing,
            # Ad tracking
            "ad_ref": ad_ref,
            "ad_job_id": prefilled.get("ad_job_id") or job.get("id"),
            "ad_project_id": prefilled.get("ad_project_id") or project.get("id"),

            # Pre-filled intake answers (skips asking user these questions)
            "job_interest": prefilled.get("job_interest") or job.get("title", ""),
            "destination_country": prefilled.get("destination_country") or destination_country or "",

            # Full context snapshot (chatbot can use for FAQ answers)
            "ad_context": {
                "ad_ref": ad_ref,
                "campaign_name": context.get("campaign_name"),
                "job_id": job.get("id"),
                "job_title": job.get("title"),
                "job_category": job.get("category"),
                "job_requirements": job.get("requirements", {}),
                "job_salary": job.get("salary_range"),
                "job_location": job.get("location"),
                "project_id": project.get("id"),
                "project_title": project.get("title"),
                "client_name": project.get("client_name"),
                "countries": countries,
                "benefits": project.get("benefits", {}),
                "interview_date": project.get("interview_date"),
                "start_date": project.get("start_date"),
                "faqs": chatbot_cfg.get("faqs", []),
            }
        }

        candidate.extracted_data = updated
        db.commit()
        logger.info(
            f"Pre-filled candidate {candidate.id} from ad_ref='{ad_ref}': "
            f"job='{updated['job_interest']}', country='{updated['destination_country']}'"
        )

    def get_greeting(self, context: Dict[str, Any]) -> Optional[str]:
        """Return the personalised greeting from the ad context if available."""
        return (
            context.get("chatbot_config", {}).get("greeting_override")
            if context
            else None
        )

    def get_faqs(self, context: Dict[str, Any]) -> list:
        """Return FAQs from the ad context."""
        return context.get("chatbot_config", {}).get("faqs", []) if context else []

    def should_skip_state(self, context: Dict[str, Any], state_name: str) -> bool:
        """
        Returns True if a given intake state should be skipped because
        the ad context already provided that information.

        States that can be skipped if prefilled:
            - AWAITING_JOB_INTEREST   (if job_interest is set from ad)
            - AWAITING_DESTINATION    (if destination_country is set from ad)
        """
        skip_states = context.get("chatbot_config", {}).get("skip_states", [])
        return state_name in skip_states if context else False


# Singleton instance used throughout the chatbot
ad_context_service = AdContextService()
