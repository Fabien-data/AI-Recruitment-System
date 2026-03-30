"""Handoff signaling service for modular orchestrator."""

from __future__ import annotations

import logging
from typing import Any

import httpx

from app.config import settings

logger = logging.getLogger(__name__)


class HandoffService:
    """Signals downstream systems when modular orchestrator escalates to human."""

    async def notify(self, candidate: Any, reason: str) -> None:
        try:
            webhook_url = settings.human_handoff_webhook_url
            if not webhook_url:
                logger.info("Human handoff webhook not configured; skipping external notify")
                return

            payload = {
                "phone": getattr(candidate, "phone_number", ""),
                "candidate_id": getattr(candidate, "id", None),
                "reason": reason,
            }
            async with httpx.AsyncClient(timeout=8.0) as client:
                resp = await client.post(webhook_url, json=payload)
                if resp.status_code >= 300:
                    logger.warning("Handoff webhook returned %s", resp.status_code)
        except Exception as exc:
            logger.warning("Handoff notification failed: %s", exc)


handoff_service = HandoffService()
