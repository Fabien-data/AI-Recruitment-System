"""Handoff signaling service for modular orchestrator."""

from __future__ import annotations

import logging

from app.chatbot import chatbot

logger = logging.getLogger(__name__)


class HandoffService:
    """Signals downstream systems when modular orchestrator escalates to human."""

    async def notify(self, candidate, reason: str) -> None:
        try:
            await chatbot._notify_human_handoff(candidate, reason=reason)
        except Exception as exc:
            logger.warning("Handoff notification failed: %s", exc)


handoff_service = HandoffService()
