"""Message router entrypoint for modular intake processing."""

from __future__ import annotations

from typing import Any, Dict, Optional

from sqlalchemy.orm import Session

from app.core.orchestrator import intake_orchestrator


class MessageRouter:
    """Routes message modalities into the orchestrator pipeline."""

    async def route_text(
        self,
        db: Session,
        phone_number: str,
        text: str,
        source_message_type: str = "text",
        referral_data: Optional[Dict[str, Any]] = None,
    ):
        return await intake_orchestrator.process_text_message(
            db=db,
            phone_number=phone_number,
            message_text=text,
            source_message_type=source_message_type,
            referral_data=referral_data,
        )

    async def route_media(
        self,
        db: Session,
        phone_number: str,
        media_content: bytes,
        media_type: str,
        media_filename: Optional[str] = None,
        media_url: Optional[str] = None,
        source_message_type: str = "document",
    ):
        return await intake_orchestrator.process_media_message(
            db=db,
            phone_number=phone_number,
            media_content=media_content,
            media_type=media_type,
            media_filename=media_filename,
            media_url=media_url,
            source_message_type=source_message_type,
        )


message_router = MessageRouter()
