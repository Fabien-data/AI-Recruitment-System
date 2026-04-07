# Last 24h Previous vs Current

Generated: 2026-04-06 15:59:16 +05:30


## Changes_and_updates_to_be_done_in_the_Recruitment_System.pdf

Previous:
(Binary file; textual previous content not shown)

Current:
(Binary file; textual current content not shown)

## Chatbot/whatsapp-recruitment-bot/app/webhooks.py

Previous code:
~~~
"""
WhatsApp Webhook Handlers
=========================
Handles incoming webhooks from Meta WhatsApp Business API.
Processes messages and triggers the chatbot engine.

FIX: Background tasks now create their OWN database session
     instead of reusing the request's session (which is closed
     by FastAPI before the background task runs).
"""

import asyncio
import logging
import traceback
import time
from typing import Optional

import httpx

from fastapi import APIRouter, Request, HTTPException, Query, BackgroundTasks, Header
from starlette import status as http_status
from pydantic import BaseModel

from app.database import SessionLocal
from app import crud
from app.utils.meta_client import meta_client
from app.chatbot import chatbot
from app.services.voice_service import voice_service
from app.config import settings
from app.nlp.language_detector import is_greeting

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/webhook", tags=["WhatsApp Webhook"])

# ΓöÇΓöÇΓöÇ Message Deduplication Cache ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
# Stores (message_id -> timestamp) for recently-processed messages.
# Meta sometimes retries webhook delivery ΓÇö this prevents duplicate responses.
_PROCESSED_MSG_TTL = 300  # 5 minutes
_processed_messages: dict = {}   # {msg_id: processed_at_epoch}


def _is_duplicate(message_id: str) -> bool:
    """Return True if this message was already processed recently."""
    now = time.time()
    # Expire old entries opportunistically
    expired = [mid for mid, ts in _processed_messages.items() if now - ts > _PROCESSED_MSG_TTL]
    for mid in expired:
        _processed_messages.pop(mid, None)

    if message_id in _processed_messages:
        logger.info(f"ΓÅ¡∩╕Å Skipping duplicate message id={message_id}")
        return True
    _processed_messages[message_id] = now
    return False


# ΓöÇΓöÇΓöÇ Webhook Verification (GET) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

@router.get("/whatsapp")
async def verify_webhook(
    hub_mode: Optional[str] = Query(None, alias="hub.mode"),
    hub_challenge: Optional[str] = Query(None, alias="hub.challenge"),
    hub_verify_token: Optional[str] = Query(None, alias="hub.verify_token")
):
    """
    Meta webhook verification endpoint.
    Called by Meta when setting up the webhook URL.
    """
    logger.info(
        f"Webhook verification request ΓåÆ mode={hub_mode}, "
        f"token={hub_verify_token}, challenge={hub_challenge}"
    )

    if hub_mode == "subscribe" and hub_verify_token == settings.meta_verify_token:
        logger.info("Γ£à Webhook verification successful")
        from fastapi.responses import PlainTextResponse
        return PlainTextResponse(content=hub_challenge, status_code=200)

    logger.warning(
        f"Γ¥î Webhook verification FAILED ΓÇö "
        f"expected token '{settings.meta_verify_token}', got '{hub_verify_token}'"
    )
    raise HTTPException(status_code=403, detail="Verification failed")


# ΓöÇΓöÇΓöÇ Incoming Messages (POST) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

@router.post("/whatsapp")
async def handle_webhook(
    request: Request,
    background_tasks: BackgroundTasks,
):
    """
    Handle incoming WhatsApp messages from Meta webhook.
    Returns 200 immediately; processes message in background.
    """
    try:
        body_bytes = await request.body()

        # Signature verification (skipped if APP_SECRET not configured)
        signature = request.headers.get("X-Hub-Signature-256", "")
        if signature and settings.meta_app_secret:
            if not meta_client.verify_webhook(body_bytes, signature):
                logger.warning("Γ¥î Invalid webhook signature ΓÇö rejecting request")
                raise HTTPException(status_code=401, detail="Invalid signature")

        data = await request.json()
        logger.info(f"≡ƒô¿ Webhook received: object={data.get('object', 'unknown')}")
        logger.debug(f"Webhook payload: {data}")

        # Queue each message for background processing via FastAPI BackgroundTasks
        
        entries = data.get("entry", [])
        for entry in entries:
            for change in entry.get("changes", []):
                if change.get("field") == "messages":
                    value = change.get("value", {})
                    background_tasks.add_task(process_webhook_value, value)
                    logger.info("Background task queued via FastAPI BackgroundTasks")

        return {"status": "ok"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Webhook handler error: {e}\n{traceback.format_exc()}")
        # Always return 200 to prevent Meta from retrying endlessly
        return {"status": "error", "message": str(e)}


# ΓöÇΓöÇΓöÇ Background Processing ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

async def process_webhook_value(value: dict):
    """
    Process a webhook 'value' payload in the background.
    Creates its OWN database session ΓÇö critical fix for FastAPI background tasks.
    """
    messages  = value.get("messages", [])
    contacts  = value.get("contacts", [])
    statuses  = value.get("statuses", [])

    # Log delivery statuses (optional, non-critical)
    for status in statuses:
        logger.debug(
            f"Message status update: id={status.get('id')} "
            f"status={status.get('status')} to={status.get('recipient_id')}"
        )

    if not messages:
        logger.debug("No messages in webhook value ΓÇö skipping")
        return

    for message in messages:
        # Γ£à Fresh DB session per message
        db = SessionLocal()
        try:
            await process_single_message(message, contacts, db)
            db.commit()
        except Exception as e:
            db.rollback()
            logger.error(
                f"Error processing message {message.get('id')}: {e}\n"
                f"{traceback.format_exc()}"
            )
            # Try to send an error reply so the user isn't left hanging
            from_number = message.get("from")
            if from_number:
                try:
                    await meta_client.send_message(
                        from_number,
                        "I'm sorry, I encountered an error. Please try again in a moment."
                    )
                except Exception as send_err:
                    logger.error(f"Failed to send error reply: {send_err}")
        finally:
            db.close()


# ΓöÇΓöÇΓöÇ Recruitment System Chat Sync ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

async def _sync_chat_message(
    phone: str,
    direction: str,
    content: str,
    language: str = "en",
    chatbot_state: str = "",
) -> None:
    """
    Push a single message (inbound customer msg or outbound bot reply)
    to the recruitment system's chat sync endpoint so agents see the
    full conversation without waiting for application completion.

    Fire-and-forget: any failure is logged but never propagates.

    Args:
        phone:         E.164-formatted customer phone number.
        direction:     "inbound" (customer ΓåÆ bot) or "outbound" (bot ΓåÆ customer).
        content:       Message text.
        language:      Detected language code (en/si/ta/singlish/tanglish).
        chatbot_state: Current conversation state name for agent context.
    """
    try:
        recruitment_url = settings.recruitment_api_url or ""
        api_key         = settings.chatbot_api_key or ""
        if not recruitment_url or not api_key:
            return  # Not configured ΓÇö skip silently

        payload = {
            "phone":         phone,
            "direction":     direction,
            "content":       content[:2000],  # Truncate to avoid oversized payloads
            "message_type":  "text",
            "language":      language,
            "chatbot_state": chatbot_state,
        }
        async with httpx.AsyncClient(timeout=4.0) as client:
            resp = await client.post(
                f"{recruitment_url}/api/chatbot/sync-message",
                headers={"x-chatbot-api-key": api_key},
                json=payload,
            )
            if resp.status_code not in (200, 201):
                logger.debug(
                    f"Chat sync returned {resp.status_code} for {phone} ΓÇö "
                    f"endpoint may not exist yet (Plan 2)"
                )
    except Exception as _sync_err:
        # Non-critical ΓÇö never block message processing
        logger.debug(f"_sync_chat_message skipped: {_sync_err}")


async def process_single_message(message: dict, contacts: list, db):
    """Process a single incoming WhatsApp message."""

    async def _safe_process_message(**kwargs):
        try:
            return await asyncio.wait_for(chatbot.process_message(**kwargs), timeout=45)
        except asyncio.TimeoutError:
            logger.error("chatbot.process_message timed out after 45s")
            return "Sorry, I'm taking too long to respond right now. Please try again in a moment."
        except Exception as exc:
            logger.error(f"chatbot.process_message failed: {exc}")
            return "Oops, something went wrong on my end. Please try again."

    message_id   = message.get("id")
    from_number  = message.get("from")
    message_type = message.get("type")

    if not from_number:
        logger.warning("Message missing 'from' field ΓÇö skipping")
        return

    # ΓöÇΓöÇ Deduplication: skip if we already processed this message ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    if message_id and _is_duplicate(message_id):
        return  # Meta retried a webhook we already handled

    logger.info(
        f"≡ƒô⌐ Processing message id={message_id} from={from_number} type={message_type}"
    )


    # Mark as read immediately
    try:
        await meta_client.mark_as_read(message_id)
    except Exception as e:
        logger.warning(f"Could not mark message as read: {e}")

    response_text = None

    # ΓöÇΓöÇ Text message ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    if message_type == "text":
        text_body = message.get("text", {}).get("body", "")
        logger.info(f"≡ƒÆ¼ Text from {from_number}: {text_body!r}")

        # Fast-path: for simple greetings in early onboarding states, send language selector
        # immediately and skip heavy chatbot orchestration.
        try:
            greet, _ = is_greeting(text_body)
            if greet:
                candidate = crud.get_or_create_candidate(db, from_number)
                if candidate.conversation_state in ("initial", "awaiting_language_selection"):
                    sel = await meta_client.send_language_selector(from_number)
                    if sel and "error" not in sel:
                        logger.info(f"Fast-path language selector sent to {from_number}")
                        return
                    fallback_text = (
                        "Welcome! Please choose your preferred language.\n"
                        "1) English\n2) α╖âα╖Æα╢éα╖äα╢╜\n3) α«ñα««α«┐α«┤α»ì"
                    )
                    send_res = await meta_client.send_message(from_number, fallback_text)
                    if send_res and "error" not in send_res:
                        logger.info(f"Fast-path language fallback sent to {from_number}")
                        return
        except Exception as fast_path_err:
            logger.warning(f"Greeting fast-path failed: {fast_path_err}")

        response_text = await _safe_process_message(
            db=db,
            phone_number=from_number,
            message_text=text_body
        )

    # ΓöÇΓöÇ Document (CV upload) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    elif message_type == "document":
        document  = message.get("document", {})
        media_id  = document.get("id")
        filename  = document.get("filename", "document.pdf")
        mime_type = document.get("mime_type", "")

        logger.info(f"≡ƒôÄ Document from {from_number}: {filename} ({mime_type})")

        allowed_types = [
            "application/pdf",
            "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ]

        if mime_type in allowed_types or filename.lower().endswith((".pdf", ".doc", ".docx")):
            file_content = await meta_client.download_media(media_id)
            if file_content:
                response_text = await _safe_process_message(
                    db=db,
                    phone_number=from_number,
                    media_content=file_content,
                    media_type="document",
                    media_filename=filename
                )
            else:
                response_text = "I couldn't download your document. Please try sending it again."
        else:
            response_text = "Please send your CV as a PDF or Word document (.pdf / .doc / .docx)."

    # ΓöÇΓöÇ Image (CV as photo / scan) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    elif message_type == "image":
        image     = message.get("image", {})
        media_id  = image.get("id")
        mime_type = image.get("mime_type", "image/jpeg")

        logger.info(f"≡ƒû╝∩╕Å Image from {from_number}")

        ext_map  = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}
        filename = f"cv_image{ext_map.get(mime_type, '.jpg')}"

        file_content = await meta_client.download_media(media_id)
        if file_content:
            response_text = await _safe_process_message(
                db=db,
                phone_number=from_number,
                media_content=file_content,
                media_type="document",
                media_filename=filename
            )
        else:
            response_text = (
                "I couldn't download your image. "
                "Please try again, or send your CV as a PDF for best results."
            )

    # ΓöÇΓöÇ Audio / Voice message ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    elif message_type == "audio":
        audio    = message.get("audio", {})
        media_id = audio.get("id")
        mime     = audio.get("mime_type", "audio/ogg")

        logger.info(f"≡ƒÄñ Voice message from {from_number} ({mime})")

        if not voice_service.available:
            response_text = (
                "I can't process voice messages right now. "
                "Could you type your message instead? ≡ƒÿè"
            )
        else:
            audio_bytes = await meta_client.download_media(media_id)
            if audio_bytes:
                # Determine language hint from candidate's stored preference
                cand = crud.get_or_create_candidate(db, from_number)
                lang_hint = cand.language_preference.value

                ext_map = {"audio/ogg": "voice.ogg", "audio/mpeg": "voice.mp3",
                           "audio/mp4": "voice.m4a", "audio/aac": "voice.aac"}
                fname = ext_map.get(mime.split(";")[0], "voice.ogg")

                transcribed = await voice_service.transcribe(
                    audio_bytes, language_hint=lang_hint, filename=fname
                )
                if transcribed:
                    logger.info(f"≡ƒÄñΓåÆ≡ƒÆ¼ Transcribed: {transcribed[:80]!r}")
                    response_text = await _safe_process_message(
                        db=db, phone_number=from_number, message_text=transcribed
                    )
                else:
                    response_text = (
                        "I couldn't understand that voice message. "
                        "Could you try again or type your message? ≡ƒÖÅ"
                    )
            else:
                response_text = (
                    "I couldn't download your voice message. Please try again."
                )

    # ΓöÇΓöÇ Interactive (button / list reply) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    elif message_type == "interactive":
        interactive      = message.get("interactive", {})
        interactive_type = interactive.get("type")

        if interactive_type == "button_reply":
            btn_id    = interactive.get("button_reply", {}).get("id", "")
            btn_title = interactive.get("button_reply", {}).get("title", "")
            # Map button IDs to canonical text so the chatbot state machine
            # doesn't need to be aware of button IDs directly.
            _button_id_map = {
                "lang_en": "English",
                "lang_si": "Sinhala",
                "lang_ta": "Tamil",
                "action_apply": "apply",
                "action_vacancies": "what are the available vacancies",
                "action_question": "I have a question",
            }
            text_to_send = _button_id_map.get(btn_id, btn_title or btn_id)
            logger.info(
                f"≡ƒöÿ Button reply from {from_number}: id={btn_id!r} title={btn_title!r} "
                f"ΓåÆ routing as: {text_to_send!r}"
            )
            response_text = await _safe_process_message(
                db=db, phone_number=from_number, message_text=text_to_send
            )

        elif interactive_type == "list_reply":
            list_id    = interactive.get("list_reply", {}).get("id", "")
            list_title = interactive.get("list_reply", {}).get("title", "")
            # Use exact list_id for structured tracking, otherwise fallback to title
            text_to_send = list_id if list_id.startswith("job_") or list_id == "skip" else (list_title or list_id)
            logger.info(
                f"≡ƒôï List reply from {from_number}: id={list_id!r} title={list_title!r}"
            )
            response_text = await _safe_process_message(
                db=db, phone_number=from_number, message_text=text_to_send
            )

    # ΓöÇΓöÇ Unsupported type ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    else:
        logger.info(f"Unsupported message type '{message_type}' from {from_number}")
        response_text = (
            "I can receive text messages, voice messages, and document uploads (PDF/Word). "
            "How can I assist you?"
        )

    # ΓöÇΓöÇ Send reply ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    if response_text:
        if isinstance(response_text, dict):
            msg_type = response_text.get("type")
            if msg_type == "list":
                logger.info(f"≡ƒôñ Sending interactive list to {from_number}")
                result = await meta_client.send_list_message(
                    to_number=from_number,
                    body_text=response_text.get("body_text", ""),
                    button_label=response_text.get("button_label", "Options"),
                    sections=response_text.get("sections", []),
                    header_text=response_text.get("header_text"),
                    footer_text=response_text.get("footer_text")
                )
                response_text = "[Interactive List]"  # for sync logging
            elif msg_type == "buttons":
                logger.info(f"≡ƒôñ Sending interactive buttons to {from_number}")
                result = await meta_client.send_interactive_buttons(
                    to_number=from_number,
                    body_text=response_text.get("body_text", ""),
                    buttons=response_text.get("buttons", []),
                    header_text=response_text.get("header_text"),
                    footer_text=response_text.get("footer_text")
                )
                response_text = "[Interactive Buttons]"
            else:
                logger.error(f"Unknown structured message type: {msg_type}")
                result = None
                response_text = "[Unrecognized Format Error]"
        elif "__INTERACTIVE_LANGUAGE_SELECTOR__" in response_text:
            parts = response_text.split("__INTERACTIVE_LANGUAGE_SELECTOR__")
            prefix_text = parts[0].strip()
            
            # Send the prefix message if it exists (e.g. "Hey User! ≡ƒÿè")
            if prefix_text:
                await meta_client.send_message(from_number, prefix_text)
                await asyncio.sleep(0.5)  # slight delay to ensure correct order
                
            logger.info(f"≡ƒôñ Sending interactive language selector to {from_number}")
            result = await meta_client.send_language_selector(from_number)
            
            # Remove the flag so the sync doesn't have the ugly token
            response_text = response_text.replace("__INTERACTIVE_LANGUAGE_SELECTOR__", "[Interactive Language Selector]")
        else:
            logger.info(f"≡ƒôñ Sending reply to {from_number}: {response_text[:80]}...")
            result = await meta_client.send_message(from_number, response_text)

        if result and "error" in result:
            logger.error(f"Γ¥î Failed to send message to {from_number}: {result}")
        else:
            # Safely handle dict or missing 'messages' key
            msg_id_sent = "N/A"
            if isinstance(result, dict):
                msgs = result.get('messages', [])
                if msgs and isinstance(msgs, list) and isinstance(msgs[0], dict):
                    msg_id_sent = msgs[0].get('id', 'N/A')
            logger.info(f"Γ£à Reply sent to {from_number} ΓÇö msg_id={msg_id_sent}")

        # ΓöÇΓöÇ Sync both messages to recruitment system communications table ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
        # Runs concurrently after the reply is sent. Failures are swallowed.
        try:
            # Look up candidate's current state + language for agent context
            from app import crud as _crud
            _cand = _crud.get_or_create_candidate(db, from_number)
            _lang  = getattr(_cand.language_preference, "value", "en")
            _state = _cand.conversation_state or ""
            _inbound_text = (
                message.get("text", {}).get("body")
                or message.get("document", {}).get("filename")
                or f"[{message_type} message]"
            )
            await asyncio.gather(
                _sync_chat_message(from_number, "inbound",  _inbound_text, _lang, _state),
                _sync_chat_message(from_number, "outbound", response_text,  _lang, _state),
            )
        except Exception as _sc_err:
            logger.debug(f"Chat sync gather error: {_sc_err}")
    else:
        logger.warning(f"No response generated for message from {from_number}")


# ΓöÇΓöÇΓöÇ Candidate Status Webhook ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
# Receives status updates from the recruitment system and proactively
# messages the candidate via WhatsApp.


class CandidateStatusPayload(BaseModel):
    """Payload from recruitment system for candidate status updates."""
    candidate_phone: str
    candidate_name: str
    status: str  # shortlisted | interview_scheduled | hired | rejected_with_alternatives
    job_title: str
    interview_date: Optional[str] = None
    interview_location: Optional[str] = None
    alternative_jobs: Optional[list] = None


def _require_api_key_webhook(api_key: Optional[str]) -> None:
    """Validate the shared chatbot API key for webhook endpoints. Supports dual-key rotation."""
    import os
    expected = settings.chatbot_api_key
    expected_old = getattr(settings, 'chatbot_api_key_old', None) or os.getenv("CHATBOT_API_KEY_OLD")
    if not expected:
        raise HTTPException(
            status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Chatbot API key is not configured",
        )
    if not api_key:
        raise HTTPException(
            status_code=http_status.HTTP_401_UNAUTHORIZED,
            detail="Invalid API key",
        )
    if api_key == expected:
        return
    if expected_old and api_key == expected_old:
        return
    raise HTTPException(
        status_code=http_status.HTTP_401_UNAUTHORIZED,
        detail="Invalid API key",
    )


@router.post("/candidate-status")
async def candidate_status_webhook(
    payload: CandidateStatusPayload,
    x_chatbot_api_key: Optional[str] = Header(None),
):
    """
    POST /webhook/candidate-status
    Receives candidate status updates from the recruitment system
    and sends a proactive WhatsApp message to the candidate.
    """
    _require_api_key_webhook(x_chatbot_api_key)

    phone = payload.candidate_phone
    status_key = payload.status.lower().strip()

    # Look up the candidate's preferred language
    try:
        db = SessionLocal()
        from app.models import Candidate
        candidate = db.query(Candidate).filter(
            Candidate.phone_number == phone
        ).first()
        lang = "en"
        if candidate:
            extracted = candidate.extracted_data or {}
            lang = extracted.get("language_register") or getattr(
                candidate.language_preference, "value", "en"
            )
        db.close()
    except Exception as e:
        logger.warning(f"Could not look up language for {phone}: {e}")
        lang = "en"

    # Build status message from templates
    from app.llm.prompt_templates import PromptTemplates
    message = PromptTemplates.get_status_update_message(
        status=status_key,
        lang=lang,
        candidate_name=payload.candidate_name,
        job_title=payload.job_title,
        interview_date=payload.interview_date,
        interview_location=payload.interview_location,
        alternative_jobs=payload.alternative_jobs,
    )

    if not message:
        logger.warning(f"No status template for status={status_key}, lang={lang}")
        return {"status": "skipped", "reason": f"Unknown status: {status_key}"}

    # Send the WhatsApp message
    try:
        result = await meta_client.send_message(phone, message)
        if "error" in result:
            logger.error(f"Failed to send status update to {phone}: {result}")
            return {"status": "error", "detail": str(result.get("error"))}

        logger.info(
            f"Status update sent to {phone}: status={status_key}, lang={lang}"
        )
        return {"status": "sent", "message_id": result.get("messages", [{}])[0].get("id")}
    except Exception as e:
        logger.error(f"Error sending status update to {phone}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to send message: {e}")


# ΓöÇΓöÇΓöÇ Agent Handoff Endpoint ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
# Called by the recruitment system Node.js backend when an agent clicks
# "Take Over" or "Release to Bot" in the Communications dashboard.
# This prevents the chatbot from auto-responding while a human agent is active.

class AgentHandoffPayload(BaseModel):
    phone: str                  # E.164 phone number of the candidate
    is_handoff: bool            # True = agent takes over, False = release back to bot
    agent_name: Optional[str] = None


# In-memory set of phone numbers currently under human control.
# For multi-instance deployments, replace with a Redis set or DB flag check.
_HUMAN_CONTROLLED_PHONES: set = set()


@router.post("/agent-handoff", tags=["Agent Handoff"])
async def agent_handoff(payload: AgentHandoffPayload):
    """
    Toggle human agent control for a WhatsApp conversation.

    When is_handoff=True:
      - Chatbot stops responding to messages from this phone
      - The agent replies directly via the recruitment system dashboard

    When is_handoff=False:
      - Chatbot resumes conversation from where it left off
    """
    phone = payload.phone.strip()
    if not phone:
        raise HTTPException(status_code=400, detail="phone is required")

    # Verify request is from the recruitment system (uses same chatbot API key)
    # (Auth is handled at the router level via x-chatbot-api-key in production;
    #  here we just verify the key if it's in the settings)
    # Note: for a minimal integration, the recruitment system can call this
    # from its server-side code using the shared CHATBOT_API_KEY.

    if payload.is_handoff:
        _HUMAN_CONTROLLED_PHONES.add(phone)
        # Also persist flag in the candidate's extracted_data so it survives restarts
        db = SessionLocal()
        try:
            from app import crud
            cand = crud.get_candidate_by_phone(db, phone)
            if cand:
                data = cand.extracted_data or {}
                data["is_human_handoff"] = True
                data["agent_name"] = payload.agent_name or "Agent"
                cand.extracted_data = data
                db.commit()
        except Exception as _e:
            logger.warning(f"agent-handoff: could not persist flag for {phone}: {_e}")
        finally:
            db.close()

        logger.info(f"≡ƒÖï Agent handoff: {payload.agent_name or 'Agent'} took over {phone}")
        return {"status": "handoff_active", "phone": phone}

    else:
        _HUMAN_CONTROLLED_PHONES.discard(phone)
        db = SessionLocal()
        try:
            from app import crud
            cand = crud.get_candidate_by_phone(db, phone)
            if cand:
                data = cand.extracted_data or {}
                data.pop("is_human_handoff", None)
                data.pop("agent_name", None)
                cand.extracted_data = data
                db.commit()
        except Exception as _e:
            logger.warning(f"agent-handoff: could not clear flag for {phone}: {_e}")
        finally:
            db.close()

        logger.info(f"≡ƒñû Bot resumed control for {phone}")
        return {"status": "bot_resumed", "phone": phone}


def is_human_controlled(phone: str) -> bool:
    """Check if a phone number is currently under human agent control."""
    if phone in _HUMAN_CONTROLLED_PHONES:
        return True
    return False

~~~

Current code:
~~~
"""
WhatsApp Webhook Handlers
=========================
Handles incoming webhooks from Meta WhatsApp Business API.
Processes messages and triggers the chatbot engine.

FIX: Background tasks now create their OWN database session
     instead of reusing the request's session (which is closed
     by FastAPI before the background task runs).
"""

import asyncio
import logging
import os
import traceback
import time
from typing import Optional

import httpx

from fastapi import APIRouter, Request, HTTPException, Query, BackgroundTasks, Header
from starlette import status as http_status
from pydantic import BaseModel

from app.database import SessionLocal
from app import crud
from app.utils.meta_client import meta_client
from app.chatbot import chatbot
from app.services.voice_service import voice_service
from app.config import settings
from app.nlp.language_detector import is_greeting

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/webhook", tags=["WhatsApp Webhook"])

# â”€â”€â”€ Message Deduplication Cache â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Stores (message_id -> timestamp) for recently-processed messages.
# Meta sometimes retries webhook delivery â€” this prevents duplicate responses.
_PROCESSED_MSG_TTL = 300  # 5 minutes
_processed_messages: dict = {}   # {msg_id: processed_at_epoch}


class CandidateStatusWebhook(BaseModel):
    candidate_phone: str
    status: str
    candidate_name: Optional[str] = None
    job_title: Optional[str] = None
    interview_date: Optional[str] = None
    interview_location: Optional[str] = None
    alternative_jobs: Optional[list[str]] = None


def _is_duplicate(message_id: str) -> bool:
    """Return True if this message was already processed recently."""
    now = time.time()
    # Expire old entries opportunistically
    expired = [mid for mid, ts in _processed_messages.items() if now - ts > _PROCESSED_MSG_TTL]
    for mid in expired:
        _processed_messages.pop(mid, None)

    if message_id in _processed_messages:
        logger.info(f"â­ï¸ Skipping duplicate message id={message_id}")
        return True
    _processed_messages[message_id] = now
    return False


def _require_chatbot_api_key(provided_key: Optional[str]) -> bool:
    """Validate the shared chatbot API key, allowing old-key rotation."""
    expected_key = settings.chatbot_api_key
    expected_old_key = getattr(settings, 'chatbot_api_key_old', None) or os.getenv('CHATBOT_API_KEY_OLD')

    if not expected_key:
        logger.error("CHATBOT_API_KEY is not configured for candidate status webhook")
        raise HTTPException(status_code=http_status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Server misconfiguration")

    if not provided_key:
        raise HTTPException(status_code=http_status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")

    if provided_key == expected_key or (expected_old_key and provided_key == expected_old_key):
        return True

    raise HTTPException(status_code=http_status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")


def _status_message(language: str, status: str, candidate_name: str, job_title: str,
                    interview_date: Optional[str], interview_location: Optional[str],
                    alternative_jobs: Optional[list[str]]) -> str:
    """Build a short status update message in the candidate's register."""
    first_name = (candidate_name or "").split()[0] if candidate_name else ""
    alt_line = ""
    if alternative_jobs:
        alt_line = "\n\n" + ", ".join(alternative_jobs[:3])

    templates = {
        'shortlisted': {
            'en': f"Hi{', ' + first_name if first_name else ''}! Good news â€” your application for {job_title} has been shortlisted.",
            'si': f"à·„à·œà¶³ à¶†à¶»à¶‚à¶ à·’à¶ºà¶šà·Š{', ' + first_name if first_name else ''}! {job_title} à·ƒà¶³à·„à· à¶”à¶¶à¶œà·š à¶…à¶ºà¶¯à·”à¶¸à·Šà¶´à¶­ shortlist à¶šà¶» à¶‡à¶­.",
            'ta': f"à®¨à®²à¯à®² à®šà¯†à®¯à¯à®¤à®¿{', ' + first_name if first_name else ''}! {job_title} à®ªà®£à®¿à®•à¯à®•à®¾à®© à®‰à®™à¯à®•à®³à¯ à®µà®¿à®£à¯à®£à®ªà¯à®ªà®®à¯ shortlist à®šà¯†à®¯à¯à®¯à®ªà¯à®ªà®Ÿà¯à®Ÿà¯à®³à¯à®³à®¤à¯.",
            'singlish': f"Niyamai{', ' + first_name if first_name else ''}! {job_title} application eka shortlist kala.",
            'tanglish': f"Super news{', ' + first_name if first_name else ''}! {job_title} application shortlist aayiduchu.",
        },
        'interview_scheduled': {
            'en': f"Hi{', ' + first_name if first_name else ''}! Your interview for {job_title} is scheduled for {interview_date or 'soon'} at {interview_location or 'our office'}.",
            'si': f"{first_name + ', ' if first_name else ''}à¶”à¶¶à¶œà·š {job_title} à·ƒà¶¯à·„à· à·ƒà¶¸à·Šà¶¸à·”à¶› à¶´à¶»à·“à¶šà·Šà·‚à¶«à¶º {interview_date or 'à¶‰à¶šà·Šà¶¸à¶±à·’à¶±à·Š'} à¶¯à·’à¶± {interview_location or 'à¶…à¶´à¶œà·š à¶šà·à¶»à·Šà¶ºà·à¶½à¶ºà·š'} à¶´à·à·€à·à¶­à·Šà·€à·š.",
            'ta': f"{first_name + ', ' if first_name else ''}{job_title} à®ªà®£à®¿à®•à¯à®•à®¾à®© interview {interview_date or 'à®µà®¿à®°à¯ˆà®µà®¿à®²à¯'} {interview_location or 'à®Žà®™à¯à®•à®³à¯ à®…à®²à¯à®µà®²à®•à®¤à¯à®¤à®¿à®²à¯'} à®¨à®Ÿà¯ˆà®ªà¯†à®±à¯à®®à¯.",
            'singlish': f"{first_name + ', ' if first_name else ''}{job_title} interview eka {interview_date or 'soon'} {interview_location or 'office'} wala tiyenawa.",
            'tanglish': f"{first_name + ', ' if first_name else ''}{job_title} interview {interview_date or 'soon'} {interview_location or 'office'}-la nadakkum.",
        },
        'hired': {
            'en': f"Congratulations{', ' + first_name if first_name else ''}! You have been selected for {job_title}.",
            'si': f"à·ƒà·”à¶· à¶´à·à¶­à·”à¶¸à·Š{', ' + first_name if first_name else ''}! à¶”à¶¶ {job_title} à·ƒà¶³à·„à· à¶­à·à¶»à·à¶œà·™à¶± à¶‡à¶­.",
            'ta': f"à®µà®¾à®´à¯à®¤à¯à®¤à¯à®•à®³à¯{', ' + first_name if first_name else ''}! à®¨à¯€à®™à¯à®•à®³à¯ {job_title} à®ªà®£à®¿à®•à¯à®•à¯à®¤à¯ à®¤à¯‡à®°à¯à®¨à¯à®¤à¯†à®Ÿà¯à®•à¯à®•à®ªà¯à®ªà®Ÿà¯à®Ÿà¯à®³à¯à®³à¯€à®°à¯à®•à®³à¯.",
            'singlish': f"Congratulations{', ' + first_name if first_name else ''}! Oya {job_title} walata select wela.",
            'tanglish': f"Congratulations{', ' + first_name if first_name else ''}! Neenga {job_title} ku select aayitinga.",
        },
        'rejected_with_alternatives': {
            'en': f"Thanks{', ' + first_name if first_name else ''}. We couldn't move forward with {job_title} this time, but we found other roles you may like.{alt_line}",
            'si': f"à·ƒà·Šà¶­à·–à¶­à·’à¶ºà·’{', ' + first_name if first_name else ''}. à¶¸à·š à·€à¶» {job_title} à·ƒà¶³à·„à· à¶‰à¶¯à·’à¶»à·’à¶ºà¶§ à¶ºà· à¶±à·œà·„à·à¶šà·’ à·€à·”à¶«à·, à¶±à¶¸à·”à¶­à·Š à·€à·™à¶±à¶­à·Š à¶»à·à¶šà·’à¶ºà· à¶”à¶¶à¶§ à¶œà·à·…à¶´à·™à¶±à·Šà¶± à¶´à·”à·…à·”à·€à¶±à·Š.{alt_line}",
            'ta': f"à®¨à®©à¯à®±à®¿{', ' + first_name if first_name else ''}. à®‡à®¨à¯à®¤ à®®à¯à®±à¯ˆ {job_title} à®ªà®£à®¿à®•à¯à®•à®¾à®• à®¤à¯Šà®Ÿà®° à®®à¯à®Ÿà®¿à®¯à®µà®¿à®²à¯à®²à¯ˆ, à®†à®©à®¾à®²à¯ à®‰à®™à¯à®•à®³à¯à®•à¯à®•à¯ à®ªà¯Šà®°à¯à®¨à¯à®¤à®•à¯à®•à¯‚à®Ÿà®¿à®¯ à®µà¯‡à®±à¯ à®µà®¾à®¯à¯à®ªà¯à®ªà¯à®•à®³à¯ à®‰à®³à¯à®³à®©.{alt_line}",
            'singlish': f"Thanks{', ' + first_name if first_name else ''}. Me wela {job_title} walata à¶‰à¶¯à·’à¶»à·’à¶ºà¶§ yanna behe une, eth wena jobs tiyenawa.{alt_line}",
            'tanglish': f"Thanks{', ' + first_name if first_name else ''}. Ippo {job_title} ku proceed panna mudiyala, aana vera roles irukku.{alt_line}",
        },
    }

    status_map = templates.get(status, templates['shortlisted'])
    return status_map.get(language, status_map['en'])


# â”€â”€â”€ Webhook Verification (GET) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

@router.get("/whatsapp")
async def verify_webhook(
    hub_mode: Optional[str] = Query(None, alias="hub.mode"),
    hub_challenge: Optional[str] = Query(None, alias="hub.challenge"),
    hub_verify_token: Optional[str] = Query(None, alias="hub.verify_token")
):
    """
    Meta webhook verification endpoint.
    Called by Meta when setting up the webhook URL.
    """
    logger.info(
        f"Webhook verification request â†’ mode={hub_mode}, "
        f"token={hub_verify_token}, challenge={hub_challenge}"
    )

    if hub_mode == "subscribe" and hub_verify_token == settings.meta_verify_token:
        logger.info("âœ… Webhook verification successful")
        from fastapi.responses import PlainTextResponse
        return PlainTextResponse(content=hub_challenge, status_code=200)

    logger.warning(
        f"âŒ Webhook verification FAILED â€” "
        f"expected token '{settings.meta_verify_token}', got '{hub_verify_token}'"
    )
    raise HTTPException(status_code=403, detail="Verification failed")


@router.post("/candidate-status")
async def candidate_status_webhook(
    payload: CandidateStatusWebhook,
    x_chatbot_api_key: Optional[str] = Header(default=None, alias="x-chatbot-api-key"),
):
    """Receive recruiter-side status updates and notify the candidate by WhatsApp."""
    _require_chatbot_api_key(x_chatbot_api_key)

    db = SessionLocal()
    try:
        candidate = crud.get_candidate_by_phone(db, payload.candidate_phone)
        if not candidate:
            normalized = payload.candidate_phone.replace(" ", "").replace("-", "")
            if normalized.startswith("+"):
                candidate = crud.get_candidate_by_phone(db, normalized.lstrip("+"))
            else:
                candidate = crud.get_candidate_by_phone(db, f"+{normalized}")

        if not candidate:
            raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="Candidate not found")

        language = getattr(candidate.language_preference, 'value', None) or (candidate.extracted_data or {}).get('language_register') or 'en'
        message = _status_message(
            language=language,
            status=payload.status,
            candidate_name=payload.candidate_name or candidate.name or 'Candidate',
            job_title=payload.job_title or 'your applied position',
            interview_date=payload.interview_date,
            interview_location=payload.interview_location,
            alternative_jobs=payload.alternative_jobs,
        )

        await meta_client.send_message(candidate.phone_number, message)

        logger.info(
            f"Candidate status webhook delivered for candidate={candidate.id} status={payload.status}"
        )
        return {"status": "ok", "candidate_id": candidate.id, "delivered": True}
    finally:
        db.close()


# â”€â”€â”€ Incoming Messages (POST) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

@router.post("/whatsapp")
async def handle_webhook(
    request: Request,
    background_tasks: BackgroundTasks,
):
    """
    Handle incoming WhatsApp messages from Meta webhook.
    Returns 200 immediately; processes message in background.
    """
    try:
        body_bytes = await request.body()

        # Signature verification (skipped if APP_SECRET not configured)
        signature = request.headers.get("X-Hub-Signature-256", "")
        if signature and settings.meta_app_secret:
            if not meta_client.verify_webhook(body_bytes, signature):
                logger.warning("âŒ Invalid webhook signature â€” rejecting request")
                raise HTTPException(status_code=401, detail="Invalid signature")

        data = await request.json()
        logger.info(f"ðŸ“¨ Webhook received: object={data.get('object', 'unknown')}")
        logger.debug(f"Webhook payload: {data}")

        # Queue each message for background processing via FastAPI BackgroundTasks
        
        entries = data.get("entry", [])
        for entry in entries:
            for change in entry.get("changes", []):
                if change.get("field") == "messages":
                    value = change.get("value", {})
                    background_tasks.add_task(process_webhook_value, value)
                    logger.info("Background task queued via FastAPI BackgroundTasks")

        return {"status": "ok"}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Webhook handler error: {e}\n{traceback.format_exc()}")
        # Always return 200 to prevent Meta from retrying endlessly
        return {"status": "error", "message": str(e)}


# â”€â”€â”€ Background Processing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async def process_webhook_value(value: dict):
    """
    Process a webhook 'value' payload in the background.
    Creates its OWN database session â€” critical fix for FastAPI background tasks.
    """
    messages  = value.get("messages", [])
    contacts  = value.get("contacts", [])
    statuses  = value.get("statuses", [])

    # Log delivery statuses (optional, non-critical)
    for status in statuses:
        logger.debug(
            f"Message status update: id={status.get('id')} "
            f"status={status.get('status')} to={status.get('recipient_id')}"
        )

    if not messages:
        logger.debug("No messages in webhook value â€” skipping")
        return

    for message in messages:
        # âœ… Fresh DB session per message
        db = SessionLocal()
        try:
            await process_single_message(message, contacts, db)
            db.commit()
        except Exception as e:
            db.rollback()
            logger.error(
                f"Error processing message {message.get('id')}: {e}\n"
                f"{traceback.format_exc()}"
            )
            # Try to send an error reply so the user isn't left hanging
            from_number = message.get("from")
            if from_number:
                try:
                    await meta_client.send_message(
                        from_number,
                        "I'm sorry, I encountered an error. Please try again in a moment."
                    )
                except Exception as send_err:
                    logger.error(f"Failed to send error reply: {send_err}")
        finally:
            db.close()


# â”€â”€â”€ Recruitment System Chat Sync â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async def _sync_chat_message(
    phone: str,
    direction: str,
    content: str,
    language: str = "en",
    chatbot_state: str = "",
) -> None:
    """
    Push a single message (inbound customer msg or outbound bot reply)
    to the recruitment system's chat sync endpoint so agents see the
    full conversation without waiting for application completion.

    Fire-and-forget: any failure is logged but never propagates.

    Args:
        phone:         E.164-formatted customer phone number.
        direction:     "inbound" (customer â†’ bot) or "outbound" (bot â†’ customer).
        content:       Message text.
        language:      Detected language code (en/si/ta/singlish/tanglish).
        chatbot_state: Current conversation state name for agent context.
    """
    try:
        recruitment_url = settings.recruitment_api_url or ""
        api_key         = settings.chatbot_api_key or ""
        if not recruitment_url or not api_key:
            return  # Not configured â€” skip silently

        payload = {
            "phone":         phone,
            "direction":     direction,
            "content":       content[:2000],  # Truncate to avoid oversized payloads
            "message_type":  "text",
            "language":      language,
            "chatbot_state": chatbot_state,
        }
        async with httpx.AsyncClient(timeout=4.0) as client:
            resp = await client.post(
                f"{recruitment_url}/api/chatbot/sync-message",
                headers={"x-chatbot-api-key": api_key},
                json=payload,
            )
            if resp.status_code not in (200, 201):
                logger.debug(
                    f"Chat sync returned {resp.status_code} for {phone} â€” "
                    f"endpoint may not exist yet (Plan 2)"
                )
    except Exception as _sync_err:
        # Non-critical â€” never block message processing
        logger.debug(f"_sync_chat_message skipped: {_sync_err}")


async def process_single_message(message: dict, contacts: list, db):
    """Process a single incoming WhatsApp message."""

    async def _safe_process_message(**kwargs):
        try:
            return await asyncio.wait_for(chatbot.process_message(**kwargs), timeout=45)
        except asyncio.TimeoutError:
            logger.error("chatbot.process_message timed out after 45s")
            return "Sorry, I'm taking too long to respond right now. Please try again in a moment."
        except Exception as exc:
            logger.error(f"chatbot.process_message failed: {exc}")
            return "Oops, something went wrong on my end. Please try again."

    message_id   = message.get("id")
    from_number  = message.get("from")
    message_type = message.get("type")

    if not from_number:
        logger.warning("Message missing 'from' field â€” skipping")
        return

    # â”€â”€ Deduplication: skip if we already processed this message â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if message_id and _is_duplicate(message_id):
        return  # Meta retried a webhook we already handled

    logger.info(
        f"ðŸ“© Processing message id={message_id} from={from_number} type={message_type}"
    )


    # Mark as read immediately
    try:
        await meta_client.mark_as_read(message_id)
    except Exception as e:
        logger.warning(f"Could not mark message as read: {e}")

    response_text = None

    # â”€â”€ Text message â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if message_type == "text":
        text_body = message.get("text", {}).get("body", "")
        logger.info(f"ðŸ’¬ Text from {from_number}: {text_body!r}")

        # Fast-path: for simple greetings in early onboarding states, send language selector
        # immediately and skip heavy chatbot orchestration.
        try:
            greet, _ = is_greeting(text_body)
            if greet:
                candidate = crud.get_or_create_candidate(db, from_number)
                if candidate.conversation_state in ("initial", "awaiting_language_selection"):
                    sel = await meta_client.send_language_selector(from_number)
                    if sel and "error" not in sel:
                        logger.info(f"Fast-path language selector sent to {from_number}")
                        return
                    fallback_text = (
                        "Welcome! Please choose your preferred language.\n"
                        "1) English\n2) à·ƒà·’à¶‚à·„à¶½\n3) à®¤à®®à®¿à®´à¯"
                    )
                    send_res = await meta_client.send_message(from_number, fallback_text)
                    if send_res and "error" not in send_res:
                        logger.info(f"Fast-path language fallback sent to {from_number}")
                        return
        except Exception as fast_path_err:
            logger.warning(f"Greeting fast-path failed: {fast_path_err}")

        response_text = await _safe_process_message(
            db=db,
            phone_number=from_number,
            message_text=text_body
        )

    # â”€â”€ Document (CV upload) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    elif message_type == "document":
        document  = message.get("document", {})
        media_id  = document.get("id")
        filename  = document.get("filename", "document.pdf")
        mime_type = document.get("mime_type", "")

        logger.info(f"ðŸ“Ž Document from {from_number}: {filename} ({mime_type})")

        allowed_types = [
            "application/pdf",
            "application/msword",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ]

        if mime_type in allowed_types or filename.lower().endswith((".pdf", ".doc", ".docx")):
            file_content = await meta_client.download_media(media_id)
            if file_content:
                response_text = await _safe_process_message(
                    db=db,
                    phone_number=from_number,
                    media_content=file_content,
                    media_type="document",
                    media_filename=filename
                )
            else:
                response_text = "I couldn't download your document. Please try sending it again."
        else:
            response_text = "Please send your CV as a PDF or Word document (.pdf / .doc / .docx)."

    # â”€â”€ Image (CV as photo / scan) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    elif message_type == "image":
        image     = message.get("image", {})
        media_id  = image.get("id")
        mime_type = image.get("mime_type", "image/jpeg")

        logger.info(f"ðŸ–¼ï¸ Image from {from_number}")

        ext_map  = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}
        filename = f"cv_image{ext_map.get(mime_type, '.jpg')}"

        file_content = await meta_client.download_media(media_id)
        if file_content:
            response_text = await _safe_process_message(
                db=db,
                phone_number=from_number,
                media_content=file_content,
                media_type="document",
                media_filename=filename
            )
        else:
            response_text = (
                "I couldn't download your image. "
                "Please try again, or send your CV as a PDF for best results."
            )

    # â”€â”€ Audio / Voice message â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    elif message_type == "audio":
        audio    = message.get("audio", {})
        media_id = audio.get("id")
        mime     = audio.get("mime_type", "audio/ogg")

        logger.info(f"ðŸŽ¤ Voice message from {from_number} ({mime})")

        if not voice_service.available:
            response_text = (
                "I can't process voice messages right now. "
                "Could you type your message instead? ðŸ˜Š"
            )
        else:
            audio_bytes = await meta_client.download_media(media_id)
            if audio_bytes:
                # Determine language hint from candidate's stored preference
                cand = crud.get_or_create_candidate(db, from_number)
                lang_hint = cand.language_preference.value

                ext_map = {"audio/ogg": "voice.ogg", "audio/mpeg": "voice.mp3",
                           "audio/mp4": "voice.m4a", "audio/aac": "voice.aac"}
                fname = ext_map.get(mime.split(";")[0], "voice.ogg")

                transcribed = await voice_service.transcribe(
                    audio_bytes, language_hint=lang_hint, filename=fname
                )
                if transcribed:
                    logger.info(f"ðŸŽ¤â†’ðŸ’¬ Transcribed: {transcribed[:80]!r}")
                    response_text = await _safe_process_message(
                        db=db, phone_number=from_number, message_text=transcribed
                    )
                else:
                    response_text = (
                        "I couldn't understand that voice message. "
                        "Could you try again or type your message? ðŸ™"
                    )
            else:
                response_text = (
                    "I couldn't download your voice message. Please try again."
                )

    # â”€â”€ Interactive (button / list reply) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    elif message_type == "interactive":
        interactive      = message.get("interactive", {})
        interactive_type = interactive.get("type")

        if interactive_type == "button_reply":
            btn_id    = interactive.get("button_reply", {}).get("id", "")
            btn_title = interactive.get("button_reply", {}).get("title", "")
            # Map button IDs to canonical text so the chatbot state machine
            # doesn't need to be aware of button IDs directly.
            _button_id_map = {
                "lang_en": "English",
                "lang_si": "Sinhala",
                "lang_ta": "Tamil",
                "action_apply": "apply",
                "action_vacancies": "what are the available vacancies",
                "action_question": "I have a question",
            }
            text_to_send = _button_id_map.get(btn_id, btn_title or btn_id)
            logger.info(
                f"ðŸ”˜ Button reply from {from_number}: id={btn_id!r} title={btn_title!r} "
                f"â†’ routing as: {text_to_send!r}"
            )
            response_text = await _safe_process_message(
                db=db, phone_number=from_number, message_text=text_to_send
            )

        elif interactive_type == "list_reply":
            list_id    = interactive.get("list_reply", {}).get("id", "")
            list_title = interactive.get("list_reply", {}).get("title", "")
            # Use exact list_id for structured tracking, otherwise fallback to title
            text_to_send = list_id if list_id.startswith("job_") or list_id == "skip" else (list_title or list_id)
            logger.info(
                f"ðŸ“‹ List reply from {from_number}: id={list_id!r} title={list_title!r}"
            )
            response_text = await _safe_process_message(
                db=db, phone_number=from_number, message_text=text_to_send
            )

    # â”€â”€ Unsupported type â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    else:
        logger.info(f"Unsupported message type '{message_type}' from {from_number}")
        response_text = (
            "I can receive text messages, voice messages, and document uploads (PDF/Word). "
            "How can I assist you?"
        )

    # â”€â”€ Send reply â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if response_text:
        if isinstance(response_text, dict):
            msg_type = response_text.get("type")
            if msg_type == "list":
                logger.info(f"ðŸ“¤ Sending interactive list to {from_number}")
                result = await meta_client.send_list_message(
                    to_number=from_number,
                    body_text=response_text.get("body_text", ""),
                    button_label=response_text.get("button_label", "Options"),
                    sections=response_text.get("sections", []),
                    header_text=response_text.get("header_text"),
                    footer_text=response_text.get("footer_text")
                )
                response_text = "[Interactive List]"  # for sync logging
            elif msg_type == "buttons":
                logger.info(f"ðŸ“¤ Sending interactive buttons to {from_number}")
                result = await meta_client.send_interactive_buttons(
                    to_number=from_number,
                    body_text=response_text.get("body_text", ""),
                    buttons=response_text.get("buttons", []),
                    header_text=response_text.get("header_text"),
                    footer_text=response_text.get("footer_text")
                )
                response_text = "[Interactive Buttons]"
            else:
                logger.error(f"Unknown structured message type: {msg_type}")
                result = None
                response_text = "[Unrecognized Format Error]"
        elif "__INTERACTIVE_LANGUAGE_SELECTOR__" in response_text:
            parts = response_text.split("__INTERACTIVE_LANGUAGE_SELECTOR__")
            prefix_text = parts[0].strip()
            
            # Send the prefix message if it exists (e.g. "Hey User! ðŸ˜Š")
            if prefix_text:
                await meta_client.send_message(from_number, prefix_text)
                await asyncio.sleep(0.5)  # slight delay to ensure correct order
                
            logger.info(f"ðŸ“¤ Sending interactive language selector to {from_number}")
            result = await meta_client.send_language_selector(from_number)
            
            # Remove the flag so the sync doesn't have the ugly token
            response_text = response_text.replace("__INTERACTIVE_LANGUAGE_SELECTOR__", "[Interactive Language Selector]")
        else:
            logger.info(f"ðŸ“¤ Sending reply to {from_number}: {response_text[:80]}...")
            result = await meta_client.send_message(from_number, response_text)

        if result and "error" in result:
            logger.error(f"âŒ Failed to send message to {from_number}: {result}")
        else:
            # Safely handle dict or missing 'messages' key
            msg_id_sent = "N/A"
            if isinstance(result, dict):
                msgs = result.get('messages', [])
                if msgs and isinstance(msgs, list) and isinstance(msgs[0], dict):
                    msg_id_sent = msgs[0].get('id', 'N/A')
            logger.info(f"âœ… Reply sent to {from_number} â€” msg_id={msg_id_sent}")

        # â”€â”€ Sync both messages to recruitment system communications table â”€â”€â”€â”€â”€â”€
        # Runs concurrently after the reply is sent. Failures are swallowed.
        try:
            # Look up candidate's current state + language for agent context
            from app import crud as _crud
            _cand = _crud.get_or_create_candidate(db, from_number)
            _lang  = getattr(_cand.language_preference, "value", "en")
            _state = _cand.conversation_state or ""
            _inbound_text = (
                message.get("text", {}).get("body")
                or message.get("document", {}).get("filename")
                or f"[{message_type} message]"
            )
            await asyncio.gather(
                _sync_chat_message(from_number, "inbound",  _inbound_text, _lang, _state),
                _sync_chat_message(from_number, "outbound", response_text,  _lang, _state),
            )
        except Exception as _sc_err:
            logger.debug(f"Chat sync gather error: {_sc_err}")
    else:
        logger.warning(f"No response generated for message from {from_number}")


# â”€â”€â”€ Agent Handoff Endpoint â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
# Called by the recruitment system Node.js backend when an agent clicks
# "Take Over" or "Release to Bot" in the Communications dashboard.
# This prevents the chatbot from auto-responding while a human agent is active.

class AgentHandoffPayload(BaseModel):
    phone: str                  # E.164 phone number of the candidate
    is_handoff: bool            # True = agent takes over, False = release back to bot
    agent_name: Optional[str] = None


# In-memory set of phone numbers currently under human control.
# For multi-instance deployments, replace with a Redis set or DB flag check.
_HUMAN_CONTROLLED_PHONES: set = set()


@router.post("/agent-handoff", tags=["Agent Handoff"])
async def agent_handoff(
    payload: AgentHandoffPayload,
    x_chatbot_api_key: Optional[str] = Header(default=None, alias="x-chatbot-api-key"),
):
    """
    Toggle human agent control for a WhatsApp conversation.

    When is_handoff=True:
      - Chatbot stops responding to messages from this phone
      - The agent replies directly via the recruitment system dashboard

    When is_handoff=False:
      - Chatbot resumes conversation from where it left off
    """
    phone = payload.phone.strip()
    if not phone:
        raise HTTPException(status_code=400, detail="phone is required")

    _require_chatbot_api_key(x_chatbot_api_key)

    if payload.is_handoff:
        _HUMAN_CONTROLLED_PHONES.add(phone)
        # Also persist flag in the candidate's extracted_data so it survives restarts
        db = SessionLocal()
        try:
            from app import crud
            cand = crud.get_candidate_by_phone(db, phone)
            if cand:
                data = cand.extracted_data or {}
                data["is_human_handoff"] = True
                data["agent_name"] = payload.agent_name or "Agent"
                cand.extracted_data = data
                db.commit()
        except Exception as _e:
            logger.warning(f"agent-handoff: could not persist flag for {phone}: {_e}")
        finally:
            db.close()

        logger.info(f"ðŸ™‹ Agent handoff: {payload.agent_name or 'Agent'} took over {phone}")
        return {"status": "handoff_active", "phone": phone}

    else:
        _HUMAN_CONTROLLED_PHONES.discard(phone)
        db = SessionLocal()
        try:
            from app import crud
            cand = crud.get_candidate_by_phone(db, phone)
            if cand:
                data = cand.extracted_data or {}
                data.pop("is_human_handoff", None)
                data.pop("agent_name", None)
                cand.extracted_data = data
                db.commit()
        except Exception as _e:
            logger.warning(f"agent-handoff: could not clear flag for {phone}: {_e}")
        finally:
            db.close()

        logger.info(f"ðŸ¤– Bot resumed control for {phone}")
        return {"status": "bot_resumed", "phone": phone}


def is_human_controlled(phone: str) -> bool:
    """Check if a phone number is currently under human agent control."""
    if phone in _HUMAN_CONTROLLED_PHONES:
        return True
    return False


~~~

## recruitment-system/backend/src/config/migrations.js

Previous code:
~~~
/**
 * Auto-Migration Module
 * =====================
 * Applies all pending schema column additions idempotently on startup.
 * All statements use IF NOT EXISTS so they are safe to re-run.
 *
 * Called once from server.js before the HTTP server starts.
 */

const { query } = require('./database');
const logger = require('../utils/logger');

/** Run a single DDL statement and swallow "already exists" noise. */
async function safeAlter(sql, label) {
    try {
        await query(sql, []);
        logger.info(`  migration: OK  ΓÇö ${label}`);
        return true;
    } catch (err) {
        const msg = (err.message || '').toLowerCase();
        if (msg.includes('already exists') || msg.includes('duplicate')) {
            logger.info(`  migration: skip ΓÇö ${label} (already exists)`);
            return true;
        }
        logger.warn(`  migration: WARN ΓÇö ${label}: ${err.message.split('\n')[0]}`);
        return false;
    }
}

async function applyMigrations() {
    logger.info('≡ƒöä Running startup migrations...');

    // ΓöÇΓöÇ Migration 004: ad_tracking table ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    await safeAlter(`
        CREATE TABLE IF NOT EXISTS ad_tracking (
            id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
            ad_ref        VARCHAR(100)  NOT NULL UNIQUE,
            job_id        UUID          NOT NULL REFERENCES jobs(id)     ON DELETE CASCADE,
            project_id    UUID          NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            campaign_name VARCHAR(255),
            whatsapp_link TEXT          NOT NULL,
            clicks        INT           NOT NULL DEFAULT 0,
            conversions   INT           NOT NULL DEFAULT 0,
            is_active     BOOLEAN       NOT NULL DEFAULT TRUE,
            created_by    UUID,
            created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
            updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
        )
    `, 'ad_tracking table');

    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_ad_job ON ad_tracking(job_id)`, 'idx_ad_job');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_ad_project ON ad_tracking(project_id)`, 'idx_ad_project');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_ad_ref ON ad_tracking(ad_ref)`, 'idx_ad_ref');

    // ΓöÇΓöÇ Migration 005: candidates extras ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    const candidateCols = [
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS skills               TEXT`, 'candidates.skills'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS experience_years      SMALLINT`, 'candidates.experience_years'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS highest_qualification VARCHAR(255)`, 'candidates.highest_qualification'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS whatsapp_phone        VARCHAR(50)`, 'candidates.whatsapp_phone'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS chatbot_ref           VARCHAR(100)`, 'candidates.chatbot_ref'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS ad_ref                VARCHAR(100)`, 'candidates.ad_ref'],
        [`CREATE INDEX IF NOT EXISTS idx_candidates_whatsapp ON candidates(whatsapp_phone)`, 'idx_candidates_whatsapp'],
        [`CREATE INDEX IF NOT EXISTS idx_candidates_ad_ref   ON candidates(ad_ref)`, 'idx_candidates_ad_ref'],
    ];

    for (const [sql, label] of candidateCols) {
        await safeAlter(sql, label);
    }

    // ΓöÇΓöÇ Migration 006: applications extras ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    const applicationCols = [
        [`ALTER TABLE applications ADD COLUMN IF NOT EXISTS certification_notes  TEXT`, 'applications.certification_notes'],
        [`ALTER TABLE applications ADD COLUMN IF NOT EXISTS transferred_from_job_id UUID REFERENCES jobs(id) ON DELETE SET NULL`, 'applications.transferred_from_job_id'],
        [`ALTER TABLE applications ADD COLUMN IF NOT EXISTS transfer_reason      TEXT`, 'applications.transfer_reason'],
        [`ALTER TABLE applications ADD COLUMN IF NOT EXISTS updated_at           TIMESTAMPTZ DEFAULT NOW()`, 'applications.updated_at'],
        [`CREATE INDEX IF NOT EXISTS idx_app_transferred ON applications(transferred_from_job_id)`, 'idx_app_transferred'],
    ];

    for (const [sql, label] of applicationCols) {
        await safeAlter(sql, label);
    }

    // ΓöÇΓöÇ Migration 007: duplicate detection support ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    await safeAlter(
        `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS merged_into_id UUID REFERENCES candidates(id) ON DELETE SET NULL`,
        'candidates.merged_into_id'
    );

    // ΓöÇΓöÇ Migration 008: interview_schedules table ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    await safeAlter(`
        CREATE TABLE IF NOT EXISTS interview_schedules (
            id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
            application_id      UUID         NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
            scheduled_datetime  TIMESTAMPTZ  NOT NULL,
            location            TEXT,
            interviewer_id      UUID         REFERENCES users(id),
            duration_minutes    INTEGER      NOT NULL DEFAULT 30,
            status              TEXT         NOT NULL DEFAULT 'scheduled',
            confirmation_sent_at TIMESTAMPTZ,
            reminder_sent_at    TIMESTAMPTZ,
            completed_at        TIMESTAMPTZ,
            feedback            TEXT,
            rating              SMALLINT     CHECK (rating BETWEEN 1 AND 5),
            created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            created_by          UUID         REFERENCES users(id)
        )
    `, 'interview_schedules table');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_interview_schedules_application ON interview_schedules(application_id)`, 'idx_iv_application');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_interview_schedules_datetime    ON interview_schedules(scheduled_datetime)`, 'idx_iv_datetime');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_interview_schedules_status      ON interview_schedules(status)`, 'idx_iv_status');

    // ΓöÇΓöÇ Migration 009: audit_logs table ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    await safeAlter(`
        CREATE TABLE IF NOT EXISTS audit_logs (
            id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id     UUID         REFERENCES users(id),
            action      TEXT         NOT NULL,
            entity_type TEXT         NOT NULL,
            entity_id   UUID,
            changes     JSONB,
            ip_address  TEXT,
            user_agent  TEXT,
            created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
    `, 'audit_logs table');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_audit_logs_user      ON audit_logs(user_id)`, 'idx_audit_user');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_audit_logs_entity    ON audit_logs(entity_type, entity_id)`, 'idx_audit_entity');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_audit_logs_created   ON audit_logs(created_at DESC)`, 'idx_audit_created');

    // ΓöÇΓöÇ Migration 010: Live Agent Chat support ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    // communications table: track who sent each message and the bot state at send time
    const commCols = [
        [`ALTER TABLE communications ADD COLUMN IF NOT EXISTS sender_type       VARCHAR(20)  DEFAULT 'bot'`, 'communications.sender_type'],
        [`ALTER TABLE communications ADD COLUMN IF NOT EXISTS sender_name       VARCHAR(255)`, 'communications.sender_name'],
        [`ALTER TABLE communications ADD COLUMN IF NOT EXISTS chatbot_state     VARCHAR(100)`, 'communications.chatbot_state'],
        [`ALTER TABLE communications ADD COLUMN IF NOT EXISTS detected_language VARCHAR(20)`, 'communications.detected_language'],
        [`CREATE INDEX IF NOT EXISTS idx_comm_candidate_sent ON communications(candidate_id, sent_at DESC)`, 'idx_comm_candidate_sent'],
    ];
    for (const [sql, label] of commCols) {
        await safeAlter(sql, label);
    }

    // candidates table: track live-agent handoff state
    const handoffCols = [
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS is_human_handoff      BOOLEAN      NOT NULL DEFAULT FALSE`, 'candidates.is_human_handoff'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS agent_id              UUID         REFERENCES users(id) ON DELETE SET NULL`, 'candidates.agent_id'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS handoff_at            TIMESTAMPTZ`, 'candidates.handoff_at'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS handoff_released_at   TIMESTAMPTZ`, 'candidates.handoff_released_at'],
        [`CREATE INDEX IF NOT EXISTS idx_candidates_handoff ON candidates(is_human_handoff) WHERE is_human_handoff = TRUE`, 'idx_candidates_handoff'],
    ];
    for (const [sql, label] of handoffCols) {
        await safeAlter(sql, label);
    }

    logger.info('Γ£à Startup migrations complete.');
}

module.exports = { applyMigrations };
~~~

Current code:
~~~
/**
 * Auto-Migration Module
 * =====================
 * Applies all pending schema column additions idempotently on startup.
 * All statements use IF NOT EXISTS so they are safe to re-run.
 *
 * Called once from server.js before the HTTP server starts.
 */

const { query } = require('./database');
const logger = require('../utils/logger');

/** Run a single DDL statement and swallow "already exists" noise. */
async function safeAlter(sql, label) {
    try {
        await query(sql, []);
        logger.info(`  migration: OK  â€” ${label}`);
        return true;
    } catch (err) {
        const msg = (err.message || '').toLowerCase();
        if (msg.includes('already exists') || msg.includes('duplicate')) {
            logger.info(`  migration: skip â€” ${label} (already exists)`);
            return true;
        }
        logger.warn(`  migration: WARN â€” ${label}: ${err.message.split('\n')[0]}`);
        return false;
    }
}

async function applyMigrations() {
    logger.info('ðŸ”„ Running startup migrations...');

    // â”€â”€ Migration 004: ad_tracking table â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    await safeAlter(`
        CREATE TABLE IF NOT EXISTS ad_tracking (
            id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
            ad_ref        VARCHAR(100)  NOT NULL UNIQUE,
            job_id        UUID          NOT NULL REFERENCES jobs(id)     ON DELETE CASCADE,
            project_id    UUID          NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            campaign_name VARCHAR(255),
            whatsapp_link TEXT          NOT NULL,
            clicks        INT           NOT NULL DEFAULT 0,
            conversions   INT           NOT NULL DEFAULT 0,
            is_active     BOOLEAN       NOT NULL DEFAULT TRUE,
            created_by    UUID,
            created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
            updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
        )
    `, 'ad_tracking table');

    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_ad_job ON ad_tracking(job_id)`, 'idx_ad_job');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_ad_project ON ad_tracking(project_id)`, 'idx_ad_project');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_ad_ref ON ad_tracking(ad_ref)`, 'idx_ad_ref');

    // â”€â”€ Migration 005: candidates extras â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const candidateCols = [
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS skills               TEXT`, 'candidates.skills'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS experience_years      SMALLINT`, 'candidates.experience_years'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS highest_qualification VARCHAR(255)`, 'candidates.highest_qualification'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS whatsapp_phone        VARCHAR(50)`, 'candidates.whatsapp_phone'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS chatbot_ref           VARCHAR(100)`, 'candidates.chatbot_ref'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS ad_ref                VARCHAR(100)`, 'candidates.ad_ref'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS conversation_stage    VARCHAR(50) DEFAULT 'new'`, 'candidates.conversation_stage'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS cv_uploaded           BOOLEAN NOT NULL DEFAULT FALSE`, 'candidates.cv_uploaded'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS full_name             VARCHAR(255)`, 'candidates.full_name'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS cv_status             VARCHAR(50) DEFAULT 'missing'`, 'candidates.cv_status'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS last_interaction      TIMESTAMPTZ`, 'candidates.last_interaction'],
        [`CREATE INDEX IF NOT EXISTS idx_candidates_whatsapp ON candidates(whatsapp_phone)`, 'idx_candidates_whatsapp'],
        [`CREATE INDEX IF NOT EXISTS idx_candidates_ad_ref   ON candidates(ad_ref)`, 'idx_candidates_ad_ref'],
        [`CREATE INDEX IF NOT EXISTS idx_candidates_conversation_stage ON candidates(conversation_stage)`, 'idx_candidates_conversation_stage'],
        [`CREATE INDEX IF NOT EXISTS idx_candidates_last_interaction ON candidates(last_interaction DESC)`, 'idx_candidates_last_interaction'],
    ];

    for (const [sql, label] of candidateCols) {
        await safeAlter(sql, label);
    }

    // â”€â”€ Migration 006: applications extras â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const applicationCols = [
        [`ALTER TABLE applications ADD COLUMN IF NOT EXISTS certification_notes  TEXT`, 'applications.certification_notes'],
        [`ALTER TABLE applications ADD COLUMN IF NOT EXISTS transferred_from_job_id UUID REFERENCES jobs(id) ON DELETE SET NULL`, 'applications.transferred_from_job_id'],
        [`ALTER TABLE applications ADD COLUMN IF NOT EXISTS transfer_reason      TEXT`, 'applications.transfer_reason'],
        [`ALTER TABLE applications ADD COLUMN IF NOT EXISTS updated_at           TIMESTAMPTZ DEFAULT NOW()`, 'applications.updated_at'],
        [`CREATE INDEX IF NOT EXISTS idx_app_transferred ON applications(transferred_from_job_id)`, 'idx_app_transferred'],
        [`CREATE INDEX IF NOT EXISTS idx_applications_applied_at ON applications(applied_at DESC)`, 'idx_applications_applied_at'],
        [`CREATE INDEX IF NOT EXISTS idx_applications_filter_combo ON applications(status, job_id, applied_at DESC)`, 'idx_applications_filter_combo'],
    ];

    for (const [sql, label] of applicationCols) {
        await safeAlter(sql, label);
    }

    // â”€â”€ Migration 007: duplicate detection support â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    await safeAlter(
        `ALTER TABLE candidates ADD COLUMN IF NOT EXISTS merged_into_id UUID REFERENCES candidates(id) ON DELETE SET NULL`,
        'candidates.merged_into_id'
    );

    // â”€â”€ Migration 008: interview_schedules table â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    await safeAlter(`
        CREATE TABLE IF NOT EXISTS interview_schedules (
            id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
            application_id      UUID         NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
            scheduled_datetime  TIMESTAMPTZ  NOT NULL,
            location            TEXT,
            interviewer_id      UUID         REFERENCES users(id),
            duration_minutes    INTEGER      NOT NULL DEFAULT 30,
            status              TEXT         NOT NULL DEFAULT 'scheduled',
            confirmation_sent_at TIMESTAMPTZ,
            reminder_sent_at    TIMESTAMPTZ,
            completed_at        TIMESTAMPTZ,
            feedback            TEXT,
            rating              SMALLINT     CHECK (rating BETWEEN 1 AND 5),
            created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
            created_by          UUID         REFERENCES users(id)
        )
    `, 'interview_schedules table');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_interview_schedules_application ON interview_schedules(application_id)`, 'idx_iv_application');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_interview_schedules_datetime    ON interview_schedules(scheduled_datetime)`, 'idx_iv_datetime');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_interview_schedules_status      ON interview_schedules(status)`, 'idx_iv_status');

    // â”€â”€ Migration 009: audit_logs table â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    await safeAlter(`
        CREATE TABLE IF NOT EXISTS audit_logs (
            id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id     UUID         REFERENCES users(id),
            action      TEXT         NOT NULL,
            entity_type TEXT         NOT NULL,
            entity_id   UUID,
            changes     JSONB,
            ip_address  TEXT,
            user_agent  TEXT,
            created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )
    `, 'audit_logs table');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_audit_logs_user      ON audit_logs(user_id)`, 'idx_audit_user');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_audit_logs_entity    ON audit_logs(entity_type, entity_id)`, 'idx_audit_entity');
    await safeAlter(`CREATE INDEX IF NOT EXISTS idx_audit_logs_created   ON audit_logs(created_at DESC)`, 'idx_audit_created');

    // â”€â”€ Migration 010: Live Agent Chat support â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // communications table: track who sent each message and the bot state at send time
    const commCols = [
        [`ALTER TABLE communications ADD COLUMN IF NOT EXISTS sender_type       VARCHAR(20)  DEFAULT 'bot'`, 'communications.sender_type'],
        [`ALTER TABLE communications ADD COLUMN IF NOT EXISTS sender_name       VARCHAR(255)`, 'communications.sender_name'],
        [`ALTER TABLE communications ADD COLUMN IF NOT EXISTS chatbot_state     VARCHAR(100)`, 'communications.chatbot_state'],
        [`ALTER TABLE communications ADD COLUMN IF NOT EXISTS detected_language VARCHAR(20)`, 'communications.detected_language'],
        [`CREATE INDEX IF NOT EXISTS idx_comm_candidate_sent ON communications(candidate_id, sent_at DESC)`, 'idx_comm_candidate_sent'],
    ];
    for (const [sql, label] of commCols) {
        await safeAlter(sql, label);
    }

    // â”€â”€ Migration 011: project data model expansion â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const projectCols = [
        [`ALTER TABLE projects ADD COLUMN IF NOT EXISTS country_of_recruitment JSONB DEFAULT '[]'::jsonb`, 'projects.country_of_recruitment'],
        [`ALTER TABLE projects ADD COLUMN IF NOT EXISTS currency VARCHAR(16)`, 'projects.currency'],
        [`ALTER TABLE projects ADD COLUMN IF NOT EXISTS client_details JSONB DEFAULT '{}'::jsonb`, 'projects.client_details'],
        [`CREATE INDEX IF NOT EXISTS idx_projects_country_of_recruitment ON projects USING gin(country_of_recruitment)`, 'idx_projects_country_of_recruitment'],
    ];

    for (const [sql, label] of projectCols) {
        await safeAlter(sql, label);
    }

    // candidates table: track live-agent handoff state
    const handoffCols = [
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS is_human_handoff      BOOLEAN      NOT NULL DEFAULT FALSE`, 'candidates.is_human_handoff'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS agent_id              UUID         REFERENCES users(id) ON DELETE SET NULL`, 'candidates.agent_id'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS handoff_at            TIMESTAMPTZ`, 'candidates.handoff_at'],
        [`ALTER TABLE candidates ADD COLUMN IF NOT EXISTS handoff_released_at   TIMESTAMPTZ`, 'candidates.handoff_released_at'],
        [`CREATE INDEX IF NOT EXISTS idx_candidates_handoff ON candidates(is_human_handoff) WHERE is_human_handoff = TRUE`, 'idx_candidates_handoff'],
    ];
    for (const [sql, label] of handoffCols) {
        await safeAlter(sql, label);
    }

    logger.info('âœ… Startup migrations complete.');
}

module.exports = { applyMigrations };

~~~

## recruitment-system/backend/src/routes/applications.js

Previous code:
~~~
const express = require('express');
const router = express.Router();
const { query, withTransaction, generateUUID } = require('../config/database');
const { adaptQuery, isMySQL } = require('../utils/query-adapter');
const { authenticate } = require('../middleware/auth');
const { calculateMatchScore } = require('../config/openai');
const notifications = require('../services/notifications');
const logger = require('../utils/logger');

/**
 * Get all applications with filters
 * MySQL + PostgreSQL compatible
 */
router.get('/', authenticate, async (req, res, next) => {
    try {
        const { job_id, candidate_id, status, project_id } = req.query;
        const params = [];
        let whereClause = ' WHERE 1=1';

        if (job_id) {
            whereClause += isMySQL ? ' AND a.job_id = ?' : ` AND a.job_id = $${params.length + 1}`;
            params.push(job_id);
        }
        if (candidate_id) {
            whereClause += isMySQL ? ' AND a.candidate_id = ?' : ` AND a.candidate_id = $${params.length + 1}`;
            params.push(candidate_id);
        }
        if (status) {
            whereClause += isMySQL ? ' AND a.status = ?' : ` AND a.status = $${params.length + 1}`;
            params.push(status);
        }
        if (project_id) {
            whereClause += isMySQL ? ' AND j.project_id = ?' : ` AND j.project_id = $${params.length + 1}`;
            params.push(project_id);
        }

        const sql = `SELECT a.*, c.name as candidate_name, c.phone as candidate_phone,
                     c.email as candidate_email, j.title as job_title, j.category as job_category,
                     j.project_id, p.title as project_title, p.client_name as project_client
                     FROM applications a
                     JOIN candidates c ON a.candidate_id = c.id
                     JOIN jobs j ON a.job_id = j.id
                     LEFT JOIN projects p ON j.project_id = p.id
                     ${whereClause} ORDER BY a.applied_at DESC`;
        const result = await query(sql, params);
        res.json(result.rows);
    } catch (error) { next(error); }
});

/**
 * Create application
 */
router.post('/', authenticate, async (req, res, next) => {
    try {
        const { candidate_id, job_id } = req.body;
        if (!candidate_id || !job_id) {
            return res.status(400).json({ error: 'Candidate ID and Job ID are required' });
        }

        const candidateResult = await query(
            adaptQuery('SELECT c.*, cv.parsed_data FROM candidates c LEFT JOIN cv_files cv ON c.id = cv.candidate_id WHERE c.id = $1 LIMIT 1'),
            [candidate_id]
        );
        if (candidateResult.rows.length === 0) return res.status(404).json({ error: 'Candidate not found' });

        const jobResult = await query(
            adaptQuery('SELECT j.*, p.title as project_title FROM jobs j INNER JOIN projects p ON j.project_id = p.id WHERE j.id = $1'),
            [job_id]
        );
        if (jobResult.rows.length === 0) return res.status(404).json({ error: 'Job not found or not associated with a project' });

        const candidate = candidateResult.rows[0];
        const job = jobResult.rows[0];
        let matchScore = null;
        if (candidate.parsed_data) {
            try {
                const mr = await calculateMatchScore(candidate.parsed_data, job.requirements);
                matchScore = mr.score;
            } catch (e) { logger.warn('Match score failed:', e.message); }
        }

        const appId = generateUUID();
        await query(
            adaptQuery("INSERT INTO applications (id, candidate_id, job_id, match_score, status) VALUES ($1, $2, $3, $4, 'applied')"),
            [appId, candidate_id, job_id, matchScore]
        );
        const inserted = await query(adaptQuery('SELECT * FROM applications WHERE id = $1'), [appId]);
        res.status(201).json(inserted.rows[0]);
    } catch (error) {
        if (error.message && error.message.toLowerCase().includes('duplicate')) {
            return res.status(400).json({ error: 'Application already exists' });
        }
        next(error);
    }
});

/**
 * Update application status  auto-sends WhatsApp/SMS/email notifications
 */
router.put('/:id', authenticate, async (req, res, next) => {
    try {
        const { id } = req.params;
        const {
            status, rejection_reason, interview_datetime, interview_location,
            interview_notes, certification_notes, prescreening_datetime,
            prescreening_location, notify_channels = ['whatsapp']
        } = req.body;

        const setClauses = [];
        const values = [];
        const p = () => isMySQL ? '?' : `$${values.length + 1}`;

        if (status) {
            setClauses.push(`status = ${p()}`); values.push(status);
            if (status === 'certified') {
                setClauses.push('certified_at = NOW()');
                setClauses.push(`certified_by = ${p()}`); values.push(req.user.id);
            }
        }
        if (certification_notes)  { setClauses.push(`certification_notes = ${p()}`); values.push(certification_notes); }
        if (rejection_reason)     { setClauses.push(`rejection_reason = ${p()}`);    values.push(rejection_reason); }
        const effDt = prescreening_datetime || interview_datetime;
        if (effDt)  { setClauses.push(`interview_datetime = ${p()}`); values.push(effDt); }
        const effLoc = prescreening_location || interview_location;
        if (effLoc) { setClauses.push(`interview_location = ${p()}`); values.push(effLoc); }
        if (interview_notes) { setClauses.push(`interview_notes = ${p()}`); values.push(interview_notes); }

        if (setClauses.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

        values.push(id);
        await query(`UPDATE applications SET ${setClauses.join(', ')} WHERE id = ${isMySQL ? '?' : `$${values.length}`}`, values);

        const appResult = await query(adaptQuery('SELECT * FROM applications WHERE id = $1'), [id]);
        if (appResult.rows.length === 0) return res.status(404).json({ error: 'Application not found' });
        const application = appResult.rows[0];

        if (status) {
            const jobResult = await query(adaptQuery('SELECT title FROM jobs WHERE id = $1'), [application.job_id]);
            const jobTitle = jobResult.rows[0]?.title || 'the position';
            const channels = Array.isArray(notify_channels) ? notify_channels : ['whatsapp'];

            setImmediate(async () => {
                try {
                    switch (status) {
                        case 'certified':
                            if (prescreening_datetime && prescreening_location) {
                                await notifications.sendPreScreeningNotification(
                                    application.candidate_id, jobTitle, prescreening_datetime, prescreening_location, channels);
                            } else {
                                await notifications.sendCertificationNotification(
                                    application.candidate_id, jobTitle, certification_notes, channels);
                            }
                            break;
                        case 'interview_scheduled':
                            if (effDt && effLoc)
                                await notifications.sendInterviewNotification(application.candidate_id, jobTitle, effDt, effLoc, channels);
                            break;
                        case 'selected':
                            await notifications.sendSelectionNotification(application.candidate_id, jobTitle, channels);
                            break;
                        case 'rejected':
                            await notifications.sendRejectionNotification(application.candidate_id, jobTitle, channels);
                            break;
                    }
                } catch (notifError) {
                    logger.error(`Notification failed for application ${id}:`, notifError);
                }
            });
        }

        res.json({
            ...application,
            notification_queued: !!status && ['certified','interview_scheduled','selected','rejected'].includes(status)
        });
    } catch (error) { next(error); }
});

/**
 * Reject application  move candidate to general pool + notify
 */
router.post('/:id/reject-to-pool', authenticate, async (req, res, next) => {
    try {
        const { id } = req.params;
        const { rejection_reason, notify_channels = ['whatsapp'] } = req.body;

        const appResult = await query(
            adaptQuery('SELECT a.*, j.title as job_title FROM applications a JOIN jobs j ON a.job_id = j.id WHERE a.id = $1'),
            [id]
        );
        if (appResult.rows.length === 0) return res.status(404).json({ error: 'Application not found' });
        const application = appResult.rows[0];

        await query(
            adaptQuery("UPDATE applications SET status = 'rejected', rejection_reason = $1 WHERE id = $2"),
            [rejection_reason || 'Moved to general pool', id]
        );
        await query(
            adaptQuery("UPDATE candidates SET status = 'future_pool', updated_at = NOW() WHERE id = $1"),
            [application.candidate_id]
        );

        const channels = Array.isArray(notify_channels) ? notify_channels : ['whatsapp'];
        setImmediate(async () => {
            try {
                await notifications.sendGeneralPoolNotification(application.candidate_id, channels);
            } catch (e) { logger.error(`General pool notification failed: ${e.message}`); }
        });

        res.json({ success: true, message: 'Candidate moved to general pool',
                   application_id: id, candidate_id: application.candidate_id,
                   notification_queued: true, channels });
    } catch (error) { next(error); }
});

/**
 * Transfer application to a different job
 */
router.post('/:id/transfer', authenticate, async (req, res, next) => {
    try {
        const { id } = req.params;
        const { target_job_id, transfer_reason } = req.body;
        if (!target_job_id) return res.status(400).json({ error: 'Target Job ID is required' });

        const originalAppResult = await query(adaptQuery('SELECT * FROM applications WHERE id = $1'), [id]);
        if (originalAppResult.rows.length === 0) return res.status(404).json({ error: 'Application not found' });
        const originalApp = originalAppResult.rows[0];

        const targetJobResult = await query(adaptQuery('SELECT id, title FROM jobs WHERE id = $1'), [target_job_id]);
        if (targetJobResult.rows.length === 0) return res.status(404).json({ error: 'Target job not found' });

        const newAppId = generateUUID();

        await withTransaction(async (conn) => {
            // Works for both MySQL (conn.execute) and Postgres (conn.query)
            const exec = typeof conn.execute === 'function'
                ? (sql, p) => conn.execute(sql, p)
                : (sql, p) => conn.query(sql, p);

            await exec(
                adaptQuery("INSERT INTO applications (id, candidate_id, job_id, status, transferred_from_job_id, transfer_reason) VALUES ($1, $2, $3, 'reviewing', $4, $5)"),
                [newAppId, originalApp.candidate_id, target_job_id, originalApp.job_id, transfer_reason || null]
            );
            await exec(
                adaptQuery("UPDATE applications SET status = 'transferred', updated_at = NOW() WHERE id = $1"),
                [id]
            );
        });

        const newApp = await query(adaptQuery('SELECT * FROM applications WHERE id = $1'), [newAppId]);

        // Notify candidate that their application has been moved
        const channels = Array.isArray(req.body.notify_channels) ? req.body.notify_channels : ['whatsapp'];
        setImmediate(async () => {
            try {
                await notifications.sendTransferNotification(
                    originalApp.candidate_id,
                    targetJobResult.rows[0].title,
                    /* oldJobTitle */ (await query(adaptQuery('SELECT title FROM jobs WHERE id = $1'), [originalApp.job_id])).rows[0]?.title || 'previous position',
                    channels
                );
            } catch (notifErr) {
                logger.error(`Transfer notification failed for application ${id}: ${notifErr.message}`);
            }
        });

        res.json(newApp.rows[0]);
    } catch (error) { next(error); }
});

/**
 * Batch certify multiple applications at once
 */
router.post('/batch-certify', authenticate, async (req, res, next) => {
    try {
        const {
            application_ids,
            prescreening_datetime,
            prescreening_location,
            certification_notes,
            notify_channels = ['whatsapp']
        } = req.body;

        if (!Array.isArray(application_ids) || application_ids.length === 0) {
            return res.status(400).json({ error: 'application_ids array is required' });
        }

        const results = { success: [], failed: [] };
        const channels = Array.isArray(notify_channels) ? notify_channels : ['whatsapp'];

        for (const appId of application_ids) {
            try {
                // Update status and certification fields
                await query(
                    adaptQuery(`UPDATE applications SET
                        status = 'certified',
                        certified_at = NOW(),
                        certified_by = $1,
                        certification_notes = $2
                        ${prescreening_datetime ? ', interview_datetime = $4' : ''}
                        ${prescreening_location  ? `, interview_location = $${prescreening_datetime ? 5 : 4}` : ''}
                        WHERE id = $3`
                        .replace('$4', isMySQL ? '?' : '$4')
                        .replace('$5', isMySQL ? '?' : '$5')
                    ),
                    [
                        req.user.id,
                        certification_notes || null,
                        appId,
                        ...(prescreening_datetime ? [prescreening_datetime] : []),
                        ...(prescreening_location  ? [prescreening_location]  : [])
                    ]
                );

                const appResult = await query(
                    adaptQuery('SELECT a.candidate_id, j.title as job_title FROM applications a JOIN jobs j ON a.job_id = j.id WHERE a.id = $1'),
                    [appId]
                );
                const app = appResult.rows[0];

                setImmediate(async () => {
                    try {
                        if (prescreening_datetime && prescreening_location) {
                            await notifications.sendPreScreeningNotification(
                                app.candidate_id, app.job_title, prescreening_datetime, prescreening_location, channels);
                        } else {
                            await notifications.sendCertificationNotification(
                                app.candidate_id, app.job_title, certification_notes || '', channels);
                        }
                    } catch (notifErr) {
                        logger.error(`Batch certify notification failed for ${appId}: ${notifErr.message}`);
                    }
                });

                results.success.push({ application_id: appId, candidate_id: app?.candidate_id });
            } catch (err) {
                results.failed.push({ application_id: appId, error: err.message });
            }
        }

        res.json({
            processed: application_ids.length,
            success_count: results.success.length,
            failed_count: results.failed.length,
            results
        });
    } catch (error) { next(error); }
});

/**
 * AI-powered candidate matching for a job
 */
router.get('/match/:job_id', authenticate, async (req, res, next) => {
    try {
        const { job_id } = req.params;

        const jobResult = await query(adaptQuery('SELECT * FROM jobs WHERE id = $1'), [job_id]);
        if (jobResult.rows.length === 0) return res.status(404).json({ error: 'Job not found' });
        const job = jobResult.rows[0];

        const candidatesResult = await query(
            adaptQuery(`SELECT c.*, cv.parsed_data FROM candidates c
                        JOIN cv_files cv ON c.id = cv.candidate_id
                        WHERE cv.ocr_status = 'completed' AND c.status NOT IN ('hired','rejected')
                        AND cv.parsed_data IS NOT NULL
                        AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.candidate_id = c.id AND a.job_id = $1)`),
            [job_id]
        );

        const matches = [];
        for (const candidate of candidatesResult.rows) {
            try {
                const matchResult = await calculateMatchScore(candidate.parsed_data, job.requirements);
                if (matchResult.score >= 0.5) {
                    matches.push({
                        candidate_id: candidate.id, candidate_name: candidate.name,
                        candidate_phone: candidate.phone, match_score: matchResult.score,
                        reasons: matchResult.reasons, concerns: matchResult.concerns
                    });
                }
            } catch (e) { logger.warn(`Match score failed for candidate ${candidate.id}: ${e.message}`); }
        }

        matches.sort((a, b) => b.match_score - a.match_score);
        res.json(matches);
    } catch (error) { next(error); }
});

module.exports = router;
~~~

Current code:
~~~
const express = require('express');
const router = express.Router();
const { query, withTransaction, generateUUID } = require('../config/database');
const { adaptQuery, isMySQL } = require('../utils/query-adapter');
const { authenticate } = require('../middleware/auth');
const { calculateMatchScore } = require('../config/openai');
const notifications = require('../services/notifications');
const logger = require('../utils/logger');

/**
 * Get all applications with filters
 * MySQL + PostgreSQL compatible
 */
router.get('/', authenticate, async (req, res, next) => {
    try {
        const {
            job_id,
            candidate_id,
            status,
            project_id,
            date_from,
            date_to,
            limit = 50,
            offset = 0,
        } = req.query;

        const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
        const safeOffset = Math.max(parseInt(offset, 10) || 0, 0);

        const params = [];
        let whereClause = ' WHERE 1=1';

        if (job_id) {
            whereClause += isMySQL ? ' AND a.job_id = ?' : ` AND a.job_id = $${params.length + 1}`;
            params.push(job_id);
        }
        if (candidate_id) {
            whereClause += isMySQL ? ' AND a.candidate_id = ?' : ` AND a.candidate_id = $${params.length + 1}`;
            params.push(candidate_id);
        }
        if (status) {
            whereClause += isMySQL ? ' AND a.status = ?' : ` AND a.status = $${params.length + 1}`;
            params.push(status);
        }
        if (project_id) {
            whereClause += isMySQL ? ' AND j.project_id = ?' : ` AND j.project_id = $${params.length + 1}`;
            params.push(project_id);
        }
        if (date_from) {
            whereClause += isMySQL ? ' AND a.applied_at >= ?' : ` AND a.applied_at >= $${params.length + 1}`;
            params.push(date_from);
        }
        if (date_to) {
            whereClause += isMySQL ? ' AND a.applied_at <= ?' : ` AND a.applied_at <= $${params.length + 1}`;
            params.push(date_to);
        }

        const sql = isMySQL
            ? `SELECT a.*, c.name as candidate_name, c.full_name as candidate_full_name,
                     c.phone as candidate_phone, c.email as candidate_email, c.experience_years,
                     c.metadata as candidate_metadata,
                     j.title as job_title, j.category as job_category,
                     j.project_id, p.title as project_title, p.client_name as project_client,
                     p.country_of_recruitment as project_country_of_recruitment
                     FROM applications a
                     JOIN candidates c ON a.candidate_id = c.id
                     JOIN jobs j ON a.job_id = j.id
                     LEFT JOIN projects p ON j.project_id = p.id
                     ${whereClause}
                     ORDER BY a.applied_at DESC
                     LIMIT ? OFFSET ?`
            : `SELECT a.*, c.name as candidate_name, c.full_name as candidate_full_name,
                     c.phone as candidate_phone, c.email as candidate_email, c.experience_years,
                     c.metadata as candidate_metadata,
                     j.title as job_title, j.category as job_category,
                     j.project_id, p.title as project_title, p.client_name as project_client,
                     p.country_of_recruitment as project_country_of_recruitment
                     FROM applications a
                     JOIN candidates c ON a.candidate_id = c.id
                     JOIN jobs j ON a.job_id = j.id
                     LEFT JOIN projects p ON j.project_id = p.id
                     ${whereClause}
                     ORDER BY a.applied_at DESC
                     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;

        const result = await query(sql, [...params, safeLimit, safeOffset]);
        res.json(result.rows);
    } catch (error) { next(error); }
});

/**
 * Create application
 */
router.post('/', authenticate, async (req, res, next) => {
    try {
        const { candidate_id, job_id } = req.body;
        if (!candidate_id || !job_id) {
            return res.status(400).json({ error: 'Candidate ID and Job ID are required' });
        }

        const candidateResult = await query(
            adaptQuery('SELECT c.*, cv.parsed_data FROM candidates c LEFT JOIN cv_files cv ON c.id = cv.candidate_id WHERE c.id = $1 LIMIT 1'),
            [candidate_id]
        );
        if (candidateResult.rows.length === 0) return res.status(404).json({ error: 'Candidate not found' });

        const jobResult = await query(
            adaptQuery('SELECT j.*, p.title as project_title FROM jobs j INNER JOIN projects p ON j.project_id = p.id WHERE j.id = $1'),
            [job_id]
        );
        if (jobResult.rows.length === 0) return res.status(404).json({ error: 'Job not found or not associated with a project' });

        const candidate = candidateResult.rows[0];
        const job = jobResult.rows[0];
        let matchScore = null;
        if (candidate.parsed_data) {
            try {
                const mr = await calculateMatchScore(candidate.parsed_data, job.requirements);
                matchScore = mr.score;
            } catch (e) { logger.warn('Match score failed:', e.message); }
        }

        const appId = generateUUID();
        await query(
            adaptQuery("INSERT INTO applications (id, candidate_id, job_id, match_score, status) VALUES ($1, $2, $3, $4, 'applied')"),
            [appId, candidate_id, job_id, matchScore]
        );
        const inserted = await query(adaptQuery('SELECT * FROM applications WHERE id = $1'), [appId]);
        res.status(201).json(inserted.rows[0]);
    } catch (error) {
        if (error.message && error.message.toLowerCase().includes('duplicate')) {
            return res.status(400).json({ error: 'Application already exists' });
        }
        next(error);
    }
});

/**
 * Update application status  auto-sends WhatsApp/SMS/email notifications
 */
router.put('/:id', authenticate, async (req, res, next) => {
    try {
        const { id } = req.params;
        const {
            status, rejection_reason, interview_datetime, interview_location,
            interview_notes, certification_notes, prescreening_datetime,
            prescreening_location, notify_channels = ['whatsapp']
        } = req.body;

        const setClauses = [];
        const values = [];
        const p = () => isMySQL ? '?' : `$${values.length + 1}`;

        if (status) {
            setClauses.push(`status = ${p()}`); values.push(status);
            if (status === 'certified') {
                setClauses.push('certified_at = NOW()');
                setClauses.push(`certified_by = ${p()}`); values.push(req.user.id);
            }
        }
        if (certification_notes)  { setClauses.push(`certification_notes = ${p()}`); values.push(certification_notes); }
        if (rejection_reason)     { setClauses.push(`rejection_reason = ${p()}`);    values.push(rejection_reason); }
        const effDt = prescreening_datetime || interview_datetime;
        if (effDt)  { setClauses.push(`interview_datetime = ${p()}`); values.push(effDt); }
        const effLoc = prescreening_location || interview_location;
        if (effLoc) { setClauses.push(`interview_location = ${p()}`); values.push(effLoc); }
        if (interview_notes) { setClauses.push(`interview_notes = ${p()}`); values.push(interview_notes); }

        if (setClauses.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

        values.push(id);
        await query(`UPDATE applications SET ${setClauses.join(', ')} WHERE id = ${isMySQL ? '?' : `$${values.length}`}`, values);

        const appResult = await query(adaptQuery('SELECT * FROM applications WHERE id = $1'), [id]);
        if (appResult.rows.length === 0) return res.status(404).json({ error: 'Application not found' });
        const application = appResult.rows[0];

        if (status) {
            const jobResult = await query(adaptQuery('SELECT title FROM jobs WHERE id = $1'), [application.job_id]);
            const jobTitle = jobResult.rows[0]?.title || 'the position';
            const channels = Array.isArray(notify_channels) ? notify_channels : ['whatsapp'];

            setImmediate(async () => {
                try {
                    switch (status) {
                        case 'certified':
                            if (prescreening_datetime && prescreening_location) {
                                await notifications.sendPreScreeningNotification(
                                    application.candidate_id, jobTitle, prescreening_datetime, prescreening_location, channels);
                            } else {
                                await notifications.sendCertificationNotification(
                                    application.candidate_id, jobTitle, certification_notes, channels);
                            }
                            break;
                        case 'interview_scheduled':
                            if (effDt && effLoc)
                                await notifications.sendInterviewNotification(application.candidate_id, jobTitle, effDt, effLoc, channels);
                            break;
                        case 'selected':
                            await notifications.sendSelectionNotification(application.candidate_id, jobTitle, channels);
                            break;
                        case 'rejected':
                            await notifications.sendRejectionNotification(application.candidate_id, jobTitle, channels);
                            break;
                    }
                } catch (notifError) {
                    logger.error(`Notification failed for application ${id}:`, notifError);
                }
            });
        }

        res.json({
            ...application,
            notification_queued: !!status && ['certified','interview_scheduled','selected','rejected'].includes(status)
        });
    } catch (error) { next(error); }
});

/**
 * Reject application  move candidate to general pool + notify
 */
router.post('/:id/reject-to-pool', authenticate, async (req, res, next) => {
    try {
        const { id } = req.params;
        const { rejection_reason, notify_channels = ['whatsapp'] } = req.body;

        const appResult = await query(
            adaptQuery('SELECT a.*, j.title as job_title FROM applications a JOIN jobs j ON a.job_id = j.id WHERE a.id = $1'),
            [id]
        );
        if (appResult.rows.length === 0) return res.status(404).json({ error: 'Application not found' });
        const application = appResult.rows[0];

        await query(
            adaptQuery("UPDATE applications SET status = 'rejected', rejection_reason = $1 WHERE id = $2"),
            [rejection_reason || 'Moved to general pool', id]
        );
        await query(
            adaptQuery("UPDATE candidates SET status = 'future_pool', updated_at = NOW() WHERE id = $1"),
            [application.candidate_id]
        );

        const channels = Array.isArray(notify_channels) ? notify_channels : ['whatsapp'];
        setImmediate(async () => {
            try {
                await notifications.sendGeneralPoolNotification(application.candidate_id, channels);
            } catch (e) { logger.error(`General pool notification failed: ${e.message}`); }
        });

        res.json({ success: true, message: 'Candidate moved to general pool',
                   application_id: id, candidate_id: application.candidate_id,
                   notification_queued: true, channels });
    } catch (error) { next(error); }
});

/**
 * Transfer application to a different job
 */
router.post('/:id/transfer', authenticate, async (req, res, next) => {
    try {
        const { id } = req.params;
        const { target_job_id, transfer_reason } = req.body;
        if (!target_job_id) return res.status(400).json({ error: 'Target Job ID is required' });

        const originalAppResult = await query(adaptQuery('SELECT * FROM applications WHERE id = $1'), [id]);
        if (originalAppResult.rows.length === 0) return res.status(404).json({ error: 'Application not found' });
        const originalApp = originalAppResult.rows[0];

        const targetJobResult = await query(adaptQuery('SELECT id, title FROM jobs WHERE id = $1'), [target_job_id]);
        if (targetJobResult.rows.length === 0) return res.status(404).json({ error: 'Target job not found' });

        const newAppId = generateUUID();

        await withTransaction(async (conn) => {
            // Works for both MySQL (conn.execute) and Postgres (conn.query)
            const exec = typeof conn.execute === 'function'
                ? (sql, p) => conn.execute(sql, p)
                : (sql, p) => conn.query(sql, p);

            await exec(
                adaptQuery("INSERT INTO applications (id, candidate_id, job_id, status, transferred_from_job_id, transfer_reason) VALUES ($1, $2, $3, 'reviewing', $4, $5)"),
                [newAppId, originalApp.candidate_id, target_job_id, originalApp.job_id, transfer_reason || null]
            );
            await exec(
                adaptQuery("UPDATE applications SET status = 'transferred', updated_at = NOW() WHERE id = $1"),
                [id]
            );
        });

        const newApp = await query(adaptQuery('SELECT * FROM applications WHERE id = $1'), [newAppId]);

        // Notify candidate that their application has been moved
        const channels = Array.isArray(req.body.notify_channels) ? req.body.notify_channels : ['whatsapp'];
        setImmediate(async () => {
            try {
                await notifications.sendTransferNotification(
                    originalApp.candidate_id,
                    targetJobResult.rows[0].title,
                    /* oldJobTitle */ (await query(adaptQuery('SELECT title FROM jobs WHERE id = $1'), [originalApp.job_id])).rows[0]?.title || 'previous position',
                    channels
                );
            } catch (notifErr) {
                logger.error(`Transfer notification failed for application ${id}: ${notifErr.message}`);
            }
        });

        res.json(newApp.rows[0]);
    } catch (error) { next(error); }
});

/**
 * Batch certify multiple applications at once
 */
router.post('/batch-certify', authenticate, async (req, res, next) => {
    try {
        const {
            application_ids,
            prescreening_datetime,
            prescreening_location,
            certification_notes,
            notify_channels = ['whatsapp']
        } = req.body;

        if (!Array.isArray(application_ids) || application_ids.length === 0) {
            return res.status(400).json({ error: 'application_ids array is required' });
        }

        const results = { success: [], failed: [] };
        const channels = Array.isArray(notify_channels) ? notify_channels : ['whatsapp'];

        for (const appId of application_ids) {
            try {
                // Update status and certification fields
                await query(
                    adaptQuery(`UPDATE applications SET
                        status = 'certified',
                        certified_at = NOW(),
                        certified_by = $1,
                        certification_notes = $2
                        ${prescreening_datetime ? ', interview_datetime = $4' : ''}
                        ${prescreening_location  ? `, interview_location = $${prescreening_datetime ? 5 : 4}` : ''}
                        WHERE id = $3`
                        .replace('$4', isMySQL ? '?' : '$4')
                        .replace('$5', isMySQL ? '?' : '$5')
                    ),
                    [
                        req.user.id,
                        certification_notes || null,
                        appId,
                        ...(prescreening_datetime ? [prescreening_datetime] : []),
                        ...(prescreening_location  ? [prescreening_location]  : [])
                    ]
                );

                const appResult = await query(
                    adaptQuery('SELECT a.candidate_id, j.title as job_title FROM applications a JOIN jobs j ON a.job_id = j.id WHERE a.id = $1'),
                    [appId]
                );
                const app = appResult.rows[0];

                setImmediate(async () => {
                    try {
                        if (prescreening_datetime && prescreening_location) {
                            await notifications.sendPreScreeningNotification(
                                app.candidate_id, app.job_title, prescreening_datetime, prescreening_location, channels);
                        } else {
                            await notifications.sendCertificationNotification(
                                app.candidate_id, app.job_title, certification_notes || '', channels);
                        }
                    } catch (notifErr) {
                        logger.error(`Batch certify notification failed for ${appId}: ${notifErr.message}`);
                    }
                });

                results.success.push({ application_id: appId, candidate_id: app?.candidate_id });
            } catch (err) {
                results.failed.push({ application_id: appId, error: err.message });
            }
        }

        res.json({
            processed: application_ids.length,
            success_count: results.success.length,
            failed_count: results.failed.length,
            results
        });
    } catch (error) { next(error); }
});

/**
 * AI-powered candidate matching for a job
 */
router.get('/match/:job_id', authenticate, async (req, res, next) => {
    try {
        const { job_id } = req.params;

        const jobResult = await query(adaptQuery('SELECT * FROM jobs WHERE id = $1'), [job_id]);
        if (jobResult.rows.length === 0) return res.status(404).json({ error: 'Job not found' });
        const job = jobResult.rows[0];

        const candidatesResult = await query(
            adaptQuery(`SELECT c.*, cv.parsed_data FROM candidates c
                        JOIN cv_files cv ON c.id = cv.candidate_id
                        WHERE cv.ocr_status = 'completed' AND c.status NOT IN ('hired','rejected')
                        AND cv.parsed_data IS NOT NULL
                        AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.candidate_id = c.id AND a.job_id = $1)`),
            [job_id]
        );

        const matches = [];
        for (const candidate of candidatesResult.rows) {
            try {
                const matchResult = await calculateMatchScore(candidate.parsed_data, job.requirements);
                if (matchResult.score >= 0.5) {
                    matches.push({
                        candidate_id: candidate.id, candidate_name: candidate.name,
                        candidate_phone: candidate.phone, match_score: matchResult.score,
                        reasons: matchResult.reasons, concerns: matchResult.concerns
                    });
                }
            } catch (e) { logger.warn(`Match score failed for candidate ${candidate.id}: ${e.message}`); }
        }

        matches.sort((a, b) => b.match_score - a.match_score);
        res.json(matches);
    } catch (error) { next(error); }
});

module.exports = router;

~~~

## recruitment-system/backend/src/routes/candidates.js

Previous code:
~~~
const express = require('express');
const router = express.Router();
const { query, generateUUID } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { adaptQuery, isMySQL } = require('../utils/query-adapter');
const axios = require('axios');
const logger = require('../utils/logger');
const { resolveCvAccessUrl } = require('../utils/cv-url');

/**
 * Get all candidates with filters and pagination
 * Compatible with both MySQL and PostgreSQL
 */
router.get('/', authenticate, async (req, res, next) => {
    try {
        const {
            page = 1,
            limit = 20,
            status,
            source,
            search,
            language
        } = req.query;

        const offset = (page - 1) * limit;

        const params = [];
        let whereClause = ' WHERE 1=1';

        if (status) {
            whereClause += isMySQL ? ' AND status = ?' : ` AND status = $${params.length + 1}`;
            params.push(status);
        }

        if (source) {
            whereClause += isMySQL ? ' AND source = ?' : ` AND source = $${params.length + 1}`;
            params.push(source);
        }

        if (language) {
            // singlish/tanglish are stored as si/ta in the DB; normalise before filtering
            const LANG_NORM = { singlish: 'si', tanglish: 'ta' };
            const normLang = LANG_NORM[language] || language;
            whereClause += isMySQL ? ' AND preferred_language = ?' : ` AND preferred_language = $${params.length + 1}`;
            params.push(normLang);
        }

        if (search) {
            if (isMySQL) {
                whereClause += ' AND (name LIKE ? OR phone LIKE ? OR email LIKE ?)';
                params.push(`%${search}%`, `%${search}%`, `%${search}%`);
            } else {
                whereClause += ` AND (name ILIKE $${params.length + 1} OR phone ILIKE $${params.length + 1} OR email ILIKE $${params.length + 1})`;
                params.push(`%${search}%`);
            }
        }

        // Count query
        const countQuery = `SELECT COUNT(*) as count FROM candidates${whereClause}`;
        const countResult = await query(countQuery, [...params]);
        const total = isMySQL ? countResult.rows[0].count : parseInt(countResult.rows[0].count);

        // List query with pagination
        let listQuery;
        let listParams;
        if (isMySQL) {
            listQuery = `SELECT * FROM candidates${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
            listParams = [...params, parseInt(limit), parseInt(offset)];
        } else {
            listQuery = `SELECT * FROM candidates${whereClause} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
            listParams = [...params, limit, offset];
        }

        const result = await query(listQuery, listParams);

        res.json({
            data: result.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: total,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * Get candidate by ID with full details
 */
router.get('/:id', authenticate, async (req, res, next) => {
    try {
        const { id } = req.params;
        const placeholder = isMySQL ? '?' : '$1';

        // Get candidate
        const candidateResult = await query(
            `SELECT * FROM candidates WHERE id = ${placeholder}`,
            [id]
        );

        if (candidateResult.rows.length === 0) {
            return res.status(404).json({ error: 'Candidate not found' });
        }

        let candidate = candidateResult.rows[0];

        // Extract age / height / language_register from JSONB metadata so the frontend doesn't need to dig  
        let metadata = {};
        try {
            metadata = candidate.metadata
                ? (typeof candidate.metadata === 'string' ? JSON.parse(candidate.metadata) : candidate.metadata)
                : {};
        } catch (_) {}
        candidate = {
            ...candidate,
            age: metadata.age ?? null,
            height_cm: metadata.height_cm ?? null,
            // Expose the precise language register (singlish/tanglish/si/ta/en)
            language_register: metadata.language_register ?? candidate.preferred_language ?? null,
        };

        // Get CVs
        const cvsResult = await query(
            `SELECT * FROM cv_files WHERE candidate_id = ${placeholder} ORDER BY uploaded_at DESC`,
            [id]
        );

        // Get applications (include project info for Projects tab)
        const applicationsResult = await query(
            isMySQL
                ? `SELECT a.*, j.title as job_title, j.category as job_category,
                          p.id as project_id, p.title as project_title
                   FROM applications a
                   JOIN jobs j ON a.job_id = j.id
                   LEFT JOIN projects p ON j.project_id = p.id
                   WHERE a.candidate_id = ?
                   ORDER BY a.applied_at DESC`
                : `SELECT a.*, j.title as job_title, j.category as job_category,
                          p.id as project_id, p.title as project_title
                   FROM applications a
                   JOIN jobs j ON a.job_id = j.id
                   LEFT JOIN projects p ON j.project_id = p.id
                   WHERE a.candidate_id = $1
                   ORDER BY a.applied_at DESC`,
            [id]
        );

        // Get communications
        const communicationsResult = await query(
            `SELECT * FROM communications
             WHERE candidate_id = ${placeholder}
             ORDER BY sent_at DESC
             LIMIT 50`,
            [id]
        );

        const enrichedCvs = (cvsResult.rows || []).map((cv) => {
            const resolved = resolveCvAccessUrl(cv);
            const parsedData = cv?.parsed_data && typeof cv.parsed_data === 'string'
                ? (() => {
                    try { return JSON.parse(cv.parsed_data); } catch (_) { return null; }
                })()
                : cv?.parsed_data;

            const documentCategory = parsedData?.__document_category === 'additional'
                ? 'additional'
                : 'cv';

            return {
                ...cv,
                document_category: documentCategory,
                resolved_file_url: resolved.url,
                cv_retrieval_status: resolved.status,
                cv_url_source: resolved.source,
            };
        });

        res.json({
            ...candidate,
            cvs: enrichedCvs,
            applications: applicationsResult.rows,
            communications: communicationsResult.rows
        });
    } catch (error) {
        next(error);
    }
});

/**
 * Create new candidate manually
 */
router.post('/', authenticate, async (req, res, next) => {
    try {
        const {
            name,
            phone,
            email,
            source = 'manual',
            preferred_language = 'en',
            notes
        } = req.body;

        if (!name || !phone) {
            return res.status(400).json({ error: 'Name and phone are required' });
        }

        if (isMySQL) {
            // MySQL: Insert then select
            const id = generateUUID();
            await query(
                `INSERT INTO candidates (id, name, phone, email, source, preferred_language, notes, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'new')`,
                [id, name, phone, email, source, preferred_language, notes]
            );

            const result = await query('SELECT * FROM candidates WHERE id = ?', [id]);
            res.status(201).json(result.rows[0]);
        } else {
            // PostgreSQL: Use RETURNING
            const result = await query(
                `INSERT INTO candidates (name, phone, email, source, preferred_language, notes, status)
                 VALUES ($1, $2, $3, $4, $5, $6, 'new')
                 RETURNING *`,
                [name, phone, email, source, preferred_language, notes]
            );
            res.status(201).json(result.rows[0]);
        }
    } catch (error) {
        if (error.message.includes('duplicate') || error.message.includes('Duplicate')) {
            return res.status(400).json({ error: 'Candidate with this phone or email already exists' });
        }
        next(error);
    }
});

/**
 * Update candidate
 */
router.put('/:id', authenticate, async (req, res, next) => {
    try {
        const { id } = req.params;
        const updates = req.body;

        const allowedFields = ['name', 'email', 'status', 'preferred_language', 'notes', 'tags', 'skills', 'experience_years', 'highest_qualification'];
        const setClause = [];
        const values = [];

        Object.keys(updates).forEach(key => {
            if (allowedFields.includes(key)) {
                if (isMySQL) {
                    setClause.push(`${key} = ?`);
                } else {
                    setClause.push(`${key} = $${values.length + 1}`);
                }
                // Handle JSON fields for MySQL
                if (key === 'tags' && isMySQL && Array.isArray(updates[key])) {
                    values.push(JSON.stringify(updates[key]));
                } else {
                    values.push(updates[key]);
                }
            }
        });

        if (setClause.length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }

        values.push(id);

        if (isMySQL) {
            // MySQL: Update then select
            const updateQuery = `UPDATE candidates SET ${setClause.join(', ')}, updated_at = NOW() WHERE id = ?`;
            const updateResult = await query(updateQuery, values);

            if (updateResult.rowCount === 0) {
                return res.status(404).json({ error: 'Candidate not found' });
            }

            const result = await query('SELECT * FROM candidates WHERE id = ?', [id]);
            const updatedCandidate = result.rows[0];
            res.json(updatedCandidate);

            // Notify chatbot of status change (async, non-blocking)
            if (updates.status) {
                _notifyChatbotStatusChange(updatedCandidate, updates.status);
            }
        } else {
            // PostgreSQL: Use RETURNING
            const updateQuery = `UPDATE candidates SET ${setClause.join(', ')}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`;
            const result = await query(updateQuery, values);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Candidate not found' });
            }

            const updatedCandidate = result.rows[0];
            res.json(updatedCandidate);

            // Notify chatbot of status change (async, non-blocking)
            if (updates.status) {
                _notifyChatbotStatusChange(updatedCandidate, updates.status);
            }
        }
    } catch (error) {
        next(error);
    }
});

/**
 * Delete candidate
 */
router.delete('/:id', authenticate, authorize('admin'), async (req, res, next) => {
    try {
        const { id } = req.params;
        const placeholder = isMySQL ? '?' : '$1';

        if (isMySQL) {
            // Check if exists first
            const checkResult = await query(`SELECT id FROM candidates WHERE id = ?`, [id]);
            if (checkResult.rows.length === 0) {
                return res.status(404).json({ error: 'Candidate not found' });
            }
            await query(`DELETE FROM candidates WHERE id = ?`, [id]);
        } else {
            const result = await query(
                `DELETE FROM candidates WHERE id = ${placeholder} RETURNING *`,
                [id]
            );
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Candidate not found' });
            }
        }

        res.json({ message: 'Candidate deleted successfully' });
    } catch (error) {
        next(error);
    }
});

// ΓöÇΓöÇ Duplicate detection routes ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

/**
 * GET /api/candidates/duplicates
 * Returns potential duplicate pairs with confidence scores.
 */
router.get('/duplicates', authenticate, async (req, res, next) => {
    try {
        const { min_confidence = 0.5, limit = 100 } = req.query;
        const { findDuplicates } = require('../services/duplicate-detection');
        const pairs = await findDuplicates(parseFloat(min_confidence), parseInt(limit, 10));
        res.json(pairs);
    } catch (err) { next(err); }
});

/**
 * POST /api/candidates/merge
 * Merges merge_id into keep_id ΓÇö migrates all data, soft-deletes the duplicate.
 */
router.post('/merge', authenticate, authorize('admin', 'supervisor'), async (req, res, next) => {
    try {
        const { keep_id, merge_id } = req.body;
        if (!keep_id || !merge_id) {
            return res.status(400).json({ error: 'keep_id and merge_id are required' });
        }
        if (keep_id === merge_id) {
            return res.status(400).json({ error: 'keep_id and merge_id must be different' });
        }
        const { mergeCandidates } = require('../services/duplicate-detection');
        const result = await mergeCandidates(keep_id, merge_id, req.user.id);
        res.json(result);
    } catch (err) { next(err); }
});

// ΓöÇΓöÇ Chatbot status notification helper ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
// Fires and forgets ΓÇö does not block the API response.
const STATUS_NOTIFY_MAP = ['shortlisted', 'interview_scheduled', 'hired', 'rejected_with_alternatives'];

async function _notifyChatbotStatusChange(candidate, newStatus) {
    if (!STATUS_NOTIFY_MAP.includes(newStatus)) return;

    const chatbotUrl = process.env.CHATBOT_API_URL || 'http://localhost:8000';
    const apiKey = process.env.CHATBOT_API_KEY;
    if (!apiKey) {
        logger.warn('Cannot notify chatbot of status change ΓÇö CHATBOT_API_KEY not set');
        return;
    }

    const phone = candidate.whatsapp_phone || candidate.phone;
    if (!phone) {
        logger.warn(`Cannot notify chatbot ΓÇö candidate ${candidate.id} has no phone`);
        return;
    }

    // Resolve job title from most recent application
    let jobTitle = 'your applied position';
    let interviewDate = null;
    let interviewLocation = null;
    let alternativeJobs = null;

    try {
        const appSQL = isMySQL
            ? `SELECT j.title, a.metadata FROM applications a
               LEFT JOIN jobs j ON a.job_id = j.id
               WHERE a.candidate_id = ? ORDER BY a.applied_at DESC LIMIT 1`
            : `SELECT j.title, a.metadata FROM applications a
               LEFT JOIN jobs j ON a.job_id = j.id
               WHERE a.candidate_id = $1 ORDER BY a.applied_at DESC LIMIT 1`;
        const appResult = await query(appSQL, [candidate.id]);
        if (appResult.rows.length > 0) {
            jobTitle = appResult.rows[0].title || jobTitle;
            const meta = appResult.rows[0].metadata;
            if (meta) {
                const parsed = typeof meta === 'string' ? JSON.parse(meta) : meta;
                interviewDate = parsed.interview_date || null;
                interviewLocation = parsed.interview_location || null;
            }
        }

        // For rejected_with_alternatives, find other active jobs
        if (newStatus === 'rejected_with_alternatives') {
            const altSQL = isMySQL
                ? `SELECT title FROM jobs WHERE status = 'active' ORDER BY created_at DESC LIMIT 3`
                : `SELECT title FROM jobs WHERE status = 'active' ORDER BY created_at DESC LIMIT 3`;
            const altResult = await query(altSQL, []);
            if (altResult.rows.length > 0) {
                alternativeJobs = altResult.rows.map(r => r.title);
            }
        }
    } catch (lookupErr) {
        logger.warn(`Status notify: job lookup failed ΓÇö ${lookupErr.message}`);
    }

    try {
        await axios.post(
            `${chatbotUrl}/webhook/candidate-status`,
            {
                candidate_phone: phone,
                candidate_name: candidate.name || 'Candidate',
                status: newStatus,
                job_title: jobTitle,
                interview_date: interviewDate,
                interview_location: interviewLocation,
                alternative_jobs: alternativeJobs,
            },
            {
                headers: { 'x-chatbot-api-key': apiKey },
                timeout: 10000,
            }
        );
        logger.info(`Status notification sent to chatbot for candidate ${candidate.id}: ${newStatus}`);
    } catch (err) {
        logger.warn(`Failed to notify chatbot of status change for ${candidate.id}: ${err.message}`);
    }
}

module.exports = router;
~~~

Current code:
~~~
const express = require('express');
const router = express.Router();
const { query, generateUUID } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { adaptQuery, isMySQL } = require('../utils/query-adapter');
const axios = require('axios');
const logger = require('../utils/logger');
const { resolveCvAccessUrl } = require('../utils/cv-url');

/**
 * Get all candidates with filters and pagination
 * Compatible with both MySQL and PostgreSQL
 */
router.get('/', authenticate, async (req, res, next) => {
    try {
        const {
            page = 1,
            limit = 20,
            status,
            source,
            search,
            language,
            conversation_stage,
            cv_uploaded
        } = req.query;

        const offset = (page - 1) * limit;

        const params = [];
        let whereClause = ' WHERE 1=1';

        if (status) {
            whereClause += isMySQL ? ' AND status = ?' : ` AND status = $${params.length + 1}`;
            params.push(status);
        }

        if (source) {
            whereClause += isMySQL ? ' AND source = ?' : ` AND source = $${params.length + 1}`;
            params.push(source);
        }

        if (language) {
            // singlish/tanglish are stored as si/ta in the DB; normalise before filtering
            const LANG_NORM = { singlish: 'si', tanglish: 'ta' };
            const normLang = LANG_NORM[language] || language;
            whereClause += isMySQL ? ' AND preferred_language = ?' : ` AND preferred_language = $${params.length + 1}`;
            params.push(normLang);
        }

        if (search) {
            if (isMySQL) {
                whereClause += ' AND (name LIKE ? OR phone LIKE ? OR email LIKE ?)';
                params.push(`%${search}%`, `%${search}%`, `%${search}%`);
            } else {
                whereClause += ` AND (name ILIKE $${params.length + 1} OR phone ILIKE $${params.length + 1} OR email ILIKE $${params.length + 1})`;
                params.push(`%${search}%`);
            }
        }

        if (conversation_stage) {
            whereClause += isMySQL ? ' AND conversation_stage = ?' : ` AND conversation_stage = $${params.length + 1}`;
            params.push(conversation_stage);
        }

        if (typeof cv_uploaded !== 'undefined') {
            const cvUploadedBool = String(cv_uploaded).toLowerCase() === 'true';
            whereClause += isMySQL ? ' AND cv_uploaded = ?' : ` AND cv_uploaded = $${params.length + 1}`;
            params.push(cvUploadedBool);
        }

        // Count query
        const countQuery = `SELECT COUNT(*) as count FROM candidates${whereClause}`;
        const countResult = await query(countQuery, [...params]);
        const total = isMySQL ? countResult.rows[0].count : parseInt(countResult.rows[0].count);

        // List query with pagination
        let listQuery;
        let listParams;
        if (isMySQL) {
            listQuery = `SELECT * FROM candidates${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
            listParams = [...params, parseInt(limit), parseInt(offset)];
        } else {
            listQuery = `SELECT * FROM candidates${whereClause} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
            listParams = [...params, limit, offset];
        }

        const result = await query(listQuery, listParams);

        res.json({
            data: result.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: total,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * Get candidate by ID with full details
 */
router.get('/:id', authenticate, async (req, res, next) => {
    try {
        const { id } = req.params;
        const placeholder = isMySQL ? '?' : '$1';

        // Get candidate
        const candidateResult = await query(
            `SELECT * FROM candidates WHERE id = ${placeholder}`,
            [id]
        );

        if (candidateResult.rows.length === 0) {
            return res.status(404).json({ error: 'Candidate not found' });
        }

        let candidate = candidateResult.rows[0];

        // Extract age / height / language_register from JSONB metadata so the frontend doesn't need to dig  
        let metadata = {};
        try {
            metadata = candidate.metadata
                ? (typeof candidate.metadata === 'string' ? JSON.parse(candidate.metadata) : candidate.metadata)
                : {};
        } catch (_) {}
        candidate = {
            ...candidate,
            age: metadata.age ?? null,
            height_cm: metadata.height_cm ?? null,
            // Expose the precise language register (singlish/tanglish/si/ta/en)
            language_register: metadata.language_register ?? candidate.preferred_language ?? null,
        };

        // Get CVs
        const cvsResult = await query(
            `SELECT * FROM cv_files WHERE candidate_id = ${placeholder} ORDER BY uploaded_at DESC`,
            [id]
        );

        // Get applications (include project info for Projects tab)
        const applicationsResult = await query(
            isMySQL
                ? `SELECT a.*, j.title as job_title, j.category as job_category,
                          p.id as project_id, p.title as project_title
                   FROM applications a
                   JOIN jobs j ON a.job_id = j.id
                   LEFT JOIN projects p ON j.project_id = p.id
                   WHERE a.candidate_id = ?
                   ORDER BY a.applied_at DESC`
                : `SELECT a.*, j.title as job_title, j.category as job_category,
                          p.id as project_id, p.title as project_title
                   FROM applications a
                   JOIN jobs j ON a.job_id = j.id
                   LEFT JOIN projects p ON j.project_id = p.id
                   WHERE a.candidate_id = $1
                   ORDER BY a.applied_at DESC`,
            [id]
        );

        // Get communications
        const communicationsResult = await query(
            `SELECT * FROM communications
             WHERE candidate_id = ${placeholder}
             ORDER BY sent_at DESC
             LIMIT 50`,
            [id]
        );

        const enrichedCvs = (cvsResult.rows || []).map((cv) => {
            const resolved = resolveCvAccessUrl(cv);
            const parsedData = cv?.parsed_data && typeof cv.parsed_data === 'string'
                ? (() => {
                    try { return JSON.parse(cv.parsed_data); } catch (_) { return null; }
                })()
                : cv?.parsed_data;

            const documentCategory = parsedData?.__document_category === 'additional'
                ? 'additional'
                : 'cv';

            return {
                ...cv,
                document_category: documentCategory,
                resolved_file_url: resolved.url,
                cv_retrieval_status: resolved.status,
                cv_url_source: resolved.source,
            };
        });

        res.json({
            ...candidate,
            cvs: enrichedCvs,
            applications: applicationsResult.rows,
            communications: communicationsResult.rows
        });
    } catch (error) {
        next(error);
    }
});

/**
 * Create new candidate manually
 */
router.post('/', authenticate, async (req, res, next) => {
    try {
        const {
            name,
            phone,
            email,
            source = 'manual',
            preferred_language = 'en',
            notes
        } = req.body;

        if (!name || !phone) {
            return res.status(400).json({ error: 'Name and phone are required' });
        }

        if (isMySQL) {
            // MySQL: Insert then select
            const id = generateUUID();
            await query(
                `INSERT INTO candidates (id, name, phone, email, source, preferred_language, notes, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'new')`,
                [id, name, phone, email, source, preferred_language, notes]
            );

            const result = await query('SELECT * FROM candidates WHERE id = ?', [id]);
            res.status(201).json(result.rows[0]);
        } else {
            // PostgreSQL: Use RETURNING
            const result = await query(
                `INSERT INTO candidates (name, phone, email, source, preferred_language, notes, status)
                 VALUES ($1, $2, $3, $4, $5, $6, 'new')
                 RETURNING *`,
                [name, phone, email, source, preferred_language, notes]
            );
            res.status(201).json(result.rows[0]);
        }
    } catch (error) {
        if (error.message.includes('duplicate') || error.message.includes('Duplicate')) {
            return res.status(400).json({ error: 'Candidate with this phone or email already exists' });
        }
        next(error);
    }
});

/**
 * Update candidate
 */
router.put('/:id', authenticate, async (req, res, next) => {
    try {
        const { id } = req.params;
        const updates = req.body;

        const allowedFields = [
            'name', 'full_name', 'email', 'status', 'preferred_language', 'notes', 'tags',
            'skills', 'experience_years', 'highest_qualification', 'conversation_stage',
            'cv_uploaded', 'cv_status', 'last_interaction'
        ];
        const setClause = [];
        const values = [];

        Object.keys(updates).forEach(key => {
            if (allowedFields.includes(key)) {
                if (isMySQL) {
                    setClause.push(`${key} = ?`);
                } else {
                    setClause.push(`${key} = $${values.length + 1}`);
                }
                // Handle JSON fields for MySQL
                if (key === 'tags' && isMySQL && Array.isArray(updates[key])) {
                    values.push(JSON.stringify(updates[key]));
                } else {
                    values.push(updates[key]);
                }
            }
        });

        if (setClause.length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }

        values.push(id);

        if (isMySQL) {
            // MySQL: Update then select
            const updateQuery = `UPDATE candidates SET ${setClause.join(', ')}, updated_at = NOW() WHERE id = ?`;
            const updateResult = await query(updateQuery, values);

            if (updateResult.rowCount === 0) {
                return res.status(404).json({ error: 'Candidate not found' });
            }

            const result = await query('SELECT * FROM candidates WHERE id = ?', [id]);
            const updatedCandidate = result.rows[0];
            res.json(updatedCandidate);

            // Notify chatbot of status change (async, non-blocking)
            if (updates.status) {
                _notifyChatbotStatusChange(updatedCandidate, updates.status);
            }
        } else {
            // PostgreSQL: Use RETURNING
            const updateQuery = `UPDATE candidates SET ${setClause.join(', ')}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`;
            const result = await query(updateQuery, values);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Candidate not found' });
            }

            const updatedCandidate = result.rows[0];
            res.json(updatedCandidate);

            // Notify chatbot of status change (async, non-blocking)
            if (updates.status) {
                _notifyChatbotStatusChange(updatedCandidate, updates.status);
            }
        }
    } catch (error) {
        next(error);
    }
});

/**
 * Delete candidate
 */
router.delete('/:id', authenticate, authorize('admin'), async (req, res, next) => {
    try {
        const { id } = req.params;
        const placeholder = isMySQL ? '?' : '$1';

        if (isMySQL) {
            // Check if exists first
            const checkResult = await query(`SELECT id FROM candidates WHERE id = ?`, [id]);
            if (checkResult.rows.length === 0) {
                return res.status(404).json({ error: 'Candidate not found' });
            }
            await query(`DELETE FROM candidates WHERE id = ?`, [id]);
        } else {
            const result = await query(
                `DELETE FROM candidates WHERE id = ${placeholder} RETURNING *`,
                [id]
            );
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Candidate not found' });
            }
        }

        res.json({ message: 'Candidate deleted successfully' });
    } catch (error) {
        next(error);
    }
});

// â”€â”€ Duplicate detection routes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * GET /api/candidates/duplicates
 * Returns potential duplicate pairs with confidence scores.
 */
router.get('/duplicates', authenticate, async (req, res, next) => {
    try {
        const { min_confidence = 0.5, limit = 100 } = req.query;
        const { findDuplicates } = require('../services/duplicate-detection');
        const pairs = await findDuplicates(parseFloat(min_confidence), parseInt(limit, 10));
        res.json(pairs);
    } catch (err) { next(err); }
});

/**
 * POST /api/candidates/merge
 * Merges merge_id into keep_id â€” migrates all data, soft-deletes the duplicate.
 */
router.post('/merge', authenticate, authorize('admin', 'supervisor'), async (req, res, next) => {
    try {
        const { keep_id, merge_id } = req.body;
        if (!keep_id || !merge_id) {
            return res.status(400).json({ error: 'keep_id and merge_id are required' });
        }
        if (keep_id === merge_id) {
            return res.status(400).json({ error: 'keep_id and merge_id must be different' });
        }
        const { mergeCandidates } = require('../services/duplicate-detection');
        const result = await mergeCandidates(keep_id, merge_id, req.user.id);
        res.json(result);
    } catch (err) { next(err); }
});

// â”€â”€ Chatbot status notification helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Fires and forgets â€” does not block the API response.
const STATUS_NOTIFY_MAP = ['shortlisted', 'interview_scheduled', 'hired', 'rejected_with_alternatives'];

async function _notifyChatbotStatusChange(candidate, newStatus) {
    if (!STATUS_NOTIFY_MAP.includes(newStatus)) return;

    const chatbotUrl = process.env.CHATBOT_API_URL || 'http://localhost:8000';
    const apiKey = process.env.CHATBOT_API_KEY;
    if (!apiKey) {
        logger.warn('Cannot notify chatbot of status change â€” CHATBOT_API_KEY not set');
        return;
    }

    const phone = candidate.whatsapp_phone || candidate.phone;
    if (!phone) {
        logger.warn(`Cannot notify chatbot â€” candidate ${candidate.id} has no phone`);
        return;
    }

    // Resolve job title from most recent application
    let jobTitle = 'your applied position';
    let interviewDate = null;
    let interviewLocation = null;
    let alternativeJobs = null;

    try {
        const appSQL = isMySQL
            ? `SELECT j.title, a.metadata FROM applications a
               LEFT JOIN jobs j ON a.job_id = j.id
               WHERE a.candidate_id = ? ORDER BY a.applied_at DESC LIMIT 1`
            : `SELECT j.title, a.metadata FROM applications a
               LEFT JOIN jobs j ON a.job_id = j.id
               WHERE a.candidate_id = $1 ORDER BY a.applied_at DESC LIMIT 1`;
        const appResult = await query(appSQL, [candidate.id]);
        if (appResult.rows.length > 0) {
            jobTitle = appResult.rows[0].title || jobTitle;
            const meta = appResult.rows[0].metadata;
            if (meta) {
                const parsed = typeof meta === 'string' ? JSON.parse(meta) : meta;
                interviewDate = parsed.interview_date || null;
                interviewLocation = parsed.interview_location || null;
            }
        }

        // For rejected_with_alternatives, find other active jobs
        if (newStatus === 'rejected_with_alternatives') {
            const altSQL = isMySQL
                ? `SELECT title FROM jobs WHERE status = 'active' ORDER BY created_at DESC LIMIT 3`
                : `SELECT title FROM jobs WHERE status = 'active' ORDER BY created_at DESC LIMIT 3`;
            const altResult = await query(altSQL, []);
            if (altResult.rows.length > 0) {
                alternativeJobs = altResult.rows.map(r => r.title);
            }
        }
    } catch (lookupErr) {
        logger.warn(`Status notify: job lookup failed â€” ${lookupErr.message}`);
    }

    try {
        await axios.post(
            `${chatbotUrl}/webhook/candidate-status`,
            {
                candidate_phone: phone,
                candidate_name: candidate.name || 'Candidate',
                status: newStatus,
                job_title: jobTitle,
                interview_date: interviewDate,
                interview_location: interviewLocation,
                alternative_jobs: alternativeJobs,
            },
            {
                headers: { 'x-chatbot-api-key': apiKey },
                timeout: 10000,
            }
        );
        logger.info(`Status notification sent to chatbot for candidate ${candidate.id}: ${newStatus}`);
    } catch (err) {
        logger.warn(`Failed to notify chatbot of status change for ${candidate.id}: ${err.message}`);
    }
}

module.exports = router;

~~~

## recruitment-system/backend/src/routes/chatbot-intake.js

Previous code:
~~~
/**
 * Chatbot Intake Route
 * ====================
 * Secure endpoint that receives fully collected candidate data
 * from the WhatsApp Python chatbot and creates/updates the
 * candidate record in the recruitment system.
 *
 * Auth: x-chatbot-api-key header (shared secret, NOT JWT)
 *
 * POST /api/chatbot/intake
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { query, generateUUID } = require('../config/database');
const { saveCVFile } = require('../utils/gcs-upload');
const { isMySQL } = require('../utils/query-adapter');
const rateLimit = require('express-rate-limit');
const logger = require('../utils/logger');
const { recruiterAlert } = require('../services/recruiter-alerts');
const { checkForDuplicate } = require('../services/duplicate-detection');
const multer = require('multer');
const { normalizeIncomingCvUrl } = require('../utils/cv-url');

// Multer for multipart/form-data CV uploads (max 20MB)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 },
});

// ΓöÇΓöÇ Strict rate limit for this endpoint ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
const chatbotLimiter = rateLimit({
    windowMs: 60 * 1000,   // 1 minute window
    max: 60,               // max 60 calls per minute (1 per second avg)
    message: { error: 'Too many requests from chatbot, slow down.' },
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false }, // trust proxy is set at app level
});

// ΓöÇΓöÇ API Key Authentication middleware (supports dual-key rotation) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
function authenticateChatbot(req, res, next) {
    const apiKey = req.headers['x-chatbot-api-key'];
    const expectedKey = process.env.CHATBOT_API_KEY;
    const expectedOldKey = process.env.CHATBOT_API_KEY_OLD;

    if (!expectedKey) {
        logger.error('CHATBOT_API_KEY not set in environment!');
        return res.status(500).json({ error: 'Server misconfiguration: chatbot key not set' });
    }

    if (!apiKey) {
        logger.warn(`Chatbot intake: rejected request with no key from ${req.ip}`);
        return res.status(401).json({ error: 'Unauthorized: missing chatbot API key' });
    }

    // Accept current key
    if (apiKey === expectedKey) {
        return next();
    }

    // Accept old key during rotation window
    if (expectedOldKey && apiKey === expectedOldKey) {
        logger.info('Chatbot intake: authenticated with OLD API key ΓÇö rotation in progress');
        return next();
    }

    logger.warn(`Chatbot intake: rejected request with invalid key from ${req.ip}`);
    return res.status(401).json({ error: 'Unauthorized: invalid chatbot API key' });
}

// ΓöÇΓöÇ GET /api/chatbot/jobs ΓÇö Active jobs for chatbot job cache bootstrap ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
router.get('/jobs', authenticateChatbot, async (req, res) => {
    try {
        const jobsSQL = isMySQL
            ? `SELECT j.id, j.title, j.category, j.status, j.salary_range,
                      j.requirements, j.positions_available,
                      p.id as project_id, p.countries, p.benefits, p.interview_date
               FROM jobs j
               LEFT JOIN projects p ON j.project_id = p.id
               WHERE j.status = 'active'
               ORDER BY j.created_at DESC`
            : `SELECT j.id, j.title, j.category, j.status, j.salary_range,
                      j.requirements, j.positions_available,
                      p.id as project_id, p.countries, p.benefits, p.interview_date
               FROM jobs j
               LEFT JOIN projects p ON j.project_id = p.id
               WHERE j.status = 'active'
               ORDER BY j.created_at DESC`;

        const result = await query(jobsSQL, []);
        const jobs = result.rows.map(job => {
            let requirements = {};
            if (job.requirements) {
                try {
                    requirements = typeof job.requirements === 'string'
                        ? JSON.parse(job.requirements)
                        : job.requirements;
                } catch (e) { /* ignore parse error */ }
            }
            return {
                job_id: job.id,
                title: job.title,
                category: job.category,
                status: job.status,
                salary_range: job.salary_range,
                positions_available: job.positions_available,
                project_id: job.project_id,
                requirements,
            };
        });

        logger.info(`Chatbot jobs fetch: returned ${jobs.length} active jobs`);
        return res.json({ jobs });
    } catch (error) {
        logger.error('Chatbot jobs fetch error:', error);
        return res.status(500).json({ error: 'Failed to fetch jobs', detail: error.message });
    }
});

// ΓöÇΓöÇ Payload Validation middleware ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
function validateIntakePayload(req, res, next) {
    const { phone, name, job_interest } = req.body;
    const errors = [];

    // phone: required, E.164-compatible
    if (!phone || typeof phone !== 'string') {
        errors.push('phone is required');
    } else {
        const normalizedPhone = phone.replace(/[\s\-]/g, '');
        if (!/^\+?[0-9]{7,15}$/.test(normalizedPhone)) {
            errors.push(`phone format invalid: "${phone}" ΓÇö expected E.164 e.g. +94771234567`);
        }
    }

    // name: required, min 2 chars
    if (!name || typeof name !== 'string' || name.trim().length < 2) {
        errors.push('name is required (min 2 characters)');
    }

    // job_interest: required
    if (!job_interest || typeof job_interest !== 'string' || job_interest.trim().length < 2) {
        errors.push('job_interest is required (which role the candidate applied for)');
    }

    // email: optional but must be valid if provided
    const { email } = req.body;
    if (email && typeof email === 'string' && email.trim().length > 0) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
            errors.push(`email format invalid: "${email}"`);
        }
    }

    // experience_years: optional but must be integer 0ΓÇô60
    const { experience_years } = req.body;
    if (experience_years !== undefined && experience_years !== null) {
        const exp = parseInt(experience_years, 10);
        if (isNaN(exp) || exp < 0 || exp > 60) {
            errors.push('experience_years must be an integer between 0 and 60');
        }
    }

    // preferred_language: must be en/si/ta/singlish/tanglish if provided
    const { preferred_language } = req.body;
    if (preferred_language && !['en', 'si', 'ta', 'singlish', 'tanglish'].includes(preferred_language)) {
        errors.push('preferred_language must be one of: en, si, ta, singlish, tanglish');
    }

    if (errors.length > 0) {
        logger.warn('Chatbot intake validation failed:', errors);
        return res.status(400).json({
            error: 'Validation failed',
            details: errors
        });
    }

    next();
}

// ΓöÇΓöÇ Normalize phone to E.164-ish format ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
function normalizePhone(phone) {
    return phone.replace(/[\s\-()]/g, '');
}

function parseAdditionalDocuments(rawValue) {
    if (!rawValue) return [];
    if (Array.isArray(rawValue)) return rawValue;
    if (typeof rawValue === 'string') {
        try {
            const parsed = JSON.parse(rawValue);
            return Array.isArray(parsed) ? parsed : [];
        } catch (err) {
            logger.warn(`Chatbot intake: failed to parse additional_documents JSON ΓÇö ${err.message}`);
            return [];
        }
    }
    return [];
}

function inferFileType(fileName) {
    const ext = String(fileName || '').toLowerCase().split('.').pop();
    if (!ext || ext === String(fileName || '').toLowerCase()) return 'document';
    if (['pdf', 'doc', 'docx', 'txt', 'rtf'].includes(ext)) return ext;
    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) return 'image';
    return ext;
}

function withDocumentCategory(parsedData, category) {
    const base = parsedData && typeof parsedData === 'object' && !Array.isArray(parsedData)
        ? parsedData
        : {};

    return {
        ...base,
        __document_category: category,
    };
}

// ΓöÇΓöÇ Main Intake Handler ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

/**
 * POST /api/chatbot/intake
 *
 * Body:
 *   phone              string  REQUIRED
 *   name               string  REQUIRED
 *   job_interest       string  REQUIRED  (job title candidate applied for)
 *   email              string  optional
 *   preferred_language string  optional  (en|si|ta)
 *   skills             string  optional  (comma-separated)
 *   experience_years   number  optional
 *   highest_qualification string optional
 *   destination_country string optional
 *   cv_file_path       string  optional  (local path on chatbot server)
 *   cv_base64          string  optional  (base64 encoded file contents)
 *   cv_file_name       string  optional  (name of the file if base64 provided)
 *   cv_raw_text        string  optional
 *   cv_parsed_data     object  optional  (full JSON from chatbot extraction)
 *   additional_documents array optional (each: {file_name, file_url|file_path|file_base64, raw_text?, parsed_data?})
 *   job_id             string  optional  (UUID ΓÇö known if candidate came via ad)
 *   ad_ref             string  optional  (e.g. "job_abc123" from META ad)
 *   chatbot_candidate_id number optional (chatbot's internal candidate PK)
 *
 * Response 201: { candidate_id, application_id, status: "created" }
 * Response 200: { candidate_id, application_id, status: "updated" }
 */
router.post(
    '/',
    chatbotLimiter,
    authenticateChatbot,
    upload.fields([
        { name: 'cv_file', maxCount: 1 },
        { name: 'additional_files', maxCount: 10 }
    ]),  // Accept optional multipart CV + additional documents
    // Merge multipart payload field into req.body if present
    (req, res, next) => {
        if (req.body.payload) {
            try {
                const parsed = JSON.parse(req.body.payload);
                req.body = { ...parsed };
            } catch (e) {
                return res.status(400).json({ error: 'Invalid JSON in payload field' });
            }
        }

        // Verify CV checksum if provided
        const multipartCvFile = req.files?.cv_file?.[0] || null;
        if (multipartCvFile && req.headers['x-cv-checksum']) {
            const actual = crypto.createHash('sha256').update(multipartCvFile.buffer).digest('hex');
            if (actual !== req.headers['x-cv-checksum']) {
                logger.warn(`CV checksum mismatch: expected=${req.headers['x-cv-checksum']}, actual=${actual}`);
                return res.status(400).json({ error: 'CV file checksum mismatch ΓÇö file corrupted in transit' });
            }
            logger.debug(`CV checksum verified: ${actual.substring(0, 16)}...`);
        }

        next();
    },
    validateIntakePayload,
    async (req, res) => {
        const idempotencyKey = req.headers['x-idempotency-key'];

        // ΓöÇΓöÇ Idempotency check: reject duplicate submissions ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
        if (idempotencyKey) {
            try {
                const idempSQL = isMySQL
                    ? 'SELECT candidate_id, application_id, status FROM chatbot_intake_log WHERE idempotency_key = ? LIMIT 1'
                    : 'SELECT candidate_id, application_id, status FROM chatbot_intake_log WHERE idempotency_key = $1 LIMIT 1';
                const idempResult = await query(idempSQL, [idempotencyKey]);
                if (idempResult.rows.length > 0) {
                    const prev = idempResult.rows[0];
                    logger.info(`Chatbot intake: idempotent replay for key ${idempotencyKey.substring(0, 12)}...`);
                    return res.status(200).json({
                        status: 'already_processed',
                        candidate_id: prev.candidate_id,
                        application_id: prev.application_id,
                        message: 'This submission was already processed (idempotency key match)'
                    });
                }
            } catch (idempErr) {
                // Table might not exist yet ΓÇö log and continue (non-blocking)
                logger.warn(`Idempotency check skipped (table may not exist): ${idempErr.message}`);
            }
        }

        const {
            phone,
            name,
            email,
            preferred_language: raw_preferred_language = 'en',
            source = 'whatsapp',
            experience_years,
            highest_qualification,
            job_interest,
            destination_country,
            cv_file_path,
            cv_base64,
            cv_file_name,
            cv_raw_text,
            cv_parsed_data,
            additional_documents,
            job_id: providedJobId,
            ad_ref,
            chatbot_candidate_id
        } = req.body;

        const multipartCvFile = req.files?.cv_file?.[0] || null;
        const multipartAdditionalFiles = Array.isArray(req.files?.additional_files)
            ? req.files.additional_files
            : [];

        const hasMultipartCV = Boolean(multipartCvFile && multipartCvFile.buffer);
        const additionalDocumentsFromPayload = parseAdditionalDocuments(additional_documents);
        const requireCvForChatbot = process.env.CHATBOT_REQUIRE_CV !== 'false';
        const hasAnyCvPayload = Boolean(cv_file_path || cv_base64 || hasMultipartCV);

        if (requireCvForChatbot && hasAnyCvPayload === false) {
            logger.warn('Chatbot intake: rejected candidate onboarding because CV payload is missing');
            return res.status(422).json({
                success: false,
                error: 'CV file is required for chatbot onboarding.',
                code: 'cv_required'
            });
        }

        // `skills` needs to be mutable so we can fall back to cv_parsed_data.technical_skills
        let skills = req.body.skills;

        // ΓöÇΓöÇ Normalize language: singlishΓåÆsi, tanglishΓåÆta ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
        const LANG_NORMALISE_MAP = { singlish: 'si', tanglish: 'ta' };
        const preferred_language = LANG_NORMALISE_MAP[raw_preferred_language] || raw_preferred_language || 'en';
        const language_register = raw_preferred_language; // keep the precise register

        const normalizedPhone = normalizePhone(phone);

        try {
            // ΓöÇΓöÇ Step 1: Lookup existing candidate by phone ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
            let existingCandidate = null;
            const lookupSQL = isMySQL
                ? 'SELECT id, name, status, metadata FROM candidates WHERE phone = ? OR whatsapp_phone = ? LIMIT 1'
                : 'SELECT id, name, status, metadata FROM candidates WHERE phone = $1 OR whatsapp_phone = $2 LIMIT 1';

            const lookupResult = await query(lookupSQL, [normalizedPhone, normalizedPhone]);
            existingCandidate = lookupResult.rows.length > 0 ? lookupResult.rows[0] : null;

            let existingMetadata = {};
            if (existingCandidate && existingCandidate.metadata) {
                try {
                    existingMetadata = typeof existingCandidate.metadata === 'string'
                        ? JSON.parse(existingCandidate.metadata)
                        : existingCandidate.metadata;
                } catch (e) { }
            }

            let metadataUpdates = {};
            if (cv_parsed_data) {
                if (cv_parsed_data.mismatches) metadataUpdates.mismatches = cv_parsed_data.mismatches;
                if (cv_parsed_data.age != null) metadataUpdates.age = cv_parsed_data.age;
                if (cv_parsed_data.height_cm != null) metadataUpdates.height_cm = cv_parsed_data.height_cm;
                // Store the precise language register (singlish/tanglish/si/ta/en)
                if (cv_parsed_data.language_register) {
                    metadataUpdates.language_register = cv_parsed_data.language_register;
                }
                // Store experience_years from CV parsed data in metadata for UI display
                const cvExp = cv_parsed_data.total_experience_years ?? cv_parsed_data.experience_years;
                if (cvExp != null) metadataUpdates.experience_years = cvExp;

                // Fallback: derive skills string from CV's technical_skills if top-level skills is missing
                if (!skills && cv_parsed_data.technical_skills) {
                    const ts = cv_parsed_data.technical_skills;
                    skills = Array.isArray(ts) ? ts.join(', ') : String(ts);
                }
            }
            // Also capture language_register from top-level if not already in cv_parsed_data
            if (!metadataUpdates.language_register && language_register) {
                metadataUpdates.language_register = language_register;
            }

            // Always store the candidate's stated job interest and destination in metadata
            // so recruiters can see it in the CV Manager even when no job_id is matched
            if (job_interest) {
                metadataUpdates.job_interest_stated = job_interest.trim();
            }
            if (destination_country) {
                metadataUpdates.destination_country = destination_country.trim();
            }

            // Propagate future_pool flag set by the chatbot (unmatched job role)
            if (cv_parsed_data && cv_parsed_data.future_pool) {
                metadataUpdates.future_pool = true;
                metadataUpdates.future_pool_role = cv_parsed_data.future_pool_role || job_interest || '';
            }

            const mergedMetadata = { ...existingMetadata, ...metadataUpdates };
            // Produce a valid JSON value (never the string "null")
            const metadataJson = Object.keys(mergedMetadata).length > 0
                ? JSON.stringify(mergedMetadata)
                : null;

            let candidateId;
            let responseStatus;

            if (existingCandidate) {
                // ΓöÇΓöÇ Step 2a: UPDATE existing candidate ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
                candidateId = existingCandidate.id;
                responseStatus = 'updated';

                const updateSQL = isMySQL
                    ? `UPDATE candidates SET
                        name                 = COALESCE(?, name),
                        email                = COALESCE(?, email),
                        preferred_language   = ?,
                        skills               = COALESCE(?, skills),
                        experience_years     = COALESCE(?, experience_years),
                        highest_qualification = COALESCE(?, highest_qualification),
                        whatsapp_phone       = ?,
                        chatbot_ref          = COALESCE(?, chatbot_ref),
                        ad_ref               = COALESCE(?, ad_ref),
                        metadata             = ?,
                        last_contact_at      = NOW(),
                        updated_at           = NOW()
                       WHERE id = ?`
                    : `UPDATE candidates SET
                        name                 = COALESCE($1, name),
                        email                = COALESCE($2, email),
                        preferred_language   = $3,
                        skills               = COALESCE($4, skills),
                        experience_years     = COALESCE($5, experience_years),
                        highest_qualification = COALESCE($6, highest_qualification),
                        whatsapp_phone       = $7,
                        chatbot_ref          = COALESCE($8, chatbot_ref),
                        ad_ref               = COALESCE($9, ad_ref),
                        metadata             = $10,
                        last_contact_at      = NOW(),
                        updated_at           = NOW()
                       WHERE id = $11`;

                await query(updateSQL, [
                    name?.trim() || null,
                    email?.trim() || null,
                    preferred_language,
                    skills || null,
                    (experience_years != null && !isNaN(parseInt(experience_years, 10))) ? parseInt(experience_years, 10) : null,
                    highest_qualification || null,
                    normalizedPhone,
                    chatbot_candidate_id ? String(chatbot_candidate_id) : null,
                    ad_ref || null,
                    metadataJson,   // unified JSON string or null ΓÇö no double-stringify
                    candidateId
                ]);

                logger.info(`Chatbot intake: UPDATED candidate ${candidateId} (${normalizedPhone})`);
            } else {
                // ΓöÇΓöÇ Step 2b: INSERT new candidate ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
                responseStatus = 'created';
                candidateId = generateUUID();

                const insertSQL = isMySQL
                    ? `INSERT INTO candidates
                        (id, phone, whatsapp_phone, name, email, source, preferred_language,
                         skills, experience_years, highest_qualification,
                         chatbot_ref, ad_ref, metadata, status, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', NOW(), NOW())`
                    : `INSERT INTO candidates
                        (id, phone, whatsapp_phone, name, email, source, preferred_language,
                         skills, experience_years, highest_qualification,
                         chatbot_ref, ad_ref, metadata, status)
                       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'new')`;

                await query(insertSQL, [
                    candidateId,
                    normalizedPhone,
                    normalizedPhone,
                    name.trim(),
                    email?.trim() || null,
                    source || 'whatsapp',
                    preferred_language,
                    skills || null,
                    (experience_years != null && !isNaN(parseInt(experience_years, 10))) ? parseInt(experience_years, 10) : null,
                    highest_qualification || null,
                    chatbot_candidate_id ? String(chatbot_candidate_id) : null,
                    ad_ref || null,
                    metadataJson    // unified JSON string or null ΓÇö no double-stringify
                ]);

                logger.info(`Chatbot intake: CREATED candidate ${candidateId} (${normalizedPhone})`);
            }

            // ΓöÇΓöÇ Step 3: Create CV + additional document records ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
            let cvFileId = null;
            const additionalDocumentIds = [];

            const insertDocumentRecord = async ({
                category,
                inputFileUrl,
                inputFileName,
                inputBase64,
                inputRawText,
                inputParsedData,
                multipartFile
            }) => {
                const recordId = generateUUID();
                const normalizedIncomingUrl = normalizeIncomingCvUrl(inputFileUrl, candidateId);
                let savedFileUrl = normalizedIncomingUrl;
                let savedFileName = inputFileName || (inputFileUrl ? inputFileUrl.split('/').pop() : `${category}_${normalizedPhone}.pdf`);
                const hasPhysicalPayload = Boolean(multipartFile || inputBase64 || inputFileUrl);

                if (multipartFile?.buffer) {
                    try {
                        const uploadDir = process.env.UPLOAD_DIR || null;
                        const fileBase64 = multipartFile.buffer.toString('base64');
                        savedFileName = multipartFile.originalname || savedFileName;
                        const { url: storedUrl, name: storedName } = await saveCVFile(
                            fileBase64,
                            savedFileName,
                            candidateId,
                            uploadDir
                        );
                        if (storedUrl) {
                            savedFileUrl = storedUrl;
                            savedFileName = storedName;
                            logger.info(`Chatbot intake: ${category} (multipart) stored at ${savedFileUrl}`);
                        }
                    } catch (err) {
                        logger.error(`Chatbot intake: Failed to save multipart ${category} ΓÇö ${err.message}`);
                    }
                } else if (inputBase64) {
                    try {
                        const uploadDir = process.env.UPLOAD_DIR || null;
                        const { url: storedUrl, name: storedName } = await saveCVFile(
                            inputBase64,
                            savedFileName,
                            candidateId,
                            uploadDir
                        );
                        if (storedUrl) {
                            savedFileUrl = storedUrl;
                            savedFileName = storedName;
                            logger.info(`Chatbot intake: ${category} stored at ${savedFileUrl}`);
                        }
                    } catch (err) {
                        logger.error(`Chatbot intake: Failed to save ${category} ΓÇö ${err.message}`);
                    }
                }

                const hasRetrievableUrl =
                    typeof savedFileUrl === 'string' &&
                    (savedFileUrl.startsWith('http://') || savedFileUrl.startsWith('https://') || savedFileUrl.startsWith('/'));

                if (hasPhysicalPayload && !hasRetrievableUrl) {
                    throw new Error(`${category}_storage_unretrievable`);
                }

                const documentParsedData = withDocumentCategory(inputParsedData, category);
                const detectedFileType = inferFileType(savedFileName);
                const isPrimary = category === 'cv';

                const cvInsertSQL = isMySQL
                    ? `INSERT INTO cv_files
                        (id, candidate_id, file_url, file_name, file_type,
                         ocr_status, ocr_text, parsed_data, uploaded_at, is_primary)
                       VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, NOW(), ?)`
                    : `INSERT INTO cv_files
                        (id, candidate_id, file_url, file_name, file_type,
                         ocr_status, ocr_text, parsed_data, is_primary)
                       VALUES ($1, $2, $3, $4, $5, 'completed', $6, $7, $8)`;

                await query(cvInsertSQL, [
                    recordId,
                    candidateId,
                    savedFileUrl,
                    savedFileName,
                    detectedFileType,
                    inputRawText || null,
                    JSON.stringify(documentParsedData),
                    isPrimary
                ]);

                return recordId;
            };

            if (cv_file_path || cv_raw_text || cv_parsed_data || cv_base64 || hasMultipartCV) {
                try {
                    cvFileId = await insertDocumentRecord({
                        category: 'cv',
                        inputFileUrl: cv_file_path,
                        inputFileName: cv_file_name || (cv_file_path ? cv_file_path.split('/').pop() : `chatbot_cv_${normalizedPhone}.pdf`),
                        inputBase64: cv_base64,
                        inputRawText: cv_raw_text,
                        inputParsedData: cv_parsed_data,
                        multipartFile: multipartCvFile
                    });
                } catch (err) {
                    if (err.message === 'cv_storage_unretrievable') {
                        logger.error(`Chatbot intake: rejecting onboarding for ${candidateId} because CV storage URL is not retrievable`);
                        return res.status(422).json({
                            success: false,
                            error: 'CV upload received but file URL is not retrievable. Please retry upload.',
                            candidate_id: candidateId,
                            code: 'cv_storage_unretrievable'
                        });
                    }
                    throw err;
                }
            }

            const additionalDocInputs = [
                ...additionalDocumentsFromPayload,
                ...multipartAdditionalFiles.map((file) => ({
                    file_name: file.originalname,
                    multipart_file: file
                }))
            ];

            for (const doc of additionalDocInputs) {
                const docName = doc.file_name || doc.name || 'additional_document';
                const docId = await insertDocumentRecord({
                    category: 'additional',
                    inputFileUrl: doc.file_url || doc.file_path || null,
                    inputFileName: docName,
                    inputBase64: doc.file_base64 || doc.base64 || null,
                    inputRawText: doc.raw_text || null,
                    inputParsedData: doc.parsed_data || null,
                    multipartFile: doc.multipart_file || null,
                });
                additionalDocumentIds.push(docId);
            }

            // ΓöÇΓöÇ Step 4: Resolve job_id from ad_ref or job lookup ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
            let resolvedJobId = providedJobId || null;

            if (!resolvedJobId && ad_ref) {
                // Find job_id from ad_tracking
                const adSQL = isMySQL
                    ? 'SELECT job_id FROM ad_tracking WHERE ad_ref = ? AND is_active = 1 LIMIT 1'
                    : 'SELECT job_id FROM ad_tracking WHERE ad_ref = $1 AND is_active = TRUE LIMIT 1';
                const adResult = await query(adSQL, [ad_ref]);
                if (adResult.rows.length > 0) {
                    resolvedJobId = adResult.rows[0].job_id;
                }
            }

            if (!resolvedJobId && job_interest) {
                // Best-effort: find active job by title match
                const jobSQL = isMySQL
                    ? `SELECT id FROM jobs
                       WHERE status = 'active'
                         AND (title LIKE ? OR title LIKE ?)
                       LIMIT 1`
                    : `SELECT id FROM jobs
                       WHERE status = 'active'
                         AND (title ILIKE $1 OR title ILIKE $2)
                       LIMIT 1`;
                const searchTerm = `%${job_interest.trim()}%`;
                const wordSearch = `%${job_interest.trim().split(' ')[0]}%`;
                const jobResult = await query(jobSQL, [searchTerm, wordSearch]);
                if (jobResult.rows.length > 0) {
                    resolvedJobId = jobResult.rows[0].id;
                    logger.info(`Chatbot intake: fuzzy-matched job "${job_interest}" ΓåÆ ${resolvedJobId}`);
                }
            }

            // ΓöÇΓöÇ Step 5: Create application record ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
            let applicationId = null;
            if (resolvedJobId) {
                // Check for duplicate application
                const dupSQL = isMySQL
                    ? 'SELECT id FROM applications WHERE candidate_id = ? AND job_id = ? LIMIT 1'
                    : 'SELECT id FROM applications WHERE candidate_id = $1 AND job_id = $2 LIMIT 1';
                const dupResult = await query(dupSQL, [candidateId, resolvedJobId]);

                if (dupResult.rows.length > 0) {
                    applicationId = dupResult.rows[0].id;
                    logger.info(`Chatbot intake: application already exists ${applicationId}`);
                } else {
                    applicationId = generateUUID();
                    const appSQL = isMySQL
                        ? `INSERT INTO applications
                            (id, candidate_id, job_id, status, applied_at,
                             metadata)
                           VALUES (?, ?, ?, 'applied', NOW(), ?)`
                        : `INSERT INTO applications
                            (id, candidate_id, job_id, status,
                             metadata)
                           VALUES ($1, $2, $3, 'applied', $4)`;

                    await query(appSQL, [
                        applicationId,
                        candidateId,
                        resolvedJobId,
                        JSON.stringify({
                            source: 'whatsapp_chatbot',
                            ad_ref: ad_ref || null,
                            destination_country: destination_country || null,
                            job_interest_stated: job_interest,
                            cv_file_id: cvFileId,
                            additional_document_ids: additionalDocumentIds
                        })
                    ]);

                    logger.info(`Chatbot intake: CREATED application ${applicationId} for candidate ${candidateId}`);
                }
            }

            // ΓöÇΓöÇ Step 5b: Set future_pool status when no job matched ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
            // When the chatbot marks a candidate as future_pool (requested role not available),
            // update their status so recruiters can find them in the Future Pool view.
            if (!resolvedJobId && cv_parsed_data && cv_parsed_data.future_pool) {
                const futurePoolSQL = isMySQL
                    ? `UPDATE candidates SET status = 'future_pool', updated_at = NOW() WHERE id = ? AND status = 'new'`
                    : `UPDATE candidates SET status = 'future_pool', updated_at = NOW() WHERE id = $1 AND status = 'new'`;
                await query(futurePoolSQL, [candidateId]).catch(err =>
                    logger.warn(`Failed to set future_pool status for candidate ${candidateId}: ${err.message}`)
                );
                logger.info(`Chatbot intake: candidate ${candidateId} set to future_pool (requested role: "${cv_parsed_data.future_pool_role || job_interest}")`);
            }

            // ΓöÇΓöÇ Step 6: Increment ad_tracking conversions ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
            if (ad_ref && responseStatus === 'created') {
                const adUpdateSQL = isMySQL
                    ? 'UPDATE ad_tracking SET conversions = conversions + 1, updated_at = NOW() WHERE ad_ref = ?'
                    : 'UPDATE ad_tracking SET conversions = conversions + 1, updated_at = NOW() WHERE ad_ref = $1';
                await query(adUpdateSQL, [ad_ref]).catch(err =>
                    logger.warn(`Failed to increment conversion for ad_ref ${ad_ref}: ${err.message}`)
                );
            }

            // ΓöÇΓöÇ Step 7: Log inbound communication ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
            const commId = generateUUID();
            const commSQL = isMySQL
                ? `INSERT INTO communications
                    (id, candidate_id, channel, direction, message_type, content, metadata, sent_at)
                   VALUES (?, ?, 'whatsapp', 'inbound', 'document', 'CV and application submitted via chatbot', ?, NOW())`
                : `INSERT INTO communications
                    (id, candidate_id, channel, direction, message_type, content, metadata)
                   VALUES ($1, $2, 'whatsapp', 'inbound', 'document', 'CV and application submitted via chatbot', $3)`;

            await query(commSQL, [
                commId,
                candidateId,
                JSON.stringify({
                    source: 'chatbot_intake',
                    ad_ref: ad_ref || null,
                    job_interest,
                    destination_country: destination_country || null,
                    cv_file_id: cvFileId,
                    additional_document_ids: additionalDocumentIds
                })
            ]).catch(err => logger.warn(`Failed to log communication: ${err.message}`));
            // ΓöÇΓöÇ Step 8: Log idempotency key for replay protection ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
            if (idempotencyKey) {
                try {
                    const logSQL = isMySQL
                        ? `INSERT INTO chatbot_intake_log
                            (id, idempotency_key, candidate_id, application_id, status, created_at)
                           VALUES (?, ?, ?, ?, ?, NOW())
                           ON DUPLICATE KEY UPDATE updated_at = NOW()`
                        : `INSERT INTO chatbot_intake_log
                            (id, idempotency_key, candidate_id, application_id, status)
                           VALUES ($1, $2, $3, $4, $5)
                           ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = NOW()`;
                    await query(logSQL, [
                        generateUUID(),
                        idempotencyKey,
                        candidateId,
                        applicationId,
                        responseStatus
                    ]);
                } catch (logErr) {
                    logger.warn(`Failed to log idempotency key: ${logErr.message}`);
                }
            }

            // ΓöÇΓöÇ Step 9: Recruiter alert + duplicate check (async) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
            setImmediate(async () => {
                try {
                    // Fetch the candidate record for alert context
                    const candRow = await query(
                        isMySQL
                            ? 'SELECT id, name, phone FROM candidates WHERE id = ? LIMIT 1'
                            : 'SELECT id, name, phone FROM candidates WHERE id = $1 LIMIT 1',
                        [candidateId]
                    ).then(r => r.rows[0]).catch(() => null);

                    // Find job title for alert context
                    let jobTitle = job_interest;
                    if (resolvedJobId) {
                        const jr = await query(
                            isMySQL ? 'SELECT title FROM jobs WHERE id = ? LIMIT 1'
                                : 'SELECT title FROM jobs WHERE id = $1 LIMIT 1',
                            [resolvedJobId]
                        ).catch(() => ({ rows: [] }));
                        if (jr.rows.length > 0) jobTitle = jr.rows[0].title;
                    }

                    // Notify recruiters of new candidate
                    await recruiterAlert('new_candidate', {
                        candidate: candRow,
                        jobTitle,
                        matchScore: null,
                        adRef: ad_ref || null
                    }, resolvedJobId);

                    // Auto-check for duplicates on newly created candidates
                    if (responseStatus === 'created') {
                        const dup = await checkForDuplicate(candidateId, 0.6);
                        if (dup) {
                            logger.warn(`Chatbot intake: potential duplicate detected for ${candidateId} ΓÇö confidence ${dup.confidence}`);
                            await recruiterAlert('new_candidate', {
                                candidate: candRow,
                                jobTitle,
                                _duplicate_warning: `Possible duplicate of candidate ${dup.candidate.name} (${dup.candidate.phone}) ΓÇö confidence ${Math.round(dup.confidence * 100)}%`,
                                matchScore: null,
                                adRef: ad_ref || null
                            }, resolvedJobId);
                        }
                    }
                } catch (alertErr) {
                    logger.warn(`Chatbot intake: recruiter alert failed ΓÇö ${alertErr.message}`);
                }
            });
            // ΓöÇΓöÇ Response ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
            const httpStatus = responseStatus === 'created' ? 201 : 200;
            return res.status(httpStatus).json({
                status: responseStatus,
                candidate_id: candidateId,
                application_id: applicationId,
                cv_file_id: cvFileId,
                additional_document_ids: additionalDocumentIds,
                message: responseStatus === 'created'
                    ? 'Candidate created successfully'
                    : 'Candidate updated successfully'
            });

        } catch (error) {
            logger.error('Chatbot intake error:', error);

            // Handle duplicate phone (race condition)
            if (
                error.code === 'ER_DUP_ENTRY' ||
                (error.message && error.message.toLowerCase().includes('duplicate'))
            ) {
                return res.status(409).json({
                    error: 'Duplicate candidate',
                    detail: 'A candidate with this phone number already exists'
                });
            }

            return res.status(500).json({
                error: 'Internal server error',
                detail: process.env.NODE_ENV === 'development' ? error.message : undefined
            });
        }
    }
);

// ΓöÇΓöÇ POST /api/chatbot/sync-message ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
// Receives a single chat message (inbound from candidate, or outbound bot reply)
// from the Python chatbot in real time and stores it in the communications table.
// Also emits a WebSocket event so live agents see the message immediately.
//
// Body: { phone, direction, content, message_type?, language?, chatbot_state? }
// Auth: x-chatbot-api-key header
router.post('/sync-message', chatbotLimiter, authenticateChatbot, async (req, res) => {
    const { phone, direction, content, message_type = 'text', language = 'en', chatbot_state = '' } = req.body;

    if (!phone || !direction || !content) {
        return res.status(400).json({ error: 'phone, direction, and content are required' });
    }
    if (!['inbound', 'outbound'].includes(direction)) {
        return res.status(400).json({ error: 'direction must be "inbound" or "outbound"' });
    }

    const normalizedPhone = phone.replace(/[\s\-()]/g, '');

    try {
        // Look up candidate by phone ΓÇö needed for candidate_id FK
        const candResult = await query(
            isMySQL
                ? 'SELECT id, name FROM candidates WHERE phone = ? OR whatsapp_phone = ? LIMIT 1'
                : 'SELECT id, name FROM candidates WHERE phone = $1 OR whatsapp_phone = $2 LIMIT 1',
            [normalizedPhone, normalizedPhone]
        );

        let candidateId = null;
        let candidateName = null;
        if (candResult.rows.length > 0) {
            candidateId = candResult.rows[0].id;
            candidateName = candResult.rows[0].name;
        }

        // Insert into communications
        const commId = generateUUID();
        const senderType = direction === 'inbound' ? 'candidate' : 'bot';

        const insertSQL = isMySQL
            ? `INSERT INTO communications
               (id, candidate_id, channel, direction, message_type, content,
                sender_type, chatbot_state, detected_language, sent_at)
               VALUES (?, ?, 'whatsapp', ?, ?, ?, ?, ?, ?, NOW())`
            : `INSERT INTO communications
               (id, candidate_id, channel, direction, message_type, content,
                sender_type, chatbot_state, detected_language)
               VALUES ($1, $2, 'whatsapp', $3, $4, $5, $6, $7, $8)`;

        await query(insertSQL, [
            commId,
            candidateId,
            direction,
            message_type,
            content.slice(0, 4000),
            senderType,
            chatbot_state || null,
            language || null,
        ]);

        // Emit WebSocket event to agents watching this candidate
        try {
            const { getIO } = require('../utils/websocket');
            const io = getIO();
            if (io && candidateId) {
                io.to(`candidate:${candidateId}`).emit('new_message', {
                    id: commId,
                    candidate_id: candidateId,
                    candidate_name: candidateName,
                    channel: 'whatsapp',
                    direction,
                    message_type,
                    content: content.slice(0, 4000),
                    sender_type: senderType,
                    chatbot_state: chatbot_state || null,
                    detected_language: language || null,
                    sent_at: new Date().toISOString(),
                });
                // Also notify the global chat list that this candidate has new activity
                io.emit('chat_activity', {
                    candidate_id: candidateId,
                    candidate_name: candidateName,
                    phone: normalizedPhone,
                    last_message: content.slice(0, 80),
                    direction,
                    chatbot_state: chatbot_state || null,
                    ts: new Date().toISOString(),
                });
            }
        } catch (wsErr) {
            // WebSocket emit failure is non-critical
            logger.debug(`sync-message: WebSocket emit skipped ΓÇö ${wsErr.message}`);
        }

        return res.status(201).json({ id: commId, candidate_id: candidateId });
    } catch (error) {
        logger.error('sync-message error:', error.message);
        return res.status(500).json({ error: 'Failed to store message', detail: error.message });
    }
});

module.exports = router;
~~~

Current code:
~~~
/**
 * Chatbot Intake Route
 * ====================
 * Secure endpoint that receives fully collected candidate data
 * from the WhatsApp Python chatbot and creates/updates the
 * candidate record in the recruitment system.
 *
 * Auth: x-chatbot-api-key header (shared secret, NOT JWT)
 *
 * POST /api/chatbot/intake
 */

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { query, generateUUID } = require('../config/database');
const { saveCVFile } = require('../utils/gcs-upload');
const { isMySQL } = require('../utils/query-adapter');
const rateLimit = require('express-rate-limit');
const logger = require('../utils/logger');
const { recruiterAlert } = require('../services/recruiter-alerts');
const { checkForDuplicate } = require('../services/duplicate-detection');
const multer = require('multer');
const { normalizeIncomingCvUrl } = require('../utils/cv-url');

// Multer for multipart/form-data CV uploads (max 20MB)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 },
});

// â”€â”€ Strict rate limit for this endpoint â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const chatbotLimiter = rateLimit({
    windowMs: 60 * 1000,   // 1 minute window
    max: 60,               // max 60 calls per minute (1 per second avg)
    message: { error: 'Too many requests from chatbot, slow down.' },
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false }, // trust proxy is set at app level
});

// â”€â”€ API Key Authentication middleware (supports dual-key rotation) â”€â”€â”€â”€â”€â”€â”€â”€
function authenticateChatbot(req, res, next) {
    const apiKey = req.headers['x-chatbot-api-key'];
    const expectedKey = process.env.CHATBOT_API_KEY;
    const expectedOldKey = process.env.CHATBOT_API_KEY_OLD;

    if (!expectedKey) {
        logger.error('CHATBOT_API_KEY not set in environment!');
        return res.status(500).json({ error: 'Server misconfiguration: chatbot key not set' });
    }

    if (!apiKey) {
        logger.warn(`Chatbot intake: rejected request with no key from ${req.ip}`);
        return res.status(401).json({ error: 'Unauthorized: missing chatbot API key' });
    }

    // Accept current key
    if (apiKey === expectedKey) {
        return next();
    }

    // Accept old key during rotation window
    if (expectedOldKey && apiKey === expectedOldKey) {
        logger.info('Chatbot intake: authenticated with OLD API key â€” rotation in progress');
        return next();
    }

    logger.warn(`Chatbot intake: rejected request with invalid key from ${req.ip}`);
    return res.status(401).json({ error: 'Unauthorized: invalid chatbot API key' });
}

// â”€â”€ GET /api/chatbot/jobs â€” Active jobs for chatbot job cache bootstrap â”€â”€â”€â”€â”€â”€â”€
router.get('/jobs', authenticateChatbot, async (req, res) => {
    try {
        const jobsSQL = isMySQL
            ? `SELECT j.id, j.title, j.category, j.status, j.salary_range,
                      j.requirements, j.positions_available,
                      p.id as project_id, p.countries, p.benefits, p.interview_date
               FROM jobs j
               LEFT JOIN projects p ON j.project_id = p.id
               WHERE j.status = 'active'
               ORDER BY j.created_at DESC`
            : `SELECT j.id, j.title, j.category, j.status, j.salary_range,
                      j.requirements, j.positions_available,
                      p.id as project_id, p.countries, p.benefits, p.interview_date
               FROM jobs j
               LEFT JOIN projects p ON j.project_id = p.id
               WHERE j.status = 'active'
               ORDER BY j.created_at DESC`;

        const result = await query(jobsSQL, []);
        const jobs = result.rows.map(job => {
            let requirements = {};
            if (job.requirements) {
                try {
                    requirements = typeof job.requirements === 'string'
                        ? JSON.parse(job.requirements)
                        : job.requirements;
                } catch (e) { /* ignore parse error */ }
            }
            return {
                job_id: job.id,
                title: job.title,
                category: job.category,
                status: job.status,
                salary_range: job.salary_range,
                positions_available: job.positions_available,
                project_id: job.project_id,
                requirements,
            };
        });

        logger.info(`Chatbot jobs fetch: returned ${jobs.length} active jobs`);
        return res.json({ jobs });
    } catch (error) {
        logger.error('Chatbot jobs fetch error:', error);
        return res.status(500).json({ error: 'Failed to fetch jobs', detail: error.message });
    }
});

// â”€â”€ Payload Validation middleware â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function validateIntakePayload(req, res, next) {
    const { phone, name, job_interest } = req.body;
    const errors = [];

    // phone: required, E.164-compatible
    if (!phone || typeof phone !== 'string') {
        errors.push('phone is required');
    } else {
        const normalizedPhone = phone.replace(/[\s\-]/g, '');
        if (!/^\+?[0-9]{7,15}$/.test(normalizedPhone)) {
            errors.push(`phone format invalid: "${phone}" â€” expected E.164 e.g. +94771234567`);
        }
    }

    // name: required, min 2 chars
    if (!name || typeof name !== 'string' || name.trim().length < 2) {
        errors.push('name is required (min 2 characters)');
    }

    // job_interest: required
    if (!job_interest || typeof job_interest !== 'string' || job_interest.trim().length < 2) {
        errors.push('job_interest is required (which role the candidate applied for)');
    }

    // email: optional but must be valid if provided
    const { email } = req.body;
    if (email && typeof email === 'string' && email.trim().length > 0) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
            errors.push(`email format invalid: "${email}"`);
        }
    }

    // experience_years: optional but must be integer 0â€“60
    const { experience_years } = req.body;
    if (experience_years !== undefined && experience_years !== null) {
        const exp = parseInt(experience_years, 10);
        if (isNaN(exp) || exp < 0 || exp > 60) {
            errors.push('experience_years must be an integer between 0 and 60');
        }
    }

    // preferred_language: must be en/si/ta/singlish/tanglish if provided
    const { preferred_language } = req.body;
    if (preferred_language && !['en', 'si', 'ta', 'singlish', 'tanglish'].includes(preferred_language)) {
        errors.push('preferred_language must be one of: en, si, ta, singlish, tanglish');
    }

    if (errors.length > 0) {
        logger.warn('Chatbot intake validation failed:', errors);
        return res.status(400).json({
            error: 'Validation failed',
            details: errors
        });
    }

    next();
}

// â”€â”€ Normalize phone to E.164-ish format â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function normalizePhone(phone) {
    return phone.replace(/[\s\-()]/g, '');
}

function parseAdditionalDocuments(rawValue) {
    if (!rawValue) return [];
    if (Array.isArray(rawValue)) return rawValue;
    if (typeof rawValue === 'string') {
        try {
            const parsed = JSON.parse(rawValue);
            return Array.isArray(parsed) ? parsed : [];
        } catch (err) {
            logger.warn(`Chatbot intake: failed to parse additional_documents JSON â€” ${err.message}`);
            return [];
        }
    }
    return [];
}

function inferFileType(fileName) {
    const ext = String(fileName || '').toLowerCase().split('.').pop();
    if (!ext || ext === String(fileName || '').toLowerCase()) return 'document';
    if (['pdf', 'doc', 'docx', 'txt', 'rtf'].includes(ext)) return ext;
    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) return 'image';
    return ext;
}

function withDocumentCategory(parsedData, category) {
    const base = parsedData && typeof parsedData === 'object' && !Array.isArray(parsedData)
        ? parsedData
        : {};

    return {
        ...base,
        __document_category: category,
    };
}

// â”€â”€ Main Intake Handler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * POST /api/chatbot/intake
 *
 * Body:
 *   phone              string  REQUIRED
 *   name               string  REQUIRED
 *   job_interest       string  REQUIRED  (job title candidate applied for)
 *   email              string  optional
 *   preferred_language string  optional  (en|si|ta)
 *   skills             string  optional  (comma-separated)
 *   experience_years   number  optional
 *   highest_qualification string optional
 *   destination_country string optional
 *   cv_file_path       string  optional  (local path on chatbot server)
 *   cv_base64          string  optional  (base64 encoded file contents)
 *   cv_file_name       string  optional  (name of the file if base64 provided)
 *   cv_raw_text        string  optional
 *   cv_parsed_data     object  optional  (full JSON from chatbot extraction)
 *   additional_documents array optional (each: {file_name, file_url|file_path|file_base64, raw_text?, parsed_data?})
 *   job_id             string  optional  (UUID â€” known if candidate came via ad)
 *   ad_ref             string  optional  (e.g. "job_abc123" from META ad)
 *   chatbot_candidate_id number optional (chatbot's internal candidate PK)
 *
 * Response 201: { candidate_id, application_id, status: "created" }
 * Response 200: { candidate_id, application_id, status: "updated" }
 */
router.post(
    '/',
    chatbotLimiter,
    authenticateChatbot,
    upload.fields([
        { name: 'cv_file', maxCount: 1 },
        { name: 'additional_files', maxCount: 10 }
    ]),  // Accept optional multipart CV + additional documents
    // Merge multipart payload field into req.body if present
    (req, res, next) => {
        if (req.body.payload) {
            try {
                const parsed = JSON.parse(req.body.payload);
                req.body = { ...parsed };
            } catch (e) {
                return res.status(400).json({ error: 'Invalid JSON in payload field' });
            }
        }

        // Verify CV checksum if provided
        const multipartCvFile = req.files?.cv_file?.[0] || null;
        if (multipartCvFile && req.headers['x-cv-checksum']) {
            const actual = crypto.createHash('sha256').update(multipartCvFile.buffer).digest('hex');
            if (actual !== req.headers['x-cv-checksum']) {
                logger.warn(`CV checksum mismatch: expected=${req.headers['x-cv-checksum']}, actual=${actual}`);
                return res.status(400).json({ error: 'CV file checksum mismatch â€” file corrupted in transit' });
            }
            logger.debug(`CV checksum verified: ${actual.substring(0, 16)}...`);
        }

        next();
    },
    validateIntakePayload,
    async (req, res) => {
        const idempotencyKey = req.headers['x-idempotency-key'];

        // â”€â”€ Idempotency check: reject duplicate submissions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if (idempotencyKey) {
            try {
                const idempSQL = isMySQL
                    ? 'SELECT candidate_id, application_id, status FROM chatbot_intake_log WHERE idempotency_key = ? LIMIT 1'
                    : 'SELECT candidate_id, application_id, status FROM chatbot_intake_log WHERE idempotency_key = $1 LIMIT 1';
                const idempResult = await query(idempSQL, [idempotencyKey]);
                if (idempResult.rows.length > 0) {
                    const prev = idempResult.rows[0];
                    logger.info(`Chatbot intake: idempotent replay for key ${idempotencyKey.substring(0, 12)}...`);
                    return res.status(200).json({
                        status: 'already_processed',
                        candidate_id: prev.candidate_id,
                        application_id: prev.application_id,
                        message: 'This submission was already processed (idempotency key match)'
                    });
                }
            } catch (idempErr) {
                // Table might not exist yet â€” log and continue (non-blocking)
                logger.warn(`Idempotency check skipped (table may not exist): ${idempErr.message}`);
            }
        }

        const {
            phone,
            name,
            email,
            preferred_language: raw_preferred_language = 'en',
            source = 'whatsapp',
            experience_years,
            highest_qualification,
            job_interest,
            destination_country,
            cv_file_path,
            cv_base64,
            cv_file_name,
            cv_raw_text,
            cv_parsed_data,
            additional_documents,
            job_id: providedJobId,
            ad_ref,
            chatbot_candidate_id
        } = req.body;

        const multipartCvFile = req.files?.cv_file?.[0] || null;
        const multipartAdditionalFiles = Array.isArray(req.files?.additional_files)
            ? req.files.additional_files
            : [];

        const hasMultipartCV = Boolean(multipartCvFile && multipartCvFile.buffer);
        const additionalDocumentsFromPayload = parseAdditionalDocuments(additional_documents);
        const requireCvForChatbot = process.env.CHATBOT_REQUIRE_CV !== 'false';
        const hasAnyCvPayload = Boolean(cv_file_path || cv_base64 || hasMultipartCV);

        if (requireCvForChatbot && hasAnyCvPayload === false) {
            logger.warn('Chatbot intake: rejected candidate onboarding because CV payload is missing');
            return res.status(422).json({
                success: false,
                error: 'CV file is required for chatbot onboarding.',
                code: 'cv_required'
            });
        }

        // `skills` needs to be mutable so we can fall back to cv_parsed_data.technical_skills
        let skills = req.body.skills;

        // â”€â”€ Normalize language: singlishâ†’si, tanglishâ†’ta â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const LANG_NORMALISE_MAP = { singlish: 'si', tanglish: 'ta' };
        const preferred_language = LANG_NORMALISE_MAP[raw_preferred_language] || raw_preferred_language || 'en';
        const language_register = raw_preferred_language; // keep the precise register

        const normalizedPhone = normalizePhone(phone);

        try {
            // â”€â”€ Step 1: Lookup existing candidate by phone â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
            let existingCandidate = null;
            const lookupSQL = isMySQL
                ? 'SELECT id, name, status, metadata FROM candidates WHERE phone = ? OR whatsapp_phone = ? LIMIT 1'
                : 'SELECT id, name, status, metadata FROM candidates WHERE phone = $1 OR whatsapp_phone = $2 LIMIT 1';

            const lookupResult = await query(lookupSQL, [normalizedPhone, normalizedPhone]);
            existingCandidate = lookupResult.rows.length > 0 ? lookupResult.rows[0] : null;

            let existingMetadata = {};
            if (existingCandidate && existingCandidate.metadata) {
                try {
                    existingMetadata = typeof existingCandidate.metadata === 'string'
                        ? JSON.parse(existingCandidate.metadata)
                        : existingCandidate.metadata;
                } catch (e) { }
            }

            let metadataUpdates = {};
            if (cv_parsed_data) {
                if (cv_parsed_data.mismatches) metadataUpdates.mismatches = cv_parsed_data.mismatches;
                if (cv_parsed_data.age != null) metadataUpdates.age = cv_parsed_data.age;
                if (cv_parsed_data.height_cm != null) metadataUpdates.height_cm = cv_parsed_data.height_cm;
                // Store the precise language register (singlish/tanglish/si/ta/en)
                if (cv_parsed_data.language_register) {
                    metadataUpdates.language_register = cv_parsed_data.language_register;
                }
                // Store experience_years from CV parsed data in metadata for UI display
                const cvExp = cv_parsed_data.total_experience_years ?? cv_parsed_data.experience_years;
                if (cvExp != null) metadataUpdates.experience_years = cvExp;

                // Fallback: derive skills string from CV's technical_skills if top-level skills is missing
                if (!skills && cv_parsed_data.technical_skills) {
                    const ts = cv_parsed_data.technical_skills;
                    skills = Array.isArray(ts) ? ts.join(', ') : String(ts);
                }
            }
            // Also capture language_register from top-level if not already in cv_parsed_data
            if (!metadataUpdates.language_register && language_register) {
                metadataUpdates.language_register = language_register;
            }

            // Always store the candidate's stated job interest and destination in metadata
            // so recruiters can see it in the CV Manager even when no job_id is matched
            if (job_interest) {
                metadataUpdates.job_interest_stated = job_interest.trim();
            }
            if (destination_country) {
                metadataUpdates.destination_country = destination_country.trim();
            }

            // Propagate future_pool flag set by the chatbot (unmatched job role)
            if (cv_parsed_data && cv_parsed_data.future_pool) {
                metadataUpdates.future_pool = true;
                metadataUpdates.future_pool_role = cv_parsed_data.future_pool_role || job_interest || '';
            }

            const mergedMetadata = { ...existingMetadata, ...metadataUpdates };
            // Produce a valid JSON value (never the string "null")
            const metadataJson = Object.keys(mergedMetadata).length > 0
                ? JSON.stringify(mergedMetadata)
                : null;

            let candidateId;
            let responseStatus;

            if (existingCandidate) {
                // â”€â”€ Step 2a: UPDATE existing candidate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
                candidateId = existingCandidate.id;
                responseStatus = 'updated';

                const updateSQL = isMySQL
                    ? `UPDATE candidates SET
                        name                 = COALESCE(?, name),
                        email                = COALESCE(?, email),
                        preferred_language   = ?,
                        skills               = COALESCE(?, skills),
                        experience_years     = COALESCE(?, experience_years),
                        highest_qualification = COALESCE(?, highest_qualification),
                        whatsapp_phone       = ?,
                        chatbot_ref          = COALESCE(?, chatbot_ref),
                        ad_ref               = COALESCE(?, ad_ref),
                        metadata             = ?,
                        last_contact_at      = NOW(),
                        updated_at           = NOW()
                       WHERE id = ?`
                    : `UPDATE candidates SET
                        name                 = COALESCE($1, name),
                        email                = COALESCE($2, email),
                        preferred_language   = $3,
                        skills               = COALESCE($4, skills),
                        experience_years     = COALESCE($5, experience_years),
                        highest_qualification = COALESCE($6, highest_qualification),
                        whatsapp_phone       = $7,
                        chatbot_ref          = COALESCE($8, chatbot_ref),
                        ad_ref               = COALESCE($9, ad_ref),
                        metadata             = $10,
                        last_contact_at      = NOW(),
                        updated_at           = NOW()
                       WHERE id = $11`;

                await query(updateSQL, [
                    name?.trim() || null,
                    email?.trim() || null,
                    preferred_language,
                    skills || null,
                    (experience_years != null && !isNaN(parseInt(experience_years, 10))) ? parseInt(experience_years, 10) : null,
                    highest_qualification || null,
                    normalizedPhone,
                    chatbot_candidate_id ? String(chatbot_candidate_id) : null,
                    ad_ref || null,
                    metadataJson,   // unified JSON string or null â€” no double-stringify
                    candidateId
                ]);

                logger.info(`Chatbot intake: UPDATED candidate ${candidateId} (${normalizedPhone})`);
            } else {
                // â”€â”€ Step 2b: INSERT new candidate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
                responseStatus = 'created';
                candidateId = generateUUID();

                const insertSQL = isMySQL
                    ? `INSERT INTO candidates
                        (id, phone, whatsapp_phone, name, email, source, preferred_language,
                         skills, experience_years, highest_qualification,
                         chatbot_ref, ad_ref, metadata, status, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', NOW(), NOW())`
                    : `INSERT INTO candidates
                        (id, phone, whatsapp_phone, name, email, source, preferred_language,
                         skills, experience_years, highest_qualification,
                         chatbot_ref, ad_ref, metadata, status)
                       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'new')`;

                await query(insertSQL, [
                    candidateId,
                    normalizedPhone,
                    normalizedPhone,
                    name.trim(),
                    email?.trim() || null,
                    source || 'whatsapp',
                    preferred_language,
                    skills || null,
                    (experience_years != null && !isNaN(parseInt(experience_years, 10))) ? parseInt(experience_years, 10) : null,
                    highest_qualification || null,
                    chatbot_candidate_id ? String(chatbot_candidate_id) : null,
                    ad_ref || null,
                    metadataJson    // unified JSON string or null â€” no double-stringify
                ]);

                logger.info(`Chatbot intake: CREATED candidate ${candidateId} (${normalizedPhone})`);
            }

            // â”€â”€ Step 3: Create CV + additional document records â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
            let cvFileId = null;
            const additionalDocumentIds = [];

            const insertDocumentRecord = async ({
                category,
                inputFileUrl,
                inputFileName,
                inputBase64,
                inputRawText,
                inputParsedData,
                multipartFile
            }) => {
                const recordId = generateUUID();
                const normalizedIncomingUrl = normalizeIncomingCvUrl(inputFileUrl, candidateId);
                let savedFileUrl = normalizedIncomingUrl;
                let savedFileName = inputFileName || (inputFileUrl ? inputFileUrl.split('/').pop() : `${category}_${normalizedPhone}.pdf`);
                const hasPhysicalPayload = Boolean(multipartFile || inputBase64 || inputFileUrl);

                if (multipartFile?.buffer) {
                    try {
                        const uploadDir = process.env.UPLOAD_DIR || null;
                        const fileBase64 = multipartFile.buffer.toString('base64');
                        savedFileName = multipartFile.originalname || savedFileName;
                        const { url: storedUrl, name: storedName } = await saveCVFile(
                            fileBase64,
                            savedFileName,
                            candidateId,
                            uploadDir
                        );
                        if (storedUrl) {
                            savedFileUrl = storedUrl;
                            savedFileName = storedName;
                            logger.info(`Chatbot intake: ${category} (multipart) stored at ${savedFileUrl}`);
                        }
                    } catch (err) {
                        logger.error(`Chatbot intake: Failed to save multipart ${category} â€” ${err.message}`);
                    }
                } else if (inputBase64) {
                    try {
                        const uploadDir = process.env.UPLOAD_DIR || null;
                        const { url: storedUrl, name: storedName } = await saveCVFile(
                            inputBase64,
                            savedFileName,
                            candidateId,
                            uploadDir
                        );
                        if (storedUrl) {
                            savedFileUrl = storedUrl;
                            savedFileName = storedName;
                            logger.info(`Chatbot intake: ${category} stored at ${savedFileUrl}`);
                        }
                    } catch (err) {
                        logger.error(`Chatbot intake: Failed to save ${category} â€” ${err.message}`);
                    }
                }

                const hasRetrievableUrl =
                    typeof savedFileUrl === 'string' &&
                    (savedFileUrl.startsWith('http://') || savedFileUrl.startsWith('https://') || savedFileUrl.startsWith('/'));

                if (hasPhysicalPayload && !hasRetrievableUrl) {
                    throw new Error(`${category}_storage_unretrievable`);
                }

                const documentParsedData = withDocumentCategory(inputParsedData, category);
                const detectedFileType = inferFileType(savedFileName);
                const isPrimary = category === 'cv';

                const cvInsertSQL = isMySQL
                    ? `INSERT INTO cv_files
                        (id, candidate_id, file_url, file_name, file_type,
                         ocr_status, ocr_text, parsed_data, uploaded_at, is_primary)
                       VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, NOW(), ?)`
                    : `INSERT INTO cv_files
                        (id, candidate_id, file_url, file_name, file_type,
                         ocr_status, ocr_text, parsed_data, is_primary)
                       VALUES ($1, $2, $3, $4, $5, 'completed', $6, $7, $8)`;

                await query(cvInsertSQL, [
                    recordId,
                    candidateId,
                    savedFileUrl,
                    savedFileName,
                    detectedFileType,
                    inputRawText || null,
                    JSON.stringify(documentParsedData),
                    isPrimary
                ]);

                return recordId;
            };

            if (cv_file_path || cv_raw_text || cv_parsed_data || cv_base64 || hasMultipartCV) {
                try {
                    cvFileId = await insertDocumentRecord({
                        category: 'cv',
                        inputFileUrl: cv_file_path,
                        inputFileName: cv_file_name || (cv_file_path ? cv_file_path.split('/').pop() : `chatbot_cv_${normalizedPhone}.pdf`),
                        inputBase64: cv_base64,
                        inputRawText: cv_raw_text,
                        inputParsedData: cv_parsed_data,
                        multipartFile: multipartCvFile
                    });
                } catch (err) {
                    if (err.message === 'cv_storage_unretrievable') {
                        logger.error(`Chatbot intake: rejecting onboarding for ${candidateId} because CV storage URL is not retrievable`);
                        return res.status(422).json({
                            success: false,
                            error: 'CV upload received but file URL is not retrievable. Please retry upload.',
                            candidate_id: candidateId,
                            code: 'cv_storage_unretrievable'
                        });
                    }
                    throw err;
                }
            }

            const additionalDocInputs = [
                ...additionalDocumentsFromPayload,
                ...multipartAdditionalFiles.map((file) => ({
                    file_name: file.originalname,
                    multipart_file: file
                }))
            ];

            for (const doc of additionalDocInputs) {
                const docName = doc.file_name || doc.name || 'additional_document';
                const docId = await insertDocumentRecord({
                    category: 'additional',
                    inputFileUrl: doc.file_url || doc.file_path || null,
                    inputFileName: docName,
                    inputBase64: doc.file_base64 || doc.base64 || null,
                    inputRawText: doc.raw_text || null,
                    inputParsedData: doc.parsed_data || null,
                    multipartFile: doc.multipart_file || null,
                });
                additionalDocumentIds.push(docId);
            }

            // â”€â”€ Step 4: Resolve job_id from ad_ref or job lookup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
            let resolvedJobId = providedJobId || null;

            if (!resolvedJobId && ad_ref) {
                // Find job_id from ad_tracking
                const adSQL = isMySQL
                    ? 'SELECT job_id FROM ad_tracking WHERE ad_ref = ? AND is_active = 1 LIMIT 1'
                    : 'SELECT job_id FROM ad_tracking WHERE ad_ref = $1 AND is_active = TRUE LIMIT 1';
                const adResult = await query(adSQL, [ad_ref]);
                if (adResult.rows.length > 0) {
                    resolvedJobId = adResult.rows[0].job_id;
                }
            }

            if (!resolvedJobId && job_interest) {
                // Best-effort: find active job by title match
                const jobSQL = isMySQL
                    ? `SELECT id FROM jobs
                       WHERE status = 'active'
                         AND (title LIKE ? OR title LIKE ?)
                       LIMIT 1`
                    : `SELECT id FROM jobs
                       WHERE status = 'active'
                         AND (title ILIKE $1 OR title ILIKE $2)
                       LIMIT 1`;
                const searchTerm = `%${job_interest.trim()}%`;
                const wordSearch = `%${job_interest.trim().split(' ')[0]}%`;
                const jobResult = await query(jobSQL, [searchTerm, wordSearch]);
                if (jobResult.rows.length > 0) {
                    resolvedJobId = jobResult.rows[0].id;
                    logger.info(`Chatbot intake: fuzzy-matched job "${job_interest}" â†’ ${resolvedJobId}`);
                }
            }

            // â”€â”€ Step 5: Create application record â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
            let applicationId = null;
            if (resolvedJobId) {
                // Check for duplicate application
                const dupSQL = isMySQL
                    ? 'SELECT id FROM applications WHERE candidate_id = ? AND job_id = ? LIMIT 1'
                    : 'SELECT id FROM applications WHERE candidate_id = $1 AND job_id = $2 LIMIT 1';
                const dupResult = await query(dupSQL, [candidateId, resolvedJobId]);

                if (dupResult.rows.length > 0) {
                    applicationId = dupResult.rows[0].id;
                    logger.info(`Chatbot intake: application already exists ${applicationId}`);
                } else {
                    applicationId = generateUUID();
                    const appSQL = isMySQL
                        ? `INSERT INTO applications
                            (id, candidate_id, job_id, status, applied_at,
                             metadata)
                           VALUES (?, ?, ?, 'applied', NOW(), ?)`
                        : `INSERT INTO applications
                            (id, candidate_id, job_id, status,
                             metadata)
                           VALUES ($1, $2, $3, 'applied', $4)`;

                    await query(appSQL, [
                        applicationId,
                        candidateId,
                        resolvedJobId,
                        JSON.stringify({
                            source: 'whatsapp_chatbot',
                            ad_ref: ad_ref || null,
                            destination_country: destination_country || null,
                            job_interest_stated: job_interest,
                            cv_file_id: cvFileId,
                            additional_document_ids: additionalDocumentIds
                        })
                    ]);

                    logger.info(`Chatbot intake: CREATED application ${applicationId} for candidate ${candidateId}`);
                }
            }

            // â”€â”€ Step 5b: Set future_pool status when no job matched â”€â”€â”€â”€â”€â”€â”€â”€
            // When the chatbot marks a candidate as future_pool (requested role not available),
            // update their status so recruiters can find them in the Future Pool view.
            if (!resolvedJobId && cv_parsed_data && cv_parsed_data.future_pool) {
                const futurePoolSQL = isMySQL
                    ? `UPDATE candidates SET status = 'future_pool', updated_at = NOW() WHERE id = ? AND status = 'new'`
                    : `UPDATE candidates SET status = 'future_pool', updated_at = NOW() WHERE id = $1 AND status = 'new'`;
                await query(futurePoolSQL, [candidateId]).catch(err =>
                    logger.warn(`Failed to set future_pool status for candidate ${candidateId}: ${err.message}`)
                );
                logger.info(`Chatbot intake: candidate ${candidateId} set to future_pool (requested role: "${cv_parsed_data.future_pool_role || job_interest}")`);
            }

            // â”€â”€ Step 6: Increment ad_tracking conversions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
            if (ad_ref && responseStatus === 'created') {
                const adUpdateSQL = isMySQL
                    ? 'UPDATE ad_tracking SET conversions = conversions + 1, updated_at = NOW() WHERE ad_ref = ?'
                    : 'UPDATE ad_tracking SET conversions = conversions + 1, updated_at = NOW() WHERE ad_ref = $1';
                await query(adUpdateSQL, [ad_ref]).catch(err =>
                    logger.warn(`Failed to increment conversion for ad_ref ${ad_ref}: ${err.message}`)
                );
            }

            // â”€â”€ Step 7: Log inbound communication â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
            const commId = generateUUID();
            const commSQL = isMySQL
                ? `INSERT INTO communications
                    (id, candidate_id, channel, direction, message_type, content, metadata, sent_at)
                   VALUES (?, ?, 'whatsapp', 'inbound', 'document', 'CV and application submitted via chatbot', ?, NOW())`
                : `INSERT INTO communications
                    (id, candidate_id, channel, direction, message_type, content, metadata)
                   VALUES ($1, $2, 'whatsapp', 'inbound', 'document', 'CV and application submitted via chatbot', $3)`;

            await query(commSQL, [
                commId,
                candidateId,
                JSON.stringify({
                    source: 'chatbot_intake',
                    ad_ref: ad_ref || null,
                    job_interest,
                    destination_country: destination_country || null,
                    cv_file_id: cvFileId,
                    additional_document_ids: additionalDocumentIds
                })
            ]).catch(err => logger.warn(`Failed to log communication: ${err.message}`));
            // â”€â”€ Step 8: Log idempotency key for replay protection â”€â”€â”€â”€â”€â”€â”€â”€â”€
            if (idempotencyKey) {
                try {
                    const logSQL = isMySQL
                        ? `INSERT INTO chatbot_intake_log
                            (id, idempotency_key, candidate_id, application_id, status, created_at)
                           VALUES (?, ?, ?, ?, ?, NOW())
                           ON DUPLICATE KEY UPDATE updated_at = NOW()`
                        : `INSERT INTO chatbot_intake_log
                            (id, idempotency_key, candidate_id, application_id, status)
                           VALUES ($1, $2, $3, $4, $5)
                           ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = NOW()`;
                    await query(logSQL, [
                        generateUUID(),
                        idempotencyKey,
                        candidateId,
                        applicationId,
                        responseStatus
                    ]);
                } catch (logErr) {
                    logger.warn(`Failed to log idempotency key: ${logErr.message}`);
                }
            }

            // â”€â”€ Step 9: Recruiter alert + duplicate check (async) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
            setImmediate(async () => {
                try {
                    // Fetch the candidate record for alert context
                    const candRow = await query(
                        isMySQL
                            ? 'SELECT id, name, phone FROM candidates WHERE id = ? LIMIT 1'
                            : 'SELECT id, name, phone FROM candidates WHERE id = $1 LIMIT 1',
                        [candidateId]
                    ).then(r => r.rows[0]).catch(() => null);

                    // Find job title for alert context
                    let jobTitle = job_interest;
                    if (resolvedJobId) {
                        const jr = await query(
                            isMySQL ? 'SELECT title FROM jobs WHERE id = ? LIMIT 1'
                                : 'SELECT title FROM jobs WHERE id = $1 LIMIT 1',
                            [resolvedJobId]
                        ).catch(() => ({ rows: [] }));
                        if (jr.rows.length > 0) jobTitle = jr.rows[0].title;
                    }

                    // Notify recruiters of new candidate
                    await recruiterAlert('new_candidate', {
                        candidate: candRow,
                        jobTitle,
                        matchScore: null,
                        adRef: ad_ref || null
                    }, resolvedJobId);

                    // Auto-check for duplicates on newly created candidates
                    if (responseStatus === 'created') {
                        const dup = await checkForDuplicate(candidateId, 0.6);
                        if (dup) {
                            logger.warn(`Chatbot intake: potential duplicate detected for ${candidateId} â€” confidence ${dup.confidence}`);
                            await recruiterAlert('new_candidate', {
                                candidate: candRow,
                                jobTitle,
                                _duplicate_warning: `Possible duplicate of candidate ${dup.candidate.name} (${dup.candidate.phone}) â€” confidence ${Math.round(dup.confidence * 100)}%`,
                                matchScore: null,
                                adRef: ad_ref || null
                            }, resolvedJobId);
                        }
                    }
                } catch (alertErr) {
                    logger.warn(`Chatbot intake: recruiter alert failed â€” ${alertErr.message}`);
                }
            });
            // â”€â”€ Response â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
            const httpStatus = responseStatus === 'created' ? 201 : 200;
            return res.status(httpStatus).json({
                status: responseStatus,
                candidate_id: candidateId,
                application_id: applicationId,
                cv_file_id: cvFileId,
                additional_document_ids: additionalDocumentIds,
                message: responseStatus === 'created'
                    ? 'Candidate created successfully'
                    : 'Candidate updated successfully'
            });

        } catch (error) {
            logger.error('Chatbot intake error:', error);

            // Handle duplicate phone (race condition)
            if (
                error.code === 'ER_DUP_ENTRY' ||
                (error.message && error.message.toLowerCase().includes('duplicate'))
            ) {
                return res.status(409).json({
                    error: 'Duplicate candidate',
                    detail: 'A candidate with this phone number already exists'
                });
            }

            return res.status(500).json({
                error: 'Internal server error',
                detail: process.env.NODE_ENV === 'development' ? error.message : undefined
            });
        }
    }
);

// â”€â”€ POST /api/chatbot/sync-message â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Receives a single chat message (inbound from candidate, or outbound bot reply)
// from the Python chatbot in real time and stores it in the communications table.
// Also emits a WebSocket event so live agents see the message immediately.
//
// Body: { phone, direction, content, message_type?, language?, chatbot_state? }
// Auth: x-chatbot-api-key header
router.post('/sync-message', chatbotLimiter, authenticateChatbot, async (req, res) => {
    const { phone, direction, content, message_type = 'text', language = 'en', chatbot_state = '' } = req.body;

    if (!phone || !direction || !content) {
        return res.status(400).json({ error: 'phone, direction, and content are required' });
    }
    if (!['inbound', 'outbound'].includes(direction)) {
        return res.status(400).json({ error: 'direction must be "inbound" or "outbound"' });
    }

    const normalizedPhone = phone.replace(/[\s\-()]/g, '');

    try {
        // Look up candidate by phone â€” needed for candidate_id FK
        const candResult = await query(
            isMySQL
                ? 'SELECT id, name FROM candidates WHERE phone = ? OR whatsapp_phone = ? LIMIT 1'
                : 'SELECT id, name FROM candidates WHERE phone = $1 OR whatsapp_phone = $2 LIMIT 1',
            [normalizedPhone, normalizedPhone]
        );

        let candidateId = null;
        let candidateName = null;
        if (candResult.rows.length > 0) {
            candidateId = candResult.rows[0].id;
            candidateName = candResult.rows[0].name;
        }

        // Insert into communications (schema-compatible minimal column set).
        const commId = generateUUID();
        const senderType = direction === 'inbound' ? 'candidate' : 'bot';

        const insertSQL = isMySQL
            ? `INSERT INTO communications
               (id, candidate_id, channel, direction, message_type, content, sent_at)
               VALUES (?, ?, 'whatsapp', ?, ?, ?, NOW())`
            : `INSERT INTO communications
               (id, candidate_id, channel, direction, message_type, content)
               VALUES ($1, $2, 'whatsapp', $3, $4, $5)`;

        await query(insertSQL, [
            commId,
            candidateId,
            direction,
            message_type,
            content.slice(0, 4000),
        ]);

        // Emit WebSocket event to agents watching this candidate
        try {
            const { getIO } = require('../utils/websocket');
            const io = getIO();
            if (io && candidateId) {
                io.to(`candidate:${candidateId}`).emit('new_message', {
                    id: commId,
                    candidate_id: candidateId,
                    candidate_name: candidateName,
                    channel: 'whatsapp',
                    direction,
                    message_type,
                    content: content.slice(0, 4000),
                    sender_type: senderType,
                    chatbot_state: chatbot_state || null,
                    detected_language: language || null,
                    sent_at: new Date().toISOString(),
                });
                // Also notify the global chat list that this candidate has new activity
                io.emit('chat_activity', {
                    candidate_id: candidateId,
                    candidate_name: candidateName,
                    phone: normalizedPhone,
                    last_message: content.slice(0, 80),
                    direction,
                    chatbot_state: chatbot_state || null,
                    ts: new Date().toISOString(),
                });
            }
        } catch (wsErr) {
            // WebSocket emit failure is non-critical
            logger.debug(`sync-message: WebSocket emit skipped â€” ${wsErr.message}`);
        }

        return res.status(201).json({ id: commId, candidate_id: candidateId });
    } catch (error) {
        logger.error('sync-message error:', error.message);
        return res.status(500).json({ error: 'Failed to store message', detail: error.message });
    }
});

module.exports = router;

~~~

## recruitment-system/backend/src/routes/communications.js

Previous code:
~~~
/**
 * Communications Route
 * ====================
 * Full chat transcript, agent send, and live handoff/release endpoints.
 *
 * Routes:
 *   GET  /api/communications/candidate/:id              ΓÇö full transcript
 *   GET  /api/communications/candidate/:id/notificationsΓÇö outbound notifications
 *   GET  /api/communications/active-chats               ΓÇö list of active whatsapp convos
 *   POST /api/communications/send                       ΓÇö agent sends a message
 *   POST /api/communications/candidate/:id/takeover     ΓÇö agent takes over from bot
 *   POST /api/communications/candidate/:id/release      ΓÇö release back to bot
 *   POST /api/communications/send-bulk                  ΓÇö bulk notification
 */

const express = require('express');
const router = express.Router();
const { query, generateUUID } = require('../config/database');
const { adaptQuery } = require('../utils/query-adapter');
const { isMySQL } = require('../utils/query-adapter');
const { authenticate } = require('../middleware/auth');
const logger = require('../utils/logger');

// ΓöÇΓöÇ GET /api/communications/candidate/:id ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
// Returns full chronological transcript for this candidate.
router.get('/candidate/:candidate_id', authenticate, async (req, res, next) => {
    try {
        const { candidate_id } = req.params;
        const { channel, limit = 200 } = req.query;

        const params = [candidate_id];
        let sql = adaptQuery(
            `SELECT c.*, u.name AS agent_name
             FROM communications c
             LEFT JOIN users u ON u.id = c.sent_by
             WHERE c.candidate_id = $1`
        );

        if (channel) {
            params.push(channel);
            sql += adaptQuery(` AND c.channel = $${params.length}`);
        }

        sql += ` ORDER BY c.sent_at ASC LIMIT ${parseInt(limit, 10)}`;

        const result = await query(sql, params);
        res.json(result.rows);
    } catch (error) {
        next(error);
    }
});

// ΓöÇΓöÇ GET /api/communications/candidate/:id/notifications ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
router.get('/candidate/:candidate_id/notifications', authenticate, async (req, res, next) => {
    try {
        const { candidate_id } = req.params;
        const result = await query(
            adaptQuery(`
                SELECT *,
                    metadata->>'notification_type' AS notification_type
                FROM communications
                WHERE candidate_id = $1
                  AND direction = 'outbound'
                ORDER BY sent_at DESC
                LIMIT 50
            `),
            [candidate_id]
        );
        res.json(result.rows);
    } catch (error) {
        next(error);
    }
});

// ΓöÇΓöÇ GET /api/communications/active-chats ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
// Returns one row per candidate who has a WhatsApp conversation,
// sorted by most recent message. Used to populate the chat list panel.
router.get('/active-chats', authenticate, async (req, res, next) => {
    try {
        const { search = '', limit = 100 } = req.query;
        const params = [];
        let whereClause = '';

        if (search) {
            params.push(`%${search}%`);
            whereClause = adaptQuery(`WHERE (ca.name ILIKE $1 OR ca.phone ILIKE $1 OR ca.whatsapp_phone ILIKE $1)`);
        }

        const sql = adaptQuery(`
            SELECT
                ca.id            AS candidate_id,
                ca.name,
                ca.phone,
                ca.whatsapp_phone,
                ca.status        AS candidate_status,
                ca.is_human_handoff,
                ca.agent_id,
                u.name           AS agent_name,
                lm.content       AS last_message,
                lm.direction     AS last_direction,
                lm.sender_type   AS last_sender_type,
                lm.detected_language AS last_language,
                lm.chatbot_state AS last_chatbot_state,
                lm.sent_at       AS last_message_at
            FROM candidates ca
            INNER JOIN (
                SELECT DISTINCT ON (candidate_id)
                    candidate_id, content, direction, sender_type,
                    detected_language, chatbot_state, sent_at
                FROM communications
                WHERE channel = 'whatsapp'
                ORDER BY candidate_id, sent_at DESC
            ) lm ON lm.candidate_id = ca.id
            LEFT JOIN users u ON u.id = ca.agent_id
            ${whereClause}
            ORDER BY lm.sent_at DESC
            LIMIT ${parseInt(limit, 10)}
        `);

        const result = await query(sql, params);
        res.json(result.rows);
    } catch (error) {
        next(error);
    }
});

// ΓöÇΓöÇ POST /api/communications/candidate/:id/takeover ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
// Mark candidate as under human control. Bot will stop responding.
router.post('/candidate/:candidate_id/takeover', authenticate, async (req, res, next) => {
    try {
        const { candidate_id } = req.params;
        const agentId = req.user.id;

        // Check candidate exists
        const candResult = await query(
            adaptQuery('SELECT id, name, is_human_handoff FROM candidates WHERE id = $1'),
            [candidate_id]
        );
        if (candResult.rows.length === 0) {
            return res.status(404).json({ error: 'Candidate not found' });
        }
        if (candResult.rows[0].is_human_handoff) {
            return res.status(409).json({ error: 'Candidate is already under human control', agent_id: candResult.rows[0].agent_id });
        }

        // Set handoff flag
        await query(
            adaptQuery(`UPDATE candidates SET is_human_handoff = TRUE, agent_id = $1,
                        handoff_at = NOW(), handoff_released_at = NULL, updated_at = NOW()
                        WHERE id = $2`),
            [agentId, candidate_id]
        );

        // Log a system message in the chat
        const commId = generateUUID();
        await query(
            adaptQuery(`INSERT INTO communications
                (id, candidate_id, channel, direction, message_type, content,
                 sender_type, sender_name, sent_at)
                VALUES ($1, $2, 'whatsapp', 'outbound', 'text',
                 $3, 'system', 'System', NOW())`),
            [commId, candidate_id,
                `≡ƒÖï Agent ${req.user.name || req.user.email} has taken over the conversation.`]
        );

        // Emit WebSocket notification
        try {
            const { getIO } = require('../utils/websocket');
            const io = getIO();
            if (io) {
                io.to(`candidate:${candidate_id}`).emit('handoff_start', {
                    candidate_id,
                    agent_id: agentId,
                    agent_name: req.user.name || req.user.email,
                    ts: new Date().toISOString(),
                });
                io.emit('chat_activity', {
                    candidate_id,
                    candidate_name: candResult.rows[0].name,
                    is_human_handoff: true,
                    ts: new Date().toISOString(),
                });
            }
        } catch (wsErr) {
            logger.debug(`takeover WS emit skipped: ${wsErr.message}`);
        }

        logger.info(`Agent ${agentId} took over candidate ${candidate_id}`);
        return res.json({ success: true, candidate_id, agent_id: agentId });
    } catch (error) {
        next(error);
    }
});

// ΓöÇΓöÇ POST /api/communications/candidate/:id/release ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
// Release candidate back to bot control.
router.post('/candidate/:candidate_id/release', authenticate, async (req, res, next) => {
    try {
        const { candidate_id } = req.params;

        await query(
            adaptQuery(`UPDATE candidates SET is_human_handoff = FALSE, agent_id = NULL,
                        handoff_released_at = NOW(), updated_at = NOW()
                        WHERE id = $1`),
            [candidate_id]
        );

        // System message in the chat
        const commId = generateUUID();
        await query(
            adaptQuery(`INSERT INTO communications
                (id, candidate_id, channel, direction, message_type, content,
                 sender_type, sender_name, sent_at)
                VALUES ($1, $2, 'whatsapp', 'outbound', 'text',
                 $3, 'system', 'System', NOW())`),
            [commId, candidate_id,
                `≡ƒñû Bot has resumed control of the conversation.`]
        );

        // Emit WebSocket notification
        try {
            const { getIO } = require('../utils/websocket');
            const io = getIO();
            if (io) {
                io.to(`candidate:${candidate_id}`).emit('handoff_end', {
                    candidate_id,
                    ts: new Date().toISOString(),
                });
                io.emit('chat_activity', {
                    candidate_id,
                    is_human_handoff: false,
                    ts: new Date().toISOString(),
                });
            }
        } catch (wsErr) {
            logger.debug(`release WS emit skipped: ${wsErr.message}`);
        }

        logger.info(`Candidate ${candidate_id} released back to bot`);
        return res.json({ success: true, candidate_id });
    } catch (error) {
        next(error);
    }
});

// ΓöÇΓöÇ POST /api/communications/send ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
// Agent manually sends a WhatsApp message to a candidate.
// If not already in handoff, automatically triggers takeover first.
router.post('/send', authenticate, async (req, res, next) => {
    try {
        const { candidate_id, channel = 'whatsapp', message } = req.body;

        if (!candidate_id || !message) {
            return res.status(400).json({ error: 'candidate_id and message are required' });
        }

        const candidateResult = await query(
            adaptQuery('SELECT * FROM candidates WHERE id = $1'),
            [candidate_id]
        );
        if (candidateResult.rows.length === 0) {
            return res.status(404).json({ error: 'Candidate not found' });
        }

        const candidate = candidateResult.rows[0];
        let sendResult = { simulated: false };

        if (channel === 'whatsapp') {
            const { sendTextMessage } = require('../services/whatsapp');
            try {
                await sendTextMessage(candidate.phone || candidate.whatsapp_phone, message);
            } catch (err) {
                logger.warn(`WhatsApp send failed (simulating): ${err.message}`);
                sendResult.simulated = true;
            }
        } else if (channel === 'sms') {
            const { sendSMS } = require('../services/sms');
            sendResult = await sendSMS(candidate.phone, message);
        } else if (channel === 'email') {
            if (candidate.email) {
                try {
                    const gmailService = require('../services/gmail');
                    const isConnected = await gmailService.isConnected();
                    if (isConnected) {
                        await gmailService.sendAutoReply(candidate.email, 'Message from Dewan Recruitment', candidate.name);
                    } else {
                        sendResult.simulated = true;
                    }
                } catch (err) {
                    sendResult.simulated = true;
                }
            } else {
                return res.status(400).json({ error: 'Candidate has no email address' });
            }
        } else {
            return res.status(400).json({ error: 'Invalid channel. Supported: whatsapp, sms, email' });
        }

        // Store the message in communications
        const commId = generateUUID();
        const agentName = req.user?.name || req.user?.email || 'Agent';
        await query(
            adaptQuery(`INSERT INTO communications
                (id, candidate_id, channel, direction, message_type, content,
                 sent_by, sender_type, sender_name)
                VALUES ($1, $2, $3, 'outbound', 'text', $4, $5, 'agent', $6)`),
            [commId, candidate_id, channel, message, req.user.id, agentName]
        );

        // Broadcast via WebSocket
        try {
            const { getIO } = require('../utils/websocket');
            const io = getIO();
            if (io) {
                const msgPayload = {
                    id: commId,
                    candidate_id,
                    channel,
                    direction: 'outbound',
                    message_type: 'text',
                    content: message,
                    sender_type: 'agent',
                    sender_name: agentName,
                    sent_at: new Date().toISOString(),
                };
                io.to(`candidate:${candidate_id}`).emit('new_message', msgPayload);
                io.emit('chat_activity', { candidate_id, last_message: message.slice(0, 80), ts: new Date().toISOString() });
            }
        } catch (wsErr) {
            logger.debug(`send WS emit skipped: ${wsErr.message}`);
        }

        return res.status(201).json({ ...{ id: commId, direction: 'outbound', content: message }, simulated: sendResult.simulated || false });
    } catch (error) {
        next(error);
    }
});

// ΓöÇΓöÇ POST /api/communications/send-bulk ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
router.post('/send-bulk', authenticate, async (req, res, next) => {
    try {
        const { candidate_ids, channel, message } = req.body;
        if (!candidate_ids || !Array.isArray(candidate_ids) || candidate_ids.length === 0) {
            return res.status(400).json({ error: 'candidate_ids array is required' });
        }
        if (!channel || !message) {
            return res.status(400).json({ error: 'Channel and message are required' });
        }

        const results = { success: [], failed: [] };
        for (const candidateId of candidate_ids) {
            try {
                const candidateResult = await query(
                    adaptQuery('SELECT * FROM candidates WHERE id = $1'),
                    [candidateId]
                );
                if (candidateResult.rows.length === 0) {
                    results.failed.push({ candidate_id: candidateId, error: 'Not found' });
                    continue;
                }
                const candidate = candidateResult.rows[0];
                if (channel === 'whatsapp' && candidate.phone) {
                    const { sendTextMessage } = require('../services/whatsapp');
                    try { await sendTextMessage(candidate.phone, message); }
                    catch (err) { logger.warn(`WA send failed: ${err.message}`); }
                } else if (channel === 'sms' && candidate.phone) {
                    const { sendSMS } = require('../services/sms');
                    await sendSMS(candidate.phone, message);
                }
                const commId = generateUUID();
                await query(
                    adaptQuery(`INSERT INTO communications
                        (id, candidate_id, channel, direction, message_type, content, sent_by, sender_type)
                        VALUES ($1, $2, $3, 'outbound', 'text', $4, $5, 'agent')`),
                    [commId, candidateId, channel, message, req.user.id]
                );
                results.success.push({ candidate_id: candidateId, name: candidate.name });
            } catch (err) {
                results.failed.push({ candidate_id: candidateId, error: err.message });
            }
        }

        return res.json({ total: candidate_ids.length, sent: results.success.length, failed: results.failed.length, results });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
~~~

Current code:
~~~
/**
 * Communications Route
 * ====================
 * Full chat transcript, agent send, and live handoff/release endpoints.
 *
 * Routes:
 *   GET  /api/communications/candidate/:id              â€” full transcript
 *   GET  /api/communications/candidate/:id/notificationsâ€” outbound notifications
 *   GET  /api/communications/active-chats               â€” list of active whatsapp convos
 *   POST /api/communications/send                       â€” agent sends a message
 *   POST /api/communications/candidate/:id/takeover     â€” agent takes over from bot
 *   POST /api/communications/candidate/:id/release      â€” release back to bot
 *   POST /api/communications/send-bulk                  â€” bulk notification
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { query, generateUUID } = require('../config/database');
const { adaptQuery } = require('../utils/query-adapter');
const { isMySQL } = require('../utils/query-adapter');
const { authenticate } = require('../middleware/auth');
const logger = require('../utils/logger');

// Avoid stale 304 responses on live chat endpoints.
router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});

async function notifyChatbotHandoff({ phone, isHandoff, agentName }) {
    if (!phone) return;

    const chatbotUrl = process.env.CHATBOT_API_URL || 'http://localhost:8000';
    const apiKey = process.env.CHATBOT_API_KEY;

    if (!apiKey) {
        logger.warn('Cannot notify chatbot handoff â€” CHATBOT_API_KEY not set');
        return;
    }

    try {
        await axios.post(
            `${chatbotUrl}/webhook/agent-handoff`,
            {
                phone,
                is_handoff: isHandoff,
                agent_name: agentName || null,
            },
            {
                headers: { 'x-chatbot-api-key': apiKey },
                timeout: 10000,
            }
        );
    } catch (err) {
        logger.warn(`Failed to notify chatbot handoff for ${phone}: ${err.message}`);
    }
}

// â”€â”€ GET /api/communications/candidate/:id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Returns full chronological transcript for this candidate.
router.get('/candidate/:candidate_id', authenticate, async (req, res, next) => {
    try {
        const { candidate_id } = req.params;
    const { channel, limit = 200, date_from, date_to, response_status } = req.query;

        const params = [candidate_id];
                let sql = adaptQuery(
                        `SELECT c.*, u.full_name AS agent_name
                         FROM communications c
                         LEFT JOIN users u ON u.id = c.sent_by
                         WHERE c.candidate_id = $1`
                );

        if (channel) {
            params.push(channel);
            sql += adaptQuery(` AND c.channel = $${params.length}`);
        }
        if (date_from) {
            params.push(date_from);
            sql += adaptQuery(` AND c.sent_at >= $${params.length}`);
        }
        if (date_to) {
            params.push(date_to);
            sql += adaptQuery(` AND c.sent_at <= $${params.length}`);
        }
        if (response_status === 'awaiting_candidate') {
            sql += ` AND c.direction = 'outbound'`;
        } else if (response_status === 'awaiting_agent') {
            sql += ` AND c.direction = 'inbound'`;
        }

        sql += ` ORDER BY c.sent_at ASC LIMIT ${parseInt(limit, 10)}`;

        const result = await query(sql, params);
        res.json(result.rows);
    } catch (error) {
        next(error);
    }
});

// â”€â”€ GET /api/communications/candidate/:id/notifications â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/candidate/:candidate_id/notifications', authenticate, async (req, res, next) => {
    try {
        const { candidate_id } = req.params;
        const result = await query(
            adaptQuery(`
                SELECT *,
                    metadata->>'notification_type' AS notification_type
                FROM communications
                WHERE candidate_id = $1
                  AND direction = 'outbound'
                ORDER BY sent_at DESC
                LIMIT 50
            `),
            [candidate_id]
        );
        res.json(result.rows);
    } catch (error) {
        next(error);
    }
});

// â”€â”€ GET /api/communications/active-chats â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Returns one row per candidate who has a WhatsApp conversation,
// sorted by most recent message. Used to populate the chat list panel.
router.get('/active-chats', authenticate, async (req, res, next) => {
    try {
        const {
            search = '',
            limit = 100,
            date_from,
            date_to,
            conversation_stage,
            response_status,
        } = req.query;

        const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 300);
        const params = [];
        const filters = [];

        if (search) {
            if (isMySQL) {
                filters.push(`(ca.name LIKE ? OR ca.full_name LIKE ? OR ca.phone LIKE ? OR ca.whatsapp_phone LIKE ?)`);
                params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
            } else {
                params.push(`%${search}%`);
                filters.push(`(ca.name ILIKE $1 OR ca.full_name ILIKE $1 OR ca.phone ILIKE $1 OR ca.whatsapp_phone ILIKE $1)`);
            }
        }

        if (conversation_stage) {
            filters.push(isMySQL ? 'ca.conversation_stage = ?' : `ca.conversation_stage = $${params.length + 1}`);
            params.push(conversation_stage);
        }

        if (date_from) {
            filters.push(isMySQL ? 'lm.sent_at >= ?' : `lm.sent_at >= $${params.length + 1}`);
            params.push(date_from);
        }

        if (date_to) {
            filters.push(isMySQL ? 'lm.sent_at <= ?' : `lm.sent_at <= $${params.length + 1}`);
            params.push(date_to);
        }

        if (response_status === 'awaiting_candidate') {
            filters.push(`lm.direction = 'outbound'`);
        } else if (response_status === 'awaiting_agent') {
            filters.push(`lm.direction = 'inbound'`);
        }

        const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

        const sql = isMySQL
            ? `
            SELECT
                ca.id            AS candidate_id,
                ca.name,
                ca.full_name,
                ca.phone,
                ca.whatsapp_phone,
                ca.status        AS candidate_status,
                ca.conversation_stage,
                ca.cv_uploaded,
                ca.cv_status,
                ca.last_interaction,
                ca.is_human_handoff,
                ca.agent_id,
                u.full_name      AS agent_name,
                lm.content       AS last_message,
                lm.direction     AS last_direction,
                lm.sent_at       AS last_message_at,
                CASE
                    WHEN ca.full_name IS NOT NULL
                        AND ca.full_name <> '' THEN ca.full_name
                    ELSE COALESCE(NULLIF(ca.whatsapp_phone, ''), ca.phone)
                END AS display_name,
                CASE
                    WHEN lm.direction = 'outbound' THEN 'awaiting_candidate'
                    ELSE 'awaiting_agent'
                END AS response_status
            FROM candidates ca
            INNER JOIN (
                SELECT c1.candidate_id, c1.content, c1.direction, c1.sent_at
                FROM communications c1
                INNER JOIN (
                    SELECT candidate_id, MAX(sent_at) AS latest_sent_at
                    FROM communications
                    WHERE channel = 'whatsapp'
                    GROUP BY candidate_id
                ) c2 ON c1.candidate_id = c2.candidate_id AND c1.sent_at = c2.latest_sent_at
                WHERE c1.channel = 'whatsapp'
            ) lm ON lm.candidate_id = ca.id
            LEFT JOIN users u ON u.id = ca.agent_id
            ${whereClause}
            ORDER BY lm.sent_at DESC
            LIMIT ${safeLimit}
            `
            : adaptQuery(`
            SELECT
                ca.id            AS candidate_id,
                ca.name,
                ca.full_name,
                ca.phone,
                ca.whatsapp_phone,
                ca.status        AS candidate_status,
                ca.conversation_stage,
                ca.cv_uploaded,
                ca.cv_status,
                ca.last_interaction,
                ca.is_human_handoff,
                ca.agent_id,
                u.full_name      AS agent_name,
                lm.content       AS last_message,
                lm.direction     AS last_direction,
                lm.sent_at       AS last_message_at,
                CASE
                    WHEN ca.full_name IS NOT NULL
                        AND ca.full_name <> '' THEN ca.full_name
                    ELSE COALESCE(NULLIF(ca.whatsapp_phone, ''), ca.phone)
                END AS display_name,
                CASE
                    WHEN lm.direction = 'outbound' THEN 'awaiting_candidate'
                    ELSE 'awaiting_agent'
                END AS response_status
            FROM candidates ca
            INNER JOIN (
                SELECT DISTINCT ON (candidate_id)
                    candidate_id, content, direction, sent_at
                FROM communications
                WHERE channel = 'whatsapp'
                ORDER BY candidate_id, sent_at DESC
            ) lm ON lm.candidate_id = ca.id
            LEFT JOIN users u ON u.id = ca.agent_id
            ${whereClause}
            ORDER BY lm.sent_at DESC
            LIMIT ${safeLimit}
        `);

        const result = await query(sql, params);
        res.json(result.rows);
    } catch (error) {
        next(error);
    }
});

// â”€â”€ POST /api/communications/candidate/:id/takeover â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Mark candidate as under human control. Bot will stop responding.
router.post('/candidate/:candidate_id/takeover', authenticate, async (req, res, next) => {
    try {
        const { candidate_id } = req.params;
        const agentId = req.user.id;

        // Check candidate exists
        const candResult = await query(
            adaptQuery('SELECT id, name, phone, whatsapp_phone, agent_id, is_human_handoff FROM candidates WHERE id = $1'),
            [candidate_id]
        );
        if (candResult.rows.length === 0) {
            return res.status(404).json({ error: 'Candidate not found' });
        }
        if (candResult.rows[0].is_human_handoff) {
            return res.status(409).json({ error: 'Candidate is already under human control', agent_id: candResult.rows[0].agent_id });
        }

        // Set handoff flag
        await query(
            adaptQuery(`UPDATE candidates SET is_human_handoff = TRUE, agent_id = $1,
                        handoff_at = NOW(), handoff_released_at = NULL,
                        last_interaction = NOW(), updated_at = NOW()
                        WHERE id = $2`),
            [agentId, candidate_id]
        );

        const handoffPhone = candResult.rows[0].whatsapp_phone || candResult.rows[0].phone;
        setImmediate(() => {
            notifyChatbotHandoff({
                phone: handoffPhone,
                isHandoff: true,
                agentName: req.user.name || req.user.email,
            });
        });

        // Log a system message in the chat
        const commId = generateUUID();
        await query(
            adaptQuery(`INSERT INTO communications
                (id, candidate_id, channel, direction, message_type, content,
                 sent_at)
                VALUES ($1, $2, 'whatsapp', 'outbound', 'text',
                 $3, NOW())`),
            [commId, candidate_id,
                `ðŸ™‹ Agent ${req.user.name || req.user.email} has taken over the conversation.`]
        );

        // Emit WebSocket notification
        try {
            const { getIO } = require('../utils/websocket');
            const io = getIO();
            if (io) {
                io.to(`candidate:${candidate_id}`).emit('handoff_start', {
                    candidate_id,
                    agent_id: agentId,
                    agent_name: req.user.name || req.user.email,
                    ts: new Date().toISOString(),
                });
                io.emit('chat_activity', {
                    candidate_id,
                    candidate_name: candResult.rows[0].name,
                    is_human_handoff: true,
                    ts: new Date().toISOString(),
                });
            }
        } catch (wsErr) {
            logger.debug(`takeover WS emit skipped: ${wsErr.message}`);
        }

        logger.info(`Agent ${agentId} took over candidate ${candidate_id}`);
        return res.json({ success: true, candidate_id, agent_id: agentId });
    } catch (error) {
        next(error);
    }
});

// â”€â”€ POST /api/communications/candidate/:id/release â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Release candidate back to bot control.
router.post('/candidate/:candidate_id/release', authenticate, async (req, res, next) => {
    try {
        const { candidate_id } = req.params;

        const candResult = await query(
            adaptQuery('SELECT id, phone, whatsapp_phone FROM candidates WHERE id = $1'),
            [candidate_id]
        );
        if (candResult.rows.length === 0) {
            return res.status(404).json({ error: 'Candidate not found' });
        }

        await query(
            adaptQuery(`UPDATE candidates SET is_human_handoff = FALSE, agent_id = NULL,
                        handoff_released_at = NOW(), last_interaction = NOW(), updated_at = NOW()
                        WHERE id = $1`),
            [candidate_id]
        );

        const handoffPhone = candResult.rows[0].whatsapp_phone || candResult.rows[0].phone;
        setImmediate(() => {
            notifyChatbotHandoff({
                phone: handoffPhone,
                isHandoff: false,
                agentName: req.user.name || req.user.email,
            });
        });

        // System message in the chat
        const commId = generateUUID();
        await query(
            adaptQuery(`INSERT INTO communications
                (id, candidate_id, channel, direction, message_type, content,
                 sent_at)
                VALUES ($1, $2, 'whatsapp', 'outbound', 'text',
                 $3, NOW())`),
            [commId, candidate_id,
                `ðŸ¤– Bot has resumed control of the conversation.`]
        );

        // Emit WebSocket notification
        try {
            const { getIO } = require('../utils/websocket');
            const io = getIO();
            if (io) {
                io.to(`candidate:${candidate_id}`).emit('handoff_end', {
                    candidate_id,
                    ts: new Date().toISOString(),
                });
                io.emit('chat_activity', {
                    candidate_id,
                    is_human_handoff: false,
                    ts: new Date().toISOString(),
                });
            }
        } catch (wsErr) {
            logger.debug(`release WS emit skipped: ${wsErr.message}`);
        }

        logger.info(`Candidate ${candidate_id} released back to bot`);
        return res.json({ success: true, candidate_id });
    } catch (error) {
        next(error);
    }
});

// â”€â”€ POST /api/communications/send â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Agent manually sends a WhatsApp message to a candidate.
// If not already in handoff, automatically triggers takeover first.
router.post('/send', authenticate, async (req, res, next) => {
    try {
        const { candidate_id, channel = 'whatsapp', message } = req.body;

        if (!candidate_id || !message) {
            return res.status(400).json({ error: 'candidate_id and message are required' });
        }

        const candidateResult = await query(
            adaptQuery('SELECT * FROM candidates WHERE id = $1'),
            [candidate_id]
        );
        if (candidateResult.rows.length === 0) {
            return res.status(404).json({ error: 'Candidate not found' });
        }

        const candidate = candidateResult.rows[0];
        let sendResult = { simulated: false };

        if (channel === 'whatsapp') {
            // Ensure bot pauses while agent is manually messaging.
            if (!candidate.is_human_handoff) {
                await query(
                    adaptQuery(`UPDATE candidates SET is_human_handoff = TRUE, agent_id = $1,
                                handoff_at = NOW(), handoff_released_at = NULL,
                                last_interaction = NOW(), updated_at = NOW()
                                WHERE id = $2`),
                    [req.user.id, candidate_id]
                );

                setImmediate(() => {
                    notifyChatbotHandoff({
                        phone: candidate.whatsapp_phone || candidate.phone,
                        isHandoff: true,
                        agentName: req.user?.name || req.user?.email,
                    });
                });
            }

            const { sendTextMessage } = require('../services/whatsapp');
            try {
                await sendTextMessage(candidate.whatsapp_phone || candidate.phone, message);
            } catch (err) {
                logger.warn(`WhatsApp send failed (simulating): ${err.message}`);
                sendResult.simulated = true;
            }
        } else if (channel === 'sms') {
            const { sendSMS } = require('../services/sms');
            sendResult = await sendSMS(candidate.phone, message);
        } else if (channel === 'email') {
            if (candidate.email) {
                try {
                    const gmailService = require('../services/gmail');
                    const isConnected = await gmailService.isConnected();
                    if (isConnected) {
                        await gmailService.sendAutoReply(candidate.email, 'Message from Dewan Recruitment', candidate.name);
                    } else {
                        sendResult.simulated = true;
                    }
                } catch (err) {
                    sendResult.simulated = true;
                }
            } else {
                return res.status(400).json({ error: 'Candidate has no email address' });
            }
        } else {
            return res.status(400).json({ error: 'Invalid channel. Supported: whatsapp, sms, email' });
        }

        // Store the message in communications
        const commId = generateUUID();
        const agentName = req.user?.name || req.user?.email || 'Agent';
        await query(
            adaptQuery(`INSERT INTO communications
                (id, candidate_id, channel, direction, message_type, content,
                 sent_by)
                VALUES ($1, $2, $3, 'outbound', 'text', $4, $5)`),
            [commId, candidate_id, channel, message, req.user.id]
        );

        await query(
            adaptQuery(`UPDATE candidates
                        SET last_interaction = NOW(),
                            conversation_stage = CASE
                                WHEN conversation_stage = 'new' THEN 'responding'
                                ELSE conversation_stage
                            END,
                            updated_at = NOW()
                        WHERE id = $1`),
            [candidate_id]
        );

        // Broadcast via WebSocket
        try {
            const { getIO } = require('../utils/websocket');
            const io = getIO();
            if (io) {
                const msgPayload = {
                    id: commId,
                    candidate_id,
                    channel,
                    direction: 'outbound',
                    message_type: 'text',
                    content: message,
                    sender_type: 'agent',
                    sender_name: agentName,
                    sent_at: new Date().toISOString(),
                };
                io.to(`candidate:${candidate_id}`).emit('new_message', msgPayload);
                io.emit('chat_activity', { candidate_id, last_message: message.slice(0, 80), ts: new Date().toISOString() });
            }
        } catch (wsErr) {
            logger.debug(`send WS emit skipped: ${wsErr.message}`);
        }

        return res.status(201).json({ ...{ id: commId, direction: 'outbound', content: message }, simulated: sendResult.simulated || false });
    } catch (error) {
        next(error);
    }
});

// â”€â”€ POST /api/communications/send-bulk â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/send-bulk', authenticate, async (req, res, next) => {
    try {
        const { candidate_ids, channel, message } = req.body;
        if (!candidate_ids || !Array.isArray(candidate_ids) || candidate_ids.length === 0) {
            return res.status(400).json({ error: 'candidate_ids array is required' });
        }
        if (!channel || !message) {
            return res.status(400).json({ error: 'Channel and message are required' });
        }

        const results = { success: [], failed: [] };
        for (const candidateId of candidate_ids) {
            try {
                const candidateResult = await query(
                    adaptQuery('SELECT * FROM candidates WHERE id = $1'),
                    [candidateId]
                );
                if (candidateResult.rows.length === 0) {
                    results.failed.push({ candidate_id: candidateId, error: 'Not found' });
                    continue;
                }
                const candidate = candidateResult.rows[0];
                if (channel === 'whatsapp' && candidate.phone) {
                    const { sendTextMessage } = require('../services/whatsapp');
                    try { await sendTextMessage(candidate.phone, message); }
                    catch (err) { logger.warn(`WA send failed: ${err.message}`); }
                } else if (channel === 'sms' && candidate.phone) {
                    const { sendSMS } = require('../services/sms');
                    await sendSMS(candidate.phone, message);
                }
                const commId = generateUUID();
                await query(
                    adaptQuery(`INSERT INTO communications
                        (id, candidate_id, channel, direction, message_type, content, sent_by)
                        VALUES ($1, $2, $3, 'outbound', 'text', $4, $5)`),
                    [commId, candidateId, channel, message, req.user.id]
                );
                results.success.push({ candidate_id: candidateId, name: candidate.name });
            } catch (err) {
                results.failed.push({ candidate_id: candidateId, error: err.message });
            }
        }

        return res.json({ total: candidate_ids.length, sent: results.success.length, failed: results.failed.length, results });
    } catch (error) {
        next(error);
    }
});

module.exports = router;

~~~

## recruitment-system/backend/src/routes/projects.js

Previous code:
~~~
const express = require('express');
const router = express.Router();
const { query, generateUUID } = require('../config/database');
const { isMySQL } = require('../utils/query-adapter');
const { authenticate, authorize } = require('../middleware/auth');

/**
 * Get all projects with filters
 */
router.get('/', authenticate, async (req, res, next) => {
    try {
        const {
            page = 1,
            limit = 20,
            status,
            country,
            industry_type,
            client_name,
            priority,
            search,
            start_date_from,
            start_date_to,
            interview_date_from,
            interview_date_to
        } = req.query;

        const offset = (page - 1) * limit;
        let whereClause = ' WHERE 1=1';
        const params = [];
        let paramCount = 1;

        if (status) {
            whereClause += isMySQL ? ' AND status = ?' : ` AND status = $${paramCount}`;
            params.push(status);
            paramCount++;
        }

        if (industry_type) {
            whereClause += isMySQL ? ' AND industry_type = ?' : ` AND industry_type = $${paramCount}`;
            params.push(industry_type);
            paramCount++;
        }

        if (priority) {
            whereClause += isMySQL ? ' AND priority = ?' : ` AND priority = $${paramCount}`;
            params.push(priority);
            paramCount++;
        }

        if (client_name) {
            whereClause += isMySQL ? ' AND client_name LIKE ?' : ` AND client_name ILIKE $${paramCount}`;
            params.push(`%${client_name}%`);
            paramCount++;
        }

        if (search) {
            whereClause += isMySQL ? ' AND (title LIKE ? OR description LIKE ?)' : ` AND (title ILIKE $${paramCount} OR description ILIKE $${paramCount + 1})`;
            params.push(`%${search}%`, `%${search}%`);
            paramCount += 2;
        }

        if (country) {
            if (isMySQL) {
                whereClause += ` AND JSON_CONTAINS(countries, '"${country}"')`;
            } else {
                whereClause += ` AND countries @> $${paramCount}::jsonb`;
                params.push(JSON.stringify([country]));
                paramCount++;
            }
        }

        if (start_date_from) {
            whereClause += isMySQL ? ' AND start_date >= ?' : ` AND start_date >= $${paramCount}`;
            params.push(start_date_from);
            paramCount++;
        }

        if (start_date_to) {
            whereClause += isMySQL ? ' AND start_date <= ?' : ` AND start_date <= $${paramCount}`;
            params.push(start_date_to);
            paramCount++;
        }

        if (interview_date_from) {
            whereClause += isMySQL ? ' AND interview_date >= ?' : ` AND interview_date >= $${paramCount}`;
            params.push(interview_date_from);
            paramCount++;
        }

        if (interview_date_to) {
            whereClause += isMySQL ? ' AND interview_date <= ?' : ` AND interview_date <= $${paramCount}`;
            params.push(interview_date_to);
            paramCount++;
        }

        // Get total count
        const countResult = await query(
            `SELECT COUNT(*) as count FROM projects${whereClause}`,
            params
        );
        const total = parseInt(countResult.rows[0].count);

        // Get paginated results
        const listQuery = isMySQL
            ? `SELECT * FROM projects${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`
            : `SELECT * FROM projects${whereClause} ORDER BY created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;

        const listResult = await query(listQuery, [...params, parseInt(limit), parseInt(offset)]);

        // Get team member count for each project
        const projectsWithCounts = await Promise.all(
            listResult.rows.map(async (project) => {
                const teamCountResult = await query(
                    isMySQL
                        ? 'SELECT COUNT(DISTINCT user_id) as count FROM project_assignments WHERE project_id = ?'
                        : 'SELECT COUNT(DISTINCT user_id) as count FROM project_assignments WHERE project_id = $1',
                    [project.id]
                );

                const jobCountResult = await query(
                    isMySQL
                        ? 'SELECT COUNT(*) as count FROM jobs WHERE project_id = ?'
                        : 'SELECT COUNT(*) as count FROM jobs WHERE project_id = $1',
                    [project.id]
                );

                return {
                    ...project,
                    team_count: parseInt(teamCountResult.rows[0].count),
                    job_count: parseInt(jobCountResult.rows[0].count)
                };
            })
        );

        res.json({
            data: projectsWithCounts,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * Get project by ID with detailed information
 */
router.get('/:id', authenticate, async (req, res, next) => {
    try {
        const { id } = req.params;

        const result = await query(
            isMySQL ? 'SELECT * FROM projects WHERE id = ?' : 'SELECT * FROM projects WHERE id = $1',
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Project not found' });
        }

        const project = result.rows[0];

        // Get team members
        const teamQuery = isMySQL
            ? `SELECT pa.*, u.full_name, u.email, u.role as user_role 
               FROM project_assignments pa 
               JOIN users u ON pa.user_id = u.id 
               WHERE pa.project_id = ? 
               ORDER BY pa.assigned_at DESC`
            : `SELECT pa.*, u.full_name, u.email, u.role as user_role 
               FROM project_assignments pa 
               JOIN users u ON pa.user_id = u.id 
               WHERE pa.project_id = $1 
               ORDER BY pa.assigned_at DESC`;

        const teamResult = await query(teamQuery, [id]);

        // Get jobs linked to this project
        const jobsQuery = isMySQL
            ? `SELECT j.*, COUNT(a.id) as candidate_count 
               FROM jobs j 
               LEFT JOIN applications a ON j.id = a.job_id 
               WHERE j.project_id = ? 
               GROUP BY j.id 
               ORDER BY j.created_at DESC`
            : `SELECT j.*, COUNT(a.id) as candidate_count 
               FROM jobs j 
               LEFT JOIN applications a ON j.id = a.job_id 
               WHERE j.project_id = $1 
               GROUP BY j.id 
               ORDER BY j.created_at DESC`;

        const jobsResult = await query(jobsQuery, [id]);

        // Get statistics
        const statsQuery = isMySQL
            ? `SELECT 
                   COUNT(DISTINCT a.id) as total_applications,
                   COUNT(DISTINCT CASE WHEN a.status = 'selected' THEN a.id END) as selected_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'rejected' THEN a.id END) as rejected_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'interview_scheduled' THEN a.id END) as interview_scheduled,
                   COUNT(DISTINCT a.candidate_id) as unique_candidates
               FROM applications a
               JOIN jobs j ON a.job_id = j.id
               WHERE j.project_id = ?`
            : `SELECT 
                   COUNT(DISTINCT a.id) as total_applications,
                   COUNT(DISTINCT CASE WHEN a.status = 'selected' THEN a.id END) as selected_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'rejected' THEN a.id END) as rejected_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'interview_scheduled' THEN a.id END) as interview_scheduled,
                   COUNT(DISTINCT a.candidate_id) as unique_candidates
               FROM applications a
               JOIN jobs j ON a.job_id = j.id
               WHERE j.project_id = $1`;

        const statsResult = await query(statsQuery, [id]);

        res.json({
            ...project,
            team: teamResult.rows,
            jobs: jobsResult.rows,
            stats: statsResult.rows[0]
        });
    } catch (error) {
        next(error);
    }
});

/**
 * Create new project
 */
router.post('/', authenticate, authorize('admin', 'supervisor'), async (req, res, next) => {
    try {
        const {
            title,
            client_name,
            industry_type,
            description,
            countries,
            status = 'planning',
            priority = 'normal',
            total_positions = 0,
            start_date,
            interview_date,
            end_date,
            benefits,
            salary_info,
            contact_info,
            requirements,
            metadata
        } = req.body;

        if (!title || !client_name || !industry_type || !countries || countries.length === 0) {
            return res.status(400).json({ error: 'Title, client name, industry type, and at least one country are required' });
        }

        const userId = req.user.id;

        if (isMySQL) {
            const id = generateUUID();
            await query(
                `INSERT INTO projects (id, title, client_name, industry_type, description, countries, status, priority, 
                 total_positions, start_date, interview_date, end_date, benefits, salary_info, contact_info, 
                 requirements, metadata, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    id, title, client_name, industry_type, description,
                    JSON.stringify(countries), status, priority, total_positions,
                    start_date, interview_date, end_date,
                    JSON.stringify(benefits || {}),
                    JSON.stringify(salary_info || {}),
                    JSON.stringify(contact_info || {}),
                    JSON.stringify(requirements || {}),
                    JSON.stringify(metadata || {}),
                    userId
                ]
            );

            // Auto-assign creator as owner
            const assignmentId = generateUUID();
            await query(
                'INSERT INTO project_assignments (id, project_id, user_id, role, assigned_by) VALUES (?, ?, ?, ?, ?)',
                [assignmentId, id, userId, 'owner', userId]
            );

            const result = await query('SELECT * FROM projects WHERE id = ?', [id]);
            res.status(201).json(result.rows[0]);
        } else {
            const result = await query(
                `INSERT INTO projects (title, client_name, industry_type, description, countries, status, priority, 
                 total_positions, start_date, interview_date, end_date, benefits, salary_info, contact_info, 
                 requirements, metadata, created_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
                 RETURNING *`,
                [
                    title, client_name, industry_type, description,
                    JSON.stringify(countries), status, priority, total_positions,
                    start_date, interview_date, end_date,
                    JSON.stringify(benefits || {}),
                    JSON.stringify(salary_info || {}),
                    JSON.stringify(contact_info || {}),
                    JSON.stringify(requirements || {}),
                    JSON.stringify(metadata || {}),
                    userId
                ]
            );

            // Auto-assign creator as owner
            await query(
                'INSERT INTO project_assignments (project_id, user_id, role, assigned_by) VALUES ($1, $2, $3, $4)',
                [result.rows[0].id, userId, 'owner', userId]
            );

            res.status(201).json(result.rows[0]);
        }
    } catch (error) {
        next(error);
    }
});

/**
 * Update project
 */
router.put('/:id', authenticate, authorize('admin', 'supervisor'), async (req, res, next) => {
    try {
        const { id } = req.params;
        const updates = req.body;

        const allowedFields = [
            'title', 'client_name', 'industry_type', 'description', 'countries',
            'status', 'priority', 'total_positions', 'filled_positions',
            'start_date', 'interview_date', 'end_date', 'benefits',
            'salary_info', 'contact_info', 'requirements', 'metadata'
        ];

        const setClause = [];
        const values = [];
        let paramCount = 1;

        Object.keys(updates).forEach(key => {
            if (allowedFields.includes(key)) {
                if (isMySQL) {
                    setClause.push(`${key} = ?`);
                } else {
                    setClause.push(`${key} = $${paramCount}`);
                    paramCount++;
                }

                // Stringify JSON fields
                if (['countries', 'benefits', 'salary_info', 'contact_info', 'requirements', 'metadata'].includes(key)) {
                    values.push(JSON.stringify(updates[key]));
                } else {
                    values.push(updates[key]);
                }
            }
        });

        if (setClause.length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }

        values.push(id);

        const updateQuery = isMySQL
            ? `UPDATE projects SET ${setClause.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
            : `UPDATE projects SET ${setClause.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${paramCount} RETURNING *`;

        const result = await query(updateQuery, values);

        if (isMySQL) {
            const selectResult = await query('SELECT * FROM projects WHERE id = ?', [id]);
            if (selectResult.rows.length === 0) {
                return res.status(404).json({ error: 'Project not found' });
            }
            res.json(selectResult.rows[0]);
        } else {
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Project not found' });
            }
            res.json(result.rows[0]);
        }
    } catch (error) {
        next(error);
    }
});

/**
 * Delete project
 */
router.delete('/:id', authenticate, authorize('admin'), async (req, res, next) => {
    try {
        const { id } = req.params;

        // Set project_id to NULL for all related jobs before deleting
        await query(
            isMySQL ? 'UPDATE jobs SET project_id = NULL WHERE project_id = ?' : 'UPDATE jobs SET project_id = NULL WHERE project_id = $1',
            [id]
        );

        const result = await query(
            isMySQL ? 'DELETE FROM projects WHERE id = ?' : 'DELETE FROM projects WHERE id = $1 RETURNING *',
            [id]
        );

        if (isMySQL) {
            res.json({ message: 'Project deleted successfully', id });
        } else {
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Project not found' });
            }
            res.json({ message: 'Project deleted successfully', project: result.rows[0] });
        }
    } catch (error) {
        next(error);
    }
});

/**
 * Get jobs for a project
 */
router.get('/:id/jobs', authenticate, async (req, res, next) => {
    try {
        const { id } = req.params;

        const jobsQuery = isMySQL
            ? `SELECT j.*, 
                   COUNT(DISTINCT a.id) as total_applications,
                   COUNT(DISTINCT CASE WHEN a.status = 'selected' THEN a.id END) as selected_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'rejected' THEN a.id END) as rejected_count
               FROM jobs j
               LEFT JOIN applications a ON j.id = a.job_id
               WHERE j.project_id = ?
               GROUP BY j.id
               ORDER BY j.created_at DESC`
            : `SELECT j.*, 
                   COUNT(DISTINCT a.id) as total_applications,
                   COUNT(DISTINCT CASE WHEN a.status = 'selected' THEN a.id END) as selected_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'rejected' THEN a.id END) as rejected_count
               FROM jobs j
               LEFT JOIN applications a ON j.id = a.job_id
               WHERE j.project_id = $1
               GROUP BY j.id
               ORDER BY j.created_at DESC`;

        const result = await query(jobsQuery, [id]);
        res.json({ data: result.rows });
    } catch (error) {
        next(error);
    }
});

/**
 * Get candidates for a project (across all jobs)
 */
router.get('/:id/candidates', authenticate, async (req, res, next) => {
    try {
        const { id } = req.params;
        const { status, job_id } = req.query;

        let candidateQuery = isMySQL
            ? `SELECT c.*, a.status as application_status, a.match_score, a.applied_at,
                   j.id as job_id, j.title as job_title
               FROM candidates c
               JOIN applications a ON c.id = a.candidate_id
               JOIN jobs j ON a.job_id = j.id
               WHERE j.project_id = ?`
            : `SELECT c.*, a.status as application_status, a.match_score, a.applied_at,
                   j.id as job_id, j.title as job_title
               FROM candidates c
               JOIN applications a ON c.id = a.candidate_id
               JOIN jobs j ON a.job_id = j.id
               WHERE j.project_id = $1`;

        const params = [id];
        let paramCount = 2;

        if (status) {
            candidateQuery += isMySQL ? ' AND a.status = ?' : ` AND a.status = $${paramCount}`;
            params.push(status);
            paramCount++;
        }

        if (job_id) {
            candidateQuery += isMySQL ? ' AND j.id = ?' : ` AND j.id = $${paramCount}`;
            params.push(job_id);
            paramCount++;
        }

        candidateQuery += ' ORDER BY a.applied_at DESC';

        const result = await query(candidateQuery, params);
        res.json({ data: result.rows });
    } catch (error) {
        next(error);
    }
});

/**
 * Assign team members to project
 */
router.post('/:id/assign-team', authenticate, authorize('admin', 'supervisor'), async (req, res, next) => {
    try {
        const { id } = req.params;
        const { user_id, role } = req.body;

        if (!user_id || !role) {
            return res.status(400).json({ error: 'User ID and role are required' });
        }

        if (!['owner', 'handler', 'agent', 'officer'].includes(role)) {
            return res.status(400).json({ error: 'Invalid role. Must be: owner, handler, agent, or officer' });
        }

        // Check if project exists
        const projectResult = await query(
            isMySQL ? 'SELECT id FROM projects WHERE id = ?' : 'SELECT id FROM projects WHERE id = $1',
            [id]
        );

        if (projectResult.rows.length === 0) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Check if user exists
        const userResult = await query(
            isMySQL ? 'SELECT id FROM users WHERE id = ?' : 'SELECT id FROM users WHERE id = $1',
            [user_id]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        if (isMySQL) {
            const assignmentId = generateUUID();
            await query(
                'INSERT INTO project_assignments (id, project_id, user_id, role, assigned_by) VALUES (?, ?, ?, ?, ?)',
                [assignmentId, id, user_id, role, req.user.id]
            );
            const result = await query('SELECT * FROM project_assignments WHERE id = ?', [assignmentId]);
            res.status(201).json(result.rows[0]);
        } else {
            const result = await query(
                'INSERT INTO project_assignments (project_id, user_id, role, assigned_by) VALUES ($1, $2, $3, $4) RETURNING *',
                [id, user_id, role, req.user.id]
            );
            res.status(201).json(result.rows[0]);
        }
    } catch (error) {
        // Handle unique constraint violation
        if (error.code === '23505' || error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'User already assigned with this role' });
        }
        next(error);
    }
});

/**
 * Remove team member from project
 */
router.delete('/:id/team/:userId', authenticate, authorize('admin', 'supervisor'), async (req, res, next) => {
    try {
        const { id, userId } = req.params;

        const result = await query(
            isMySQL
                ? 'DELETE FROM project_assignments WHERE project_id = ? AND user_id = ?'
                : 'DELETE FROM project_assignments WHERE project_id = $1 AND user_id = $2 RETURNING *',
            [id, userId]
        );

        if (isMySQL) {
            res.json({ message: 'Team member removed successfully' });
        } else {
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Team member assignment not found' });
            }
            res.json({ message: 'Team member removed successfully' });
        }
    } catch (error) {
        next(error);
    }
});

/**
 * Get project statistics
 */
router.get('/:id/stats', authenticate, async (req, res, next) => {
    try {
        const { id } = req.params;

        // Overall stats
        const statsQuery = isMySQL
            ? `SELECT 
                   COUNT(DISTINCT j.id) as total_jobs,
                   SUM(j.positions_available) as total_positions,
                   SUM(j.positions_filled) as filled_positions,
                   COUNT(DISTINCT a.id) as total_applications,
                   COUNT(DISTINCT CASE WHEN a.status = 'applied' THEN a.id END) as applied_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'screening' THEN a.id END) as screening_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'interview_scheduled' THEN a.id END) as interview_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'selected' THEN a.id END) as selected_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'rejected' THEN a.id END) as rejected_count,
                   COUNT(DISTINCT a.candidate_id) as unique_candidates
               FROM jobs j
               LEFT JOIN applications a ON j.id = a.job_id
               WHERE j.project_id = ?`
            : `SELECT 
                   COUNT(DISTINCT j.id) as total_jobs,
                   SUM(j.positions_available) as total_positions,
                   SUM(j.positions_filled) as filled_positions,
                   COUNT(DISTINCT a.id) as total_applications,
                   COUNT(DISTINCT CASE WHEN a.status = 'applied' THEN a.id END) as applied_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'screening' THEN a.id END) as screening_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'interview_scheduled' THEN a.id END) as interview_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'selected' THEN a.id END) as selected_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'rejected' THEN a.id END) as rejected_count,
                   COUNT(DISTINCT a.candidate_id) as unique_candidates
               FROM jobs j
               LEFT JOIN applications a ON j.id = a.job_id
               WHERE j.project_id = $1`;

        const statsResult = await query(statsQuery, [id]);

        res.json(statsResult.rows[0]);
    } catch (error) {
        next(error);
    }
});

/**
 * Get all jobs for a specific project
 */
router.get('/:id/jobs', authenticate, async (req, res, next) => {
    try {
        const { id } = req.params;
        const { status } = req.query;

        // Verify project exists
        const projectCheck = await query(
            isMySQL ? 'SELECT id FROM projects WHERE id = ?' : 'SELECT id FROM projects WHERE id = $1',
            [id]
        );

        if (projectCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Project not found' });
        }

        let jobsQuery;
        const params = [id];
        
        if (status) {
            jobsQuery = isMySQL
                ? `SELECT j.*, COUNT(a.id) as application_count 
                   FROM jobs j 
                   LEFT JOIN applications a ON j.id = a.job_id 
                   WHERE j.project_id = ? AND j.status = ?
                   GROUP BY j.id 
                   ORDER BY j.created_at DESC`
                : `SELECT j.*, COUNT(a.id) as application_count 
                   FROM jobs j 
                   LEFT JOIN applications a ON j.id = a.job_id 
                   WHERE j.project_id = $1 AND j.status = $2
                   GROUP BY j.id 
                   ORDER BY j.created_at DESC`;
            params.push(status);
        } else {
            jobsQuery = isMySQL
                ? `SELECT j.*, COUNT(a.id) as application_count 
                   FROM jobs j 
                   LEFT JOIN applications a ON j.id = a.job_id 
                   WHERE j.project_id = ? 
                   GROUP BY j.id 
                   ORDER BY j.created_at DESC`
                : `SELECT j.*, COUNT(a.id) as application_count 
                   FROM jobs j 
                   LEFT JOIN applications a ON j.id = a.job_id 
                   WHERE j.project_id = $1 
                   GROUP BY j.id 
                   ORDER BY j.created_at DESC`;
        }

        const result = await query(jobsQuery, params);

        res.json({ data: result.rows });
    } catch (error) {
        next(error);
    }
});

/**
 * Create a new job for a specific project
 */
router.post('/:id/jobs', authenticate, authorize('admin', 'supervisor'), async (req, res, next) => {
    try {
        const { id: project_id } = req.params;
        const {
            title,
            category,
            description,
            requirements,
            wiggle_room,
            positions_available,
            salary_range,
            location,
            deadline
        } = req.body;

        if (!title || !category || !requirements) {
            return res.status(400).json({ error: 'Title, category, and requirements are required' });
        }

        // Verify project exists
        const projectCheck = await query(
            isMySQL ? 'SELECT id, title FROM projects WHERE id = ?' : 'SELECT id, title FROM projects WHERE id = $1',
            [project_id]
        );

        if (projectCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Project not found' });
        }

        const jobId = generateUUID();
        const insertQuery = isMySQL
            ? `INSERT INTO jobs (id, title, category, description, requirements, wiggle_room, positions_available, salary_range, location, deadline, project_id, created_by, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NOW(), NOW())`
            : `INSERT INTO jobs (title, category, description, requirements, wiggle_room, positions_available, salary_range, location, deadline, project_id, created_by, status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active')
               RETURNING *`;

        const params = isMySQL
            ? [
                jobId,
                title,
                category,
                description,
                JSON.stringify(requirements),
                JSON.stringify(wiggle_room || {}),
                positions_available || 1,
                salary_range,
                location,
                deadline,
                project_id,
                req.user.id
            ]
            : [
                title,
                category,
                description,
                JSON.stringify(requirements),
                JSON.stringify(wiggle_room || {}),
                positions_available || 1,
                salary_range,
                location,
                deadline,
                project_id,
                req.user.id
            ];

        const result = await query(insertQuery, params);

        if (isMySQL) {
            const selectQuery = 'SELECT * FROM jobs WHERE id = ?';
            const selectResult = await query(selectQuery, [jobId]);
            res.status(201).json(selectResult.rows[0]);
        } else {
            res.status(201).json(result.rows[0]);
        }
    } catch (error) {
        next(error);
    }
});

/**
 * Get all candidates assigned to jobs in this project
 */
router.get('/:id/candidates', authenticate, async (req, res, next) => {
    try {
        const { id } = req.params;
        const { status } = req.query;

        // Verify project exists
        const projectCheck = await query(
            isMySQL ? 'SELECT id FROM projects WHERE id = ?' : 'SELECT id FROM projects WHERE id = $1',
            [id]
        );

        if (projectCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Project not found' });
        }

        let candidatesQuery;
        const params = [id];
        
        if (status) {
            candidatesQuery = isMySQL
                ? `SELECT DISTINCT c.*, a.status as application_status, a.applied_at,
                   j.id as job_id, j.title as job_title, j.category as job_category
                   FROM candidates c
                   JOIN applications a ON c.id = a.candidate_id
                   JOIN jobs j ON a.job_id = j.id
                   WHERE j.project_id = ? AND a.status = ?
                   ORDER BY a.applied_at DESC`
                : `SELECT DISTINCT c.*, a.status as application_status, a.applied_at,
                   j.id as job_id, j.title as job_title, j.category as job_category
                   FROM candidates c
                   JOIN applications a ON c.id = a.candidate_id
                   JOIN jobs j ON a.job_id = j.id
                   WHERE j.project_id = $1 AND a.status = $2
                   ORDER BY a.applied_at DESC`;
            params.push(status);
        } else {
            candidatesQuery = isMySQL
                ? `SELECT DISTINCT c.*, a.status as application_status, a.applied_at,
                   j.id as job_id, j.title as job_title, j.category as job_category
                   FROM candidates c
                   JOIN applications a ON c.id = a.candidate_id
                   JOIN jobs j ON a.job_id = j.id
                   WHERE j.project_id = ?
                   ORDER BY a.applied_at DESC`
                : `SELECT DISTINCT c.*, a.status as application_status, a.applied_at,
                   j.id as job_id, j.title as job_title, j.category as job_category
                   FROM candidates c
                   JOIN applications a ON c.id = a.candidate_id
                   JOIN jobs j ON a.job_id = j.id
                   WHERE j.project_id = $1
                   ORDER BY a.applied_at DESC`;
        }

        const result = await query(candidatesQuery, params);

        res.json({ data: result.rows });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
~~~

Current code:
~~~
const express = require('express');
const router = express.Router();
const { query, generateUUID } = require('../config/database');
const { isMySQL } = require('../utils/query-adapter');
const { authenticate, authorize } = require('../middleware/auth');
const { syncJobAsync } = require('./chatbot-sync');
const logger = require('../utils/logger');

async function syncProjectJobs(projectId) {
    const jobsSQL = isMySQL
        ? `SELECT id FROM jobs WHERE project_id = ? AND status = 'active'`
        : `SELECT id FROM jobs WHERE project_id = $1 AND status = 'active'`;

    const jobsResult = await query(jobsSQL, [projectId]);
    if (jobsResult.rows.length === 0) {
        return 0;
    }

    const outcomes = await Promise.allSettled(
        jobsResult.rows.map(job => syncJobAsync(job.id))
    );

    const failures = outcomes.filter(outcome => outcome.status === 'rejected').length;
    if (failures > 0) {
        logger.warn(`Project ${projectId} sync completed with ${failures} job sync failures`);
    }

    return jobsResult.rows.length;
}

/**
 * Get all projects with filters
 */
router.get('/', authenticate, async (req, res, next) => {
    try {
        const {
            page = 1,
            limit = 20,
            status,
            country,
            industry_type,
            client_name,
            priority,
            search,
            start_date_from,
            start_date_to,
            interview_date_from,
            interview_date_to
        } = req.query;

        const offset = (page - 1) * limit;
        let whereClause = ' WHERE 1=1';
        const params = [];
        let paramCount = 1;

        if (status) {
            whereClause += isMySQL ? ' AND status = ?' : ` AND status = $${paramCount}`;
            params.push(status);
            paramCount++;
        }

        if (industry_type) {
            whereClause += isMySQL ? ' AND industry_type = ?' : ` AND industry_type = $${paramCount}`;
            params.push(industry_type);
            paramCount++;
        }

        if (priority) {
            whereClause += isMySQL ? ' AND priority = ?' : ` AND priority = $${paramCount}`;
            params.push(priority);
            paramCount++;
        }

        if (client_name) {
            whereClause += isMySQL ? ' AND client_name LIKE ?' : ` AND client_name ILIKE $${paramCount}`;
            params.push(`%${client_name}%`);
            paramCount++;
        }

        if (search) {
            whereClause += isMySQL ? ' AND (title LIKE ? OR description LIKE ?)' : ` AND (title ILIKE $${paramCount} OR description ILIKE $${paramCount + 1})`;
            params.push(`%${search}%`, `%${search}%`);
            paramCount += 2;
        }

        if (country) {
            if (isMySQL) {
                whereClause += ` AND (JSON_CONTAINS(country_of_recruitment, '"${country}"') OR JSON_CONTAINS(countries, '"${country}"'))`;
            } else {
                whereClause += ` AND (country_of_recruitment @> $${paramCount}::jsonb OR countries @> $${paramCount}::jsonb)`;
                params.push(JSON.stringify([country]));
                paramCount++;
            }
        }

        if (start_date_from) {
            whereClause += isMySQL ? ' AND start_date >= ?' : ` AND start_date >= $${paramCount}`;
            params.push(start_date_from);
            paramCount++;
        }

        if (start_date_to) {
            whereClause += isMySQL ? ' AND start_date <= ?' : ` AND start_date <= $${paramCount}`;
            params.push(start_date_to);
            paramCount++;
        }

        if (interview_date_from) {
            whereClause += isMySQL ? ' AND interview_date >= ?' : ` AND interview_date >= $${paramCount}`;
            params.push(interview_date_from);
            paramCount++;
        }

        if (interview_date_to) {
            whereClause += isMySQL ? ' AND interview_date <= ?' : ` AND interview_date <= $${paramCount}`;
            params.push(interview_date_to);
            paramCount++;
        }

        // Get total count
        const countResult = await query(
            `SELECT COUNT(*) as count FROM projects${whereClause}`,
            params
        );
        const total = parseInt(countResult.rows[0].count);

        // Get paginated results
        const listQuery = isMySQL
            ? `SELECT * FROM projects${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`
            : `SELECT * FROM projects${whereClause} ORDER BY created_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;

        const listResult = await query(listQuery, [...params, parseInt(limit), parseInt(offset)]);

        // Get team member count for each project
        const projectsWithCounts = await Promise.all(
            listResult.rows.map(async (project) => {
                const teamCountResult = await query(
                    isMySQL
                        ? 'SELECT COUNT(DISTINCT user_id) as count FROM project_assignments WHERE project_id = ?'
                        : 'SELECT COUNT(DISTINCT user_id) as count FROM project_assignments WHERE project_id = $1',
                    [project.id]
                );

                const jobCountResult = await query(
                    isMySQL
                        ? 'SELECT COUNT(*) as count FROM jobs WHERE project_id = ?'
                        : 'SELECT COUNT(*) as count FROM jobs WHERE project_id = $1',
                    [project.id]
                );

                return {
                    ...project,
                    country_of_recruitment: project.country_of_recruitment || project.countries || [],
                    team_count: parseInt(teamCountResult.rows[0].count),
                    job_count: parseInt(jobCountResult.rows[0].count)
                };
            })
        );

        res.json({
            data: projectsWithCounts,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * Get project by ID with detailed information
 */
router.get('/:id', authenticate, async (req, res, next) => {
    try {
        const { id } = req.params;

        const result = await query(
            isMySQL ? 'SELECT * FROM projects WHERE id = ?' : 'SELECT * FROM projects WHERE id = $1',
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Project not found' });
        }

        const project = result.rows[0];

        // Get team members
        const teamQuery = isMySQL
            ? `SELECT pa.*, u.full_name, u.email, u.role as user_role 
               FROM project_assignments pa 
               JOIN users u ON pa.user_id = u.id 
               WHERE pa.project_id = ? 
               ORDER BY pa.assigned_at DESC`
            : `SELECT pa.*, u.full_name, u.email, u.role as user_role 
               FROM project_assignments pa 
               JOIN users u ON pa.user_id = u.id 
               WHERE pa.project_id = $1 
               ORDER BY pa.assigned_at DESC`;

        const teamResult = await query(teamQuery, [id]);

        // Get jobs linked to this project
        const jobsQuery = isMySQL
            ? `SELECT j.*, COUNT(a.id) as candidate_count 
               FROM jobs j 
               LEFT JOIN applications a ON j.id = a.job_id 
               WHERE j.project_id = ? 
               GROUP BY j.id 
               ORDER BY j.created_at DESC`
            : `SELECT j.*, COUNT(a.id) as candidate_count 
               FROM jobs j 
               LEFT JOIN applications a ON j.id = a.job_id 
               WHERE j.project_id = $1 
               GROUP BY j.id 
               ORDER BY j.created_at DESC`;

        const jobsResult = await query(jobsQuery, [id]);

        // Get statistics
        const statsQuery = isMySQL
            ? `SELECT 
                   COUNT(DISTINCT a.id) as total_applications,
                   COUNT(DISTINCT CASE WHEN a.status = 'selected' THEN a.id END) as selected_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'rejected' THEN a.id END) as rejected_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'interview_scheduled' THEN a.id END) as interview_scheduled,
                   COUNT(DISTINCT a.candidate_id) as unique_candidates
               FROM applications a
               JOIN jobs j ON a.job_id = j.id
               WHERE j.project_id = ?`
            : `SELECT 
                   COUNT(DISTINCT a.id) as total_applications,
                   COUNT(DISTINCT CASE WHEN a.status = 'selected' THEN a.id END) as selected_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'rejected' THEN a.id END) as rejected_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'interview_scheduled' THEN a.id END) as interview_scheduled,
                   COUNT(DISTINCT a.candidate_id) as unique_candidates
               FROM applications a
               JOIN jobs j ON a.job_id = j.id
               WHERE j.project_id = $1`;

        const statsResult = await query(statsQuery, [id]);

        res.json({
            ...project,
            team: teamResult.rows,
            jobs: jobsResult.rows,
            stats: statsResult.rows[0]
        });
    } catch (error) {
        next(error);
    }
});

/**
 * Create new project
 */
router.post('/', authenticate, authorize('admin', 'supervisor'), async (req, res, next) => {
    try {
        const {
            title,
            client_name,
            industry_type,
            description,
            countries,
            country_of_recruitment,
            targetCountries,
            status = 'planning',
            priority = 'normal',
            total_positions = 0,
            start_date,
            interview_date,
            end_date,
            currency,
            benefits,
            salary_info,
            contact_info,
            client_details,
            requirements,
            metadata
        } = req.body;

        const normalizedCountries = country_of_recruitment || targetCountries || countries || [];
        const effectiveCurrency = currency || salary_info?.currency || null;
        const normalizedClientDetails = {
            ...(client_details || {}),
            mobile: client_details?.mobile || contact_info?.whatsapp || null,
            email: client_details?.email || contact_info?.email || null,
            address: client_details?.address || contact_info?.address || null,
            special_details: client_details?.special_details || null,
        };

        if (!title || !client_name || !industry_type || !normalizedCountries || normalizedCountries.length === 0) {
            return res.status(400).json({ error: 'Title, client name, industry type, and at least one country are required' });
        }

        const userId = req.user.id;

        if (isMySQL) {
            const id = generateUUID();
            await query(
                `INSERT INTO projects (id, title, client_name, industry_type, description, countries, country_of_recruitment,
                 status, priority, total_positions, start_date, interview_date, end_date, currency,
                 benefits, salary_info, contact_info, client_details,
                 requirements, metadata, created_by)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    id, title, client_name, industry_type, description,
                    JSON.stringify(normalizedCountries), JSON.stringify(normalizedCountries),
                    status, priority, total_positions,
                    start_date, interview_date, end_date,
                    effectiveCurrency,
                    JSON.stringify(benefits || {}),
                    JSON.stringify(salary_info || {}),
                    JSON.stringify(contact_info || {}),
                    JSON.stringify(normalizedClientDetails),
                    JSON.stringify(requirements || {}),
                    JSON.stringify(metadata || {}),
                    userId
                ]
            );

            // Auto-assign creator as owner
            const assignmentId = generateUUID();
            await query(
                'INSERT INTO project_assignments (id, project_id, user_id, role, assigned_by) VALUES (?, ?, ?, ?, ?)',
                [assignmentId, id, userId, 'owner', userId]
            );

            const result = await query('SELECT * FROM projects WHERE id = ?', [id]);
            setImmediate(() => {
                syncProjectJobs(id).catch(error => {
                    logger.warn(`Project ${id} chatbot sync failed after create: ${error.message}`);
                });
            });
            res.status(201).json(result.rows[0]);
        } else {
            const result = await query(
                `INSERT INTO projects (title, client_name, industry_type, description, countries, country_of_recruitment,
                 status, priority, total_positions, start_date, interview_date, end_date, currency,
                 benefits, salary_info, contact_info, client_details,
                 requirements, metadata, created_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
                 RETURNING *`,
                [
                    title, client_name, industry_type, description,
                    JSON.stringify(normalizedCountries), JSON.stringify(normalizedCountries),
                    status, priority, total_positions,
                    start_date, interview_date, end_date,
                    effectiveCurrency,
                    JSON.stringify(benefits || {}),
                    JSON.stringify(salary_info || {}),
                    JSON.stringify(contact_info || {}),
                    JSON.stringify(normalizedClientDetails),
                    JSON.stringify(requirements || {}),
                    JSON.stringify(metadata || {}),
                    userId
                ]
            );

            // Auto-assign creator as owner
            await query(
                'INSERT INTO project_assignments (project_id, user_id, role, assigned_by) VALUES ($1, $2, $3, $4)',
                [result.rows[0].id, userId, 'owner', userId]
            );

            setImmediate(() => {
                syncProjectJobs(result.rows[0].id).catch(error => {
                    logger.warn(`Project ${result.rows[0].id} chatbot sync failed after create: ${error.message}`);
                });
            });
            res.status(201).json(result.rows[0]);
        }
    } catch (error) {
        next(error);
    }
});

/**
 * Update project
 */
router.put('/:id', authenticate, authorize('admin', 'supervisor'), async (req, res, next) => {
    try {
        const { id } = req.params;
        const updates = req.body;

        const allowedFields = [
            'title', 'client_name', 'industry_type', 'description', 'countries',
            'status', 'priority', 'total_positions', 'filled_positions',
            'country_of_recruitment', 'currency', 'client_details',
            'start_date', 'interview_date', 'end_date', 'benefits',
            'salary_info', 'contact_info', 'requirements', 'metadata'
        ];

        if (updates.targetCountries && !updates.country_of_recruitment) {
            updates.country_of_recruitment = updates.targetCountries;
        }

        const setClause = [];
        const values = [];
        let paramCount = 1;

        Object.keys(updates).forEach(key => {
            if (allowedFields.includes(key)) {
                if (isMySQL) {
                    setClause.push(`${key} = ?`);
                } else {
                    setClause.push(`${key} = $${paramCount}`);
                    paramCount++;
                }

                // Stringify JSON fields
                if (['countries', 'country_of_recruitment', 'benefits', 'salary_info', 'contact_info', 'client_details', 'requirements', 'metadata'].includes(key)) {
                    values.push(JSON.stringify(updates[key]));
                } else {
                    values.push(updates[key]);
                }
            }
        });

        if (setClause.length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }

        values.push(id);

        const updateQuery = isMySQL
            ? `UPDATE projects SET ${setClause.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
            : `UPDATE projects SET ${setClause.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = $${paramCount} RETURNING *`;

        const result = await query(updateQuery, values);

        if (isMySQL) {
            const selectResult = await query('SELECT * FROM projects WHERE id = ?', [id]);
            if (selectResult.rows.length === 0) {
                return res.status(404).json({ error: 'Project not found' });
            }
            setImmediate(() => {
                syncProjectJobs(id).catch(error => {
                    logger.warn(`Project ${id} chatbot sync failed after update: ${error.message}`);
                });
            });
            res.json(selectResult.rows[0]);
        } else {
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Project not found' });
            }
            setImmediate(() => {
                syncProjectJobs(id).catch(error => {
                    logger.warn(`Project ${id} chatbot sync failed after update: ${error.message}`);
                });
            });
            res.json(result.rows[0]);
        }
    } catch (error) {
        next(error);
    }
});

/**
 * Delete project
 */
router.delete('/:id', authenticate, authorize('admin'), async (req, res, next) => {
    try {
        const { id } = req.params;

        // Set project_id to NULL for all related jobs before deleting
        await query(
            isMySQL ? 'UPDATE jobs SET project_id = NULL WHERE project_id = ?' : 'UPDATE jobs SET project_id = NULL WHERE project_id = $1',
            [id]
        );

        const result = await query(
            isMySQL ? 'DELETE FROM projects WHERE id = ?' : 'DELETE FROM projects WHERE id = $1 RETURNING *',
            [id]
        );

        if (isMySQL) {
            res.json({ message: 'Project deleted successfully', id });
        } else {
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Project not found' });
            }
            res.json({ message: 'Project deleted successfully', project: result.rows[0] });
        }
    } catch (error) {
        next(error);
    }
});

/**
 * Get jobs for a project
 */
router.get('/:id/jobs', authenticate, async (req, res, next) => {
    try {
        const { id } = req.params;

        const jobsQuery = isMySQL
            ? `SELECT j.*, 
                   COUNT(DISTINCT a.id) as total_applications,
                   COUNT(DISTINCT CASE WHEN a.status = 'selected' THEN a.id END) as selected_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'rejected' THEN a.id END) as rejected_count
               FROM jobs j
               LEFT JOIN applications a ON j.id = a.job_id
               WHERE j.project_id = ?
               GROUP BY j.id
               ORDER BY j.created_at DESC`
            : `SELECT j.*, 
                   COUNT(DISTINCT a.id) as total_applications,
                   COUNT(DISTINCT CASE WHEN a.status = 'selected' THEN a.id END) as selected_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'rejected' THEN a.id END) as rejected_count
               FROM jobs j
               LEFT JOIN applications a ON j.id = a.job_id
               WHERE j.project_id = $1
               GROUP BY j.id
               ORDER BY j.created_at DESC`;

        const result = await query(jobsQuery, [id]);
        res.json({ data: result.rows });
    } catch (error) {
        next(error);
    }
});

/**
 * Get candidates for a project (across all jobs)
 */
router.get('/:id/candidates', authenticate, async (req, res, next) => {
    try {
        const { id } = req.params;
        const { status, job_id } = req.query;

        let candidateQuery = isMySQL
            ? `SELECT c.*, a.status as application_status, a.match_score, a.applied_at,
                   j.id as job_id, j.title as job_title
               FROM candidates c
               JOIN applications a ON c.id = a.candidate_id
               JOIN jobs j ON a.job_id = j.id
               WHERE j.project_id = ?`
            : `SELECT c.*, a.status as application_status, a.match_score, a.applied_at,
                   j.id as job_id, j.title as job_title
               FROM candidates c
               JOIN applications a ON c.id = a.candidate_id
               JOIN jobs j ON a.job_id = j.id
               WHERE j.project_id = $1`;

        const params = [id];
        let paramCount = 2;

        if (status) {
            candidateQuery += isMySQL ? ' AND a.status = ?' : ` AND a.status = $${paramCount}`;
            params.push(status);
            paramCount++;
        }

        if (job_id) {
            candidateQuery += isMySQL ? ' AND j.id = ?' : ` AND j.id = $${paramCount}`;
            params.push(job_id);
            paramCount++;
        }

        candidateQuery += ' ORDER BY a.applied_at DESC';

        const result = await query(candidateQuery, params);
        res.json({ data: result.rows });
    } catch (error) {
        next(error);
    }
});

/**
 * Assign team members to project
 */
router.post('/:id/assign-team', authenticate, authorize('admin', 'supervisor'), async (req, res, next) => {
    try {
        const { id } = req.params;
        const { user_id, role } = req.body;

        if (!user_id || !role) {
            return res.status(400).json({ error: 'User ID and role are required' });
        }

        if (!['owner', 'handler', 'agent', 'officer'].includes(role)) {
            return res.status(400).json({ error: 'Invalid role. Must be: owner, handler, agent, or officer' });
        }

        // Check if project exists
        const projectResult = await query(
            isMySQL ? 'SELECT id FROM projects WHERE id = ?' : 'SELECT id FROM projects WHERE id = $1',
            [id]
        );

        if (projectResult.rows.length === 0) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Check if user exists
        const userResult = await query(
            isMySQL ? 'SELECT id FROM users WHERE id = ?' : 'SELECT id FROM users WHERE id = $1',
            [user_id]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }

        if (isMySQL) {
            const assignmentId = generateUUID();
            await query(
                'INSERT INTO project_assignments (id, project_id, user_id, role, assigned_by) VALUES (?, ?, ?, ?, ?)',
                [assignmentId, id, user_id, role, req.user.id]
            );
            const result = await query('SELECT * FROM project_assignments WHERE id = ?', [assignmentId]);
            res.status(201).json(result.rows[0]);
        } else {
            const result = await query(
                'INSERT INTO project_assignments (project_id, user_id, role, assigned_by) VALUES ($1, $2, $3, $4) RETURNING *',
                [id, user_id, role, req.user.id]
            );
            res.status(201).json(result.rows[0]);
        }
    } catch (error) {
        // Handle unique constraint violation
        if (error.code === '23505' || error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({ error: 'User already assigned with this role' });
        }
        next(error);
    }
});

/**
 * Remove team member from project
 */
router.delete('/:id/team/:userId', authenticate, authorize('admin', 'supervisor'), async (req, res, next) => {
    try {
        const { id, userId } = req.params;

        const result = await query(
            isMySQL
                ? 'DELETE FROM project_assignments WHERE project_id = ? AND user_id = ?'
                : 'DELETE FROM project_assignments WHERE project_id = $1 AND user_id = $2 RETURNING *',
            [id, userId]
        );

        if (isMySQL) {
            res.json({ message: 'Team member removed successfully' });
        } else {
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Team member assignment not found' });
            }
            res.json({ message: 'Team member removed successfully' });
        }
    } catch (error) {
        next(error);
    }
});

/**
 * Get project statistics
 */
router.get('/:id/stats', authenticate, async (req, res, next) => {
    try {
        const { id } = req.params;

        // Overall stats
        const statsQuery = isMySQL
            ? `SELECT 
                   COUNT(DISTINCT j.id) as total_jobs,
                   SUM(j.positions_available) as total_positions,
                   SUM(j.positions_filled) as filled_positions,
                   COUNT(DISTINCT a.id) as total_applications,
                   COUNT(DISTINCT CASE WHEN a.status = 'applied' THEN a.id END) as applied_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'screening' THEN a.id END) as screening_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'interview_scheduled' THEN a.id END) as interview_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'selected' THEN a.id END) as selected_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'rejected' THEN a.id END) as rejected_count,
                   COUNT(DISTINCT a.candidate_id) as unique_candidates
               FROM jobs j
               LEFT JOIN applications a ON j.id = a.job_id
               WHERE j.project_id = ?`
            : `SELECT 
                   COUNT(DISTINCT j.id) as total_jobs,
                   SUM(j.positions_available) as total_positions,
                   SUM(j.positions_filled) as filled_positions,
                   COUNT(DISTINCT a.id) as total_applications,
                   COUNT(DISTINCT CASE WHEN a.status = 'applied' THEN a.id END) as applied_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'screening' THEN a.id END) as screening_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'interview_scheduled' THEN a.id END) as interview_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'selected' THEN a.id END) as selected_count,
                   COUNT(DISTINCT CASE WHEN a.status = 'rejected' THEN a.id END) as rejected_count,
                   COUNT(DISTINCT a.candidate_id) as unique_candidates
               FROM jobs j
               LEFT JOIN applications a ON j.id = a.job_id
               WHERE j.project_id = $1`;

        const statsResult = await query(statsQuery, [id]);

        res.json(statsResult.rows[0]);
    } catch (error) {
        next(error);
    }
});

/**
 * Get all jobs for a specific project
 */
router.get('/:id/jobs', authenticate, async (req, res, next) => {
    try {
        const { id } = req.params;
        const { status } = req.query;

        // Verify project exists
        const projectCheck = await query(
            isMySQL ? 'SELECT id FROM projects WHERE id = ?' : 'SELECT id FROM projects WHERE id = $1',
            [id]
        );

        if (projectCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Project not found' });
        }

        let jobsQuery;
        const params = [id];
        
        if (status) {
            jobsQuery = isMySQL
                ? `SELECT j.*, COUNT(a.id) as application_count 
                   FROM jobs j 
                   LEFT JOIN applications a ON j.id = a.job_id 
                   WHERE j.project_id = ? AND j.status = ?
                   GROUP BY j.id 
                   ORDER BY j.created_at DESC`
                : `SELECT j.*, COUNT(a.id) as application_count 
                   FROM jobs j 
                   LEFT JOIN applications a ON j.id = a.job_id 
                   WHERE j.project_id = $1 AND j.status = $2
                   GROUP BY j.id 
                   ORDER BY j.created_at DESC`;
            params.push(status);
        } else {
            jobsQuery = isMySQL
                ? `SELECT j.*, COUNT(a.id) as application_count 
                   FROM jobs j 
                   LEFT JOIN applications a ON j.id = a.job_id 
                   WHERE j.project_id = ? 
                   GROUP BY j.id 
                   ORDER BY j.created_at DESC`
                : `SELECT j.*, COUNT(a.id) as application_count 
                   FROM jobs j 
                   LEFT JOIN applications a ON j.id = a.job_id 
                   WHERE j.project_id = $1 
                   GROUP BY j.id 
                   ORDER BY j.created_at DESC`;
        }

        const result = await query(jobsQuery, params);

        res.json({ data: result.rows });
    } catch (error) {
        next(error);
    }
});

/**
 * Create a new job for a specific project
 */
router.post('/:id/jobs', authenticate, authorize('admin', 'supervisor'), async (req, res, next) => {
    try {
        const { id: project_id } = req.params;
        const {
            title,
            category,
            description,
            requirements,
            wiggle_room,
            positions_available,
            salary_range,
            location,
            deadline
        } = req.body;

        if (!title || !category || !requirements) {
            return res.status(400).json({ error: 'Title, category, and requirements are required' });
        }

        // Verify project exists
        const projectCheck = await query(
            isMySQL ? 'SELECT id, title FROM projects WHERE id = ?' : 'SELECT id, title FROM projects WHERE id = $1',
            [project_id]
        );

        if (projectCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Project not found' });
        }

        const jobId = generateUUID();
        const insertQuery = isMySQL
            ? `INSERT INTO jobs (id, title, category, description, requirements, wiggle_room, positions_available, salary_range, location, deadline, project_id, created_by, status, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NOW(), NOW())`
            : `INSERT INTO jobs (title, category, description, requirements, wiggle_room, positions_available, salary_range, location, deadline, project_id, created_by, status)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active')
               RETURNING *`;

        const params = isMySQL
            ? [
                jobId,
                title,
                category,
                description,
                JSON.stringify(requirements),
                JSON.stringify(wiggle_room || {}),
                positions_available || 1,
                salary_range,
                location,
                deadline,
                project_id,
                req.user.id
            ]
            : [
                title,
                category,
                description,
                JSON.stringify(requirements),
                JSON.stringify(wiggle_room || {}),
                positions_available || 1,
                salary_range,
                location,
                deadline,
                project_id,
                req.user.id
            ];

        const result = await query(insertQuery, params);

        if (isMySQL) {
            const selectQuery = 'SELECT * FROM jobs WHERE id = ?';
            const selectResult = await query(selectQuery, [jobId]);
            res.status(201).json(selectResult.rows[0]);
        } else {
            res.status(201).json(result.rows[0]);
        }
    } catch (error) {
        next(error);
    }
});

/**
 * Get all candidates assigned to jobs in this project
 */
router.get('/:id/candidates', authenticate, async (req, res, next) => {
    try {
        const { id } = req.params;
        const { status } = req.query;

        // Verify project exists
        const projectCheck = await query(
            isMySQL ? 'SELECT id FROM projects WHERE id = ?' : 'SELECT id FROM projects WHERE id = $1',
            [id]
        );

        if (projectCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Project not found' });
        }

        let candidatesQuery;
        const params = [id];
        
        if (status) {
            candidatesQuery = isMySQL
                ? `SELECT DISTINCT c.*, a.status as application_status, a.applied_at,
                   j.id as job_id, j.title as job_title, j.category as job_category
                   FROM candidates c
                   JOIN applications a ON c.id = a.candidate_id
                   JOIN jobs j ON a.job_id = j.id
                   WHERE j.project_id = ? AND a.status = ?
                   ORDER BY a.applied_at DESC`
                : `SELECT DISTINCT c.*, a.status as application_status, a.applied_at,
                   j.id as job_id, j.title as job_title, j.category as job_category
                   FROM candidates c
                   JOIN applications a ON c.id = a.candidate_id
                   JOIN jobs j ON a.job_id = j.id
                   WHERE j.project_id = $1 AND a.status = $2
                   ORDER BY a.applied_at DESC`;
            params.push(status);
        } else {
            candidatesQuery = isMySQL
                ? `SELECT DISTINCT c.*, a.status as application_status, a.applied_at,
                   j.id as job_id, j.title as job_title, j.category as job_category
                   FROM candidates c
                   JOIN applications a ON c.id = a.candidate_id
                   JOIN jobs j ON a.job_id = j.id
                   WHERE j.project_id = ?
                   ORDER BY a.applied_at DESC`
                : `SELECT DISTINCT c.*, a.status as application_status, a.applied_at,
                   j.id as job_id, j.title as job_title, j.category as job_category
                   FROM candidates c
                   JOIN applications a ON c.id = a.candidate_id
                   JOIN jobs j ON a.job_id = j.id
                   WHERE j.project_id = $1
                   ORDER BY a.applied_at DESC`;
        }

        const result = await query(candidatesQuery, params);

        res.json({ data: result.rows });
    } catch (error) {
        next(error);
    }
});

module.exports = router;

~~~

## recruitment-system/backend/src/routes/webhooks.js

Previous code:
~~~
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { parseResume, generateChatbotResponse, detectLanguage, extractField } = require('../config/openai');
const { sendTextMessage, downloadMedia, markMessageAsRead } = require('../services/whatsapp');
const { sendTextMessage: sendMessengerMessage, sendButtonMessage, sendTypingIndicator } = require('../services/messenger');
const { extractText } = require('../services/ocr');
const { translate } = require('../utils/translations');
const { saveCVFile } = require('../utils/localStorage');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');
const axios  = require('axios');
const { recruiterAlert } = require('../services/recruiter-alerts');
const { resolveCvAccessUrl } = require('../utils/cv-url');

// NOTE: WhatsApp messages are now proxied to the Python chatbot (CHATBOT_API_URL).
// chatbot-ai.js is kept for reference but is no longer called for WhatsApp.
// All recruitment-system integration routes (chatbot-intake, chatbot-sync, etc.) remain intact.
const { generateResponse, setMissingFields, STATES } = require('../services/chatbot-ai');
const { analyzeMessage, getGreeting } = require('../services/language-processor');

// ===============================================
// WHATSAPP WEBHOOK
// ===============================================

/**
 * WhatsApp webhook verification
 */
router.get('/whatsapp', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    const VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('WhatsApp webhook verified');
        res.status(200).send(challenge);
    } else {
        res.status(403).send('Verification failed');
    }
});

/**
 * WhatsApp webhook handler
 */
router.post('/whatsapp', async (req, res) => {
    // Acknowledge receipt immediately ΓÇö Meta requires HTTP 200 within 20 seconds.
    res.sendStatus(200);

    // ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    // Proxy to Python chatbot
    // ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    // All WhatsApp intelligence (trilingual NLP, GPT-4o RAG, full state
    // machine, CV parsing with confidence scores, ad-click detection, and
    // automatic candidate push to /api/chatbot/intake) lives in the Python bot.
    //
    // This handler is now a thin forwarding proxy: it receives the webhook
    // from Meta and forwards the raw JSON body to the Python bot's endpoint.
    // The Python bot processes the message asynchronously and sends the
    // WhatsApp reply directly to the user via the Meta API.
    //
    // Integration routes remain UNCHANGED:
    //   POST /api/chatbot/intake       ΓåÉ Python bot pushes completed candidates here
    //   GET  /api/public/job-context   ΓåÉ Python bot fetches ad job context here
    //   POST /api/chatbot-sync/job     ΓåÉ Recruitment system pushes new jobs to Python KB
    // ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    const chatbotUrl = (process.env.CHATBOT_API_URL || 'http://localhost:8000').replace(/\/$/, '');

    try {
        logger.info(`[WhatsApp] Forwarding webhook ΓåÆ ${chatbotUrl}/webhook/whatsapp`);
        await axios.post(`${chatbotUrl}/webhook/whatsapp`, req.body, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000
        });
        logger.info('[WhatsApp] Webhook forwarded to Python chatbot successfully');
    } catch (error) {
        // HTTP 200 has already been sent to Meta ΓÇö this error will NOT cause
        // Meta to retry. Log it clearly so the issue is easy to diagnose.
        logger.error(`[WhatsApp] Failed to forward to Python chatbot at ${chatbotUrl}: ${error.message}`);
        logger.error('[WhatsApp] Fix: ensure CHATBOT_API_URL is set in .env and the Python chatbot is running (pip install -r requirements.txt && python -m uvicorn app.main:app --port 8000).');
    }
});

/**
 * Handle WhatsApp text messages - ENHANCED VERSION
 * Uses advanced chatbot AI with:
 * - Trilingual support (EN/SI/TA)
 * - Sentiment analysis
 * - Knowledge base integration
 * - Slang detection
 */
async function handleWhatsAppTextMessage(message, candidate) {
    const text = message.text.body;
    const from = message.from;

    try {
        // Check if candidate has a CV
        const cvResult = await pool.query(
            'SELECT id FROM cv_files WHERE candidate_id = $1 LIMIT 1',
            [candidate.id]
        );
        const hasCV = cvResult.rows.length > 0;

        // Generate response using enhanced chatbot AI
        const response = await generateResponse({
            message: text,
            candidateId: candidate.id,
            tenantId: candidate.tenant_id || null,
            channel: 'whatsapp',
            hasCV,
            sessionData: null // Will be fetched/created by the service
        });

        // Update candidate's preferred language based on detection
        await pool.query(
            'UPDATE candidates SET preferred_language = $1, last_contact_at = NOW() WHERE id = $2',
            [response.language, candidate.id]
        );

        // Send response
        await sendTextMessage(from, response.text);

        // Log bot response
        await logCommunication({
            candidate_id: candidate.id,
            channel: 'whatsapp',
            direction: 'outbound',
            message_type: 'text',
            content: response.text,
            metadata: {
                intent: response.intent,
                sentiment: response.sentiment,
                language: response.language,
                session_state: response.sessionState,
                kb_articles_used: response.metadata?.kbArticlesUsed || []
            }
        });

        // Log any frustration/handoff requests for recruiter attention
        if (response.sessionState === STATES.HUMAN_HANDOFF) {
            logger.warn(`ΓÜá∩╕Å Human handoff requested for candidate ${candidate.phone}`);
            setImmediate(() =>
                recruiterAlert('human_handoff', {
                    candidatePhone: candidate.phone,
                    lastMessage: text
                }).catch(err => logger.warn(`Human handoff alert failed: ${err.message}`))
            );
        }

    } catch (error) {
        logger.error('Enhanced chatbot error: ' + error.message + '\n' + error.stack);

        // Fallback to basic response
        const fallbackResponse = await getGreeting('frustrated', candidate.preferred_language || 'en');
        await sendTextMessage(from, fallbackResponse);

        await logCommunication({
            candidate_id: candidate.id,
            channel: 'whatsapp',
            direction: 'outbound',
            message_type: 'text',
            content: fallbackResponse,
            metadata: { error: true, fallback: true }
        });
    }
}

/**
 * Handle WhatsApp document (CV) uploads
 */
async function handleWhatsAppDocument(message, candidate) {
    const from = message.from;
    const document = message.document;

    try {
        // Download the document
        const { data, mimeType, filename } = await downloadMedia(document.id);

        // Get file extension
        const fileExt = path.extname(filename).toLowerCase().replace('.', '') || 'pdf';

        // Save to local storage
        const fileUrl = await saveCVFile(data, candidate.id, filename, mimeType);

        // Save CV file record
        const cvFileResult = await pool.query(
            `INSERT INTO cv_files (candidate_id, file_url, file_name, file_type, ocr_status)
             VALUES ($1, $2, $3, $4, 'pending')
             RETURNING id`,
            [candidate.id, fileUrl, filename, fileExt]
        );

        const cvFileId = cvFileResult.rows[0].id;

        // Send acknowledgment
        const language = candidate.preferred_language || 'en';
        const ackMessage = translate('cv_received', language);
        await sendTextMessage(from, ackMessage);

        // Process CV asynchronously (don't wait)
        processCVFile(cvFileId, candidate.id, from).catch(err =>
            console.error('CV processing error:', err)
        );

    } catch (error) {
        console.error('Document handling error:', error);
        const language = candidate.preferred_language || 'en';
        await sendTextMessage(from, translate('error_generic', language));
    }
}

/**
 * Handle WhatsApp image uploads (also treat as potential CV)
 */
async function handleWhatsAppImage(message, candidate) {
    // Similar to document handling
    await handleWhatsAppDocument(message, candidate);
}

// ===============================================
// MESSENGER WEBHOOK
// ===============================================

/**
 * Messenger webhook verification
 */
router.get('/messenger', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    const VERIFY_TOKEN = process.env.MESSENGER_VERIFY_TOKEN;

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('Messenger webhook verified');
        res.status(200).send(challenge);
    } else {
        res.status(403).send('Verification failed');
    }
});

/**
 * Messenger webhook handler
 */
router.post('/messenger', async (req, res) => {
    // Respond immediately
    res.sendStatus(200);

    try {
        const body = req.body;

        if (body.object !== 'page') {
            return;
        }

        const entry = body.entry[0];
        const messaging = entry.messaging[0];

        if (!messaging.message) {
            return;
        }

        const senderId = messaging.sender.id;
        const messageText = messaging.message.text;

        // Show typing indicator
        await sendTypingIndicator(senderId, true);

        // Get or create candidate (use Messenger ID as phone for now)
        let candidate = await getOrCreateCandidate(`messenger_${senderId}`, 'messenger');

        // Handle the message
        await handleMessengerTextMessage(messageText, senderId, candidate);

        // Turn off typing indicator
        await sendTypingIndicator(senderId, false);

        // Log communication
        await logCommunication({
            candidate_id: candidate.id,
            channel: 'messenger',
            direction: 'inbound',
            message_type: 'text',
            content: messageText,
            metadata: { sender_id: senderId }
        });

    } catch (error) {
        console.error('Messenger webhook error:', error);
    }
});

/**
 * Handle Messenger text messages
 */
async function handleMessengerTextMessage(text, senderId, candidate) {
    // Detect language
    const language = await detectLanguage(text);

    // Update candidate's preferred language
    await pool.query(
        'UPDATE candidates SET preferred_language = $1 WHERE id = $2',
        [language, candidate.id]
    );

    // Get conversation history
    const conversationHistory = await getConversationHistory(candidate.id, 'messenger');

    // Generate system prompt
    const systemPrompt = `You are a friendly recruitment assistant for a Sri Lankan recruitment agency.
You are conversing in ${language === 'en' ? 'English' : language === 'si' ? 'Sinhala' : 'Tamil'}.

IMPORTANT: Messenger does not support file uploads directly. 
After collecting basic info, provide a link for CV upload: "Please upload your CV here: ${process.env.FRONTEND_URL}/upload?ref=${candidate.id}"

Your tasks:
1. Greet the candidate warmly
2. Ask for their name, phone number, and email
3. Ask which position they're interested in
4. Provide the upload link for their CV

Keep responses concise. Be friendly and professional.`;

    // Add user message to history
    conversationHistory.push({ role: 'user', content: text });

    // Generate response
    const response = await generateChatbotResponse(conversationHistory, systemPrompt);

    // Check if we should provide upload link
    if (response.includes('upload') || response.includes('CV') || response.includes('resume')) {
        const uploadUrl = `${process.env.FRONTEND_URL || 'https://apply.company.lk'}/upload?ref=${candidate.id}`;
        await sendButtonMessage(senderId, response, [
            { title: 'Upload CV', url: uploadUrl }
        ]);
    } else {
        await sendMessengerMessage(senderId, response);
    }

    // Log bot response
    await logCommunication({
        candidate_id: candidate.id,
        channel: 'messenger',
        direction: 'outbound',
        message_type: 'text',
        content: response
    });
}

// ===============================================
// HELPER FUNCTIONS
// ===============================================

/**
 * Get or create candidate by phone/identifier
 */
async function getOrCreateCandidate(identifier, source, name = 'Unknown Candidate') {
    try {
        // Try to find existing candidate
        const queriedCandidate = await pool.query(
            'SELECT * FROM candidates WHERE phone = $1',
            [identifier]
        );

        if (queriedCandidate.rows.length > 0) {
            return queriedCandidate.rows[0];
        }

        // Create new candidate
        const insertResult = await pool.query(
            `INSERT INTO candidates (phone, source, status, name)
             VALUES ($1, $2, 'new', $3) RETURNING id`,
            [identifier, source, name]
        );

        // Fetch the newly created candidate
        const newCandidateRes = await pool.query('SELECT * FROM candidates WHERE id = $1', [insertResult.rows[0].id]);
        return newCandidateRes.rows[0];
    } catch (error) {
        console.error('Get or create candidate error:', error);
        throw error;
    }
}

/**
 * Get conversation history for chatbot context
 */
async function getConversationHistory(candidateId, channel, limit = 10) {
    try {
        const commsResult = await pool.query(
            `SELECT content, direction 
             FROM communications 
             WHERE candidate_id = $1 AND channel = $2 AND message_type = 'text'
             ORDER BY sent_at DESC
             LIMIT $3`,
            [candidateId, channel, limit]
        );

        // Convert to OpenAI message format
        const history = commsResult.rows.reverse().map(row => ({
            role: row.direction === 'inbound' ? 'user' : 'assistant',
            content: row.content
        }));

        return history;
    } catch (error) {
        console.error('Get conversation history error:', error);
        return [];
    }
}

/**
 * Log communication to database
 */
async function logCommunication(data) {
    try {
        await pool.query(
            `INSERT INTO communications (candidate_id, channel, direction, message_type, content, metadata)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
                data.candidate_id,
                data.channel,
                data.direction,
                data.message_type,
                data.content,
                JSON.stringify(data.metadata || {})
            ]
        );
    } catch (error) {
        console.error('Log communication error:', error);
    }
}

/**
 * Continue Application Flow (Stage 2)
 * Identifies missing fields and asks the user
 */
async function continueApplicationFlow(candidateId, language, from) {
    // Reload candidate to get latest metadata
    const candidateResult = await pool.query('SELECT * FROM candidates WHERE id = $1', [candidateId]);
    const candidate = candidateResult.rows[0];
    let metadata = candidate.metadata || {};
    if (!metadata.application_form) metadata.application_form = {};

    // Identify missing fields
    const requiredFields = [
        { key: 'full_name', label: 'Full Name' },
        { key: 'address', label: 'Address' },
        { key: 'passport_no', label: 'Passport Number' },
        { key: 'nic_no', label: 'NIC Number' },
        { key: 'email', label: 'Email Address' },
        { key: 'dob', label: 'Date of Birth (YYYY-MM-DD)' },
        { key: 'age', label: 'Age' },
        { key: 'gender', label: 'Gender' },
        { key: 'marital_status', label: 'Marital Status' },
        { key: 'position_applied_for', label: 'Position Applied For' }
    ];

    let nextMissingField = null;
    let nextMissingFieldLabel = null;

    for (const field of requiredFields) {
        if (!metadata.application_form[field.key]) {
            nextMissingField = field.key;
            nextMissingFieldLabel = field.label;
            break;
        }
    }

    // Check contact numbers
    if (!nextMissingField && (!metadata.application_form.contact_numbers || metadata.application_form.contact_numbers.length === 0)) {
        nextMissingField = 'contact_numbers';
        nextMissingFieldLabel = 'Contact Number';
    }

    // Generate system prompt
    const systemPrompt = `You are a friendly recruitment assistant for a Sri Lankan recruitment agency.
You are conversing in ${language === 'en' ? 'English' : language === 'si' ? 'Sinhala' : 'Tamil'}.

Current Status: The candidate has uploaded their CV.
We have extracted some data, but need to fill the rest of the application form.

Current known info: ${JSON.stringify(metadata.application_form, null, 2)}
Missing info: ${nextMissingField ? nextMissingFieldLabel : "None - Application Complete"}

Instruction:
${nextMissingField
            ? `Ask the candidate politely for their ${nextMissingFieldLabel}. Do not ask for multiple things at once. If the user just answered a question, acknowledge it briefly and ask the next one.`
            : `Thank the candidate and confirm their application is complete. Tell them a recruiter will be in touch.`}

Be friendly, empathetic, and professional. Keep responses concise.`;

    // Get conversation history
    const conversationHistory = await getConversationHistory(candidate.id, 'whatsapp');

    // Generate response
    const response = await generateChatbotResponse(conversationHistory, systemPrompt);

    // Update metadata with the field we are likely asking for
    if (nextMissingField) {
        metadata.last_asked_field = nextMissingField;
        await pool.query('UPDATE candidates SET metadata = $1 WHERE id = $2', [metadata, candidate.id]);
    }

    // Send response
    await sendTextMessage(from, response);

    // Log bot response
    await logCommunication({
        candidate_id: candidate.id,
        channel: 'whatsapp',
        direction: 'outbound',
        message_type: 'text',
        content: response
    });
}

/**
 * Process CV file asynchronously
 */
async function processCVFile(cvFileId, candidateId, from) {
    try {
        // Update status to processing
        await pool.query(
            'UPDATE cv_files SET ocr_status = $1 WHERE id = $2',
            ['processing', cvFileId]
        );

        // Get CV file info
        const cvResult = await pool.query(
            'SELECT * FROM cv_files WHERE id = $1',
            [cvFileId]
        );
        const cvFile = cvResult.rows[0];

        const resolvedCv = resolveCvAccessUrl(cvFile);
        if (!resolvedCv.url) {
            throw new Error(`CV URL cannot be resolved for file ${cvFileId}`);
        }

        const tempFilePath = path.join('/tmp', `${cvFileId}.${cvFile.file_type}`);
        if (resolvedCv.url.startsWith('/')) {
            const localFilePath = path.join(__dirname, '../../', resolvedCv.url.replace(/^\//, ''));
            const localBuffer = await fs.readFile(localFilePath);
            await fs.writeFile(tempFilePath, localBuffer);
        } else {
            const response = await fetch(resolvedCv.url);
            if (!response.ok) {
                throw new Error(`Failed to fetch CV file (${response.status})`);
            }
            const buffer = await response.arrayBuffer();
            await fs.writeFile(tempFilePath, Buffer.from(buffer));
        }

        // Extract text using OCR
        const extractedText = await extractText(tempFilePath, cvFile.file_type);

        // Parse resume using LLM
        const parsedData = await parseResume(extractedText);

        // Get current candidate metadata
        const candidateResult = await pool.query('SELECT * FROM candidates WHERE id = $1', [candidateId]);
        const candidate = candidateResult.rows[0];
        const currentMetadata = candidate.metadata || {};

        // Initialize application_form if not present
        if (!currentMetadata.application_form) {
            currentMetadata.application_form = {};
        }

        // Merge parsed data into application_form
        currentMetadata.application_form = { ...currentMetadata.application_form, ...parsedData };

        // Update CV file with OCR text and parsed data
        await pool.query(
            'UPDATE cv_files SET ocr_text = $1, parsed_data = $2, ocr_status = $3, processed_at = NOW() WHERE id = $4',
            [extractedText, JSON.stringify(parsedData), 'completed', cvFileId]
        );

        // Update candidate with parsed data and metadata
        await pool.query(
            'UPDATE candidates SET name = COALESCE($1, name), email = COALESCE($2, email), metadata = $3, updated_at = NOW() WHERE id = $4',
            [parsedData.full_name, parsedData.email, currentMetadata, candidateId]
        );

        // Clean up temp file
        await fs.unlink(tempFilePath);

        console.log(`CV ${cvFileId} processed successfully`);

        // TRIGGER NEXT STEP: Continue flow
        const language = candidate.preferred_language || 'en';
        // We pass 'from' (phone number) if available, otherwise candidate.phone
        const phone = from || candidate.phone;
        await continueApplicationFlow(candidateId, language, phone);

    } catch (error) {
        console.error('CV processing error:', error);
        await pool.query(
            'UPDATE cv_files SET ocr_status = $1 WHERE id = $2',
            ['failed', cvFileId]
        );
    }
}

module.exports = router;
~~~

Current code:
~~~
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { generateChatbotResponse, detectLanguage, extractField } = require('../config/openai');
const { extractCandidateProfile } = require('../services/cvParser');
const { sendTextMessage, downloadMedia, markMessageAsRead } = require('../services/whatsapp');
const { sendTextMessage: sendMessengerMessage, sendButtonMessage, sendTypingIndicator } = require('../services/messenger');
const { extractText } = require('../services/ocr');
const { translate } = require('../utils/translations');
const { saveCVFile: saveLocalCVFile } = require('../utils/localStorage');
const { saveCVFile: saveCloudCVFile } = require('../utils/gcs-upload');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');
const axios  = require('axios');
const { recruiterAlert } = require('../services/recruiter-alerts');
const { resolveCvAccessUrl } = require('../utils/cv-url');
const { extractNameFromParsedCv } = require('../services/candidateService');

// NOTE: WhatsApp messages are now proxied to the Python chatbot (CHATBOT_API_URL).
// chatbot-ai.js is kept for reference but is no longer called for WhatsApp.
// All recruitment-system integration routes (chatbot-intake, chatbot-sync, etc.) remain intact.
const { generateResponse, setMissingFields, STATES } = require('../services/chatbot-ai');
const { analyzeMessage, getGreeting } = require('../services/language-processor');

// ===============================================
// WHATSAPP WEBHOOK
// ===============================================

/**
 * WhatsApp webhook verification
 */
router.get('/whatsapp', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    const VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('WhatsApp webhook verified');
        res.status(200).send(challenge);
    } else {
        res.status(403).send('Verification failed');
    }
});

/**
 * WhatsApp webhook handler
 */
router.post('/whatsapp', async (req, res) => {
    // Acknowledge receipt immediately â€” Meta requires HTTP 200 within 20 seconds.
    res.sendStatus(200);

    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Proxy to Python chatbot
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // All WhatsApp intelligence (trilingual NLP, GPT-4o RAG, full state
    // machine, CV parsing with confidence scores, ad-click detection, and
    // automatic candidate push to /api/chatbot/intake) lives in the Python bot.
    //
    // This handler is now a thin forwarding proxy: it receives the webhook
    // from Meta and forwards the raw JSON body to the Python bot's endpoint.
    // The Python bot processes the message asynchronously and sends the
    // WhatsApp reply directly to the user via the Meta API.
    //
    // Integration routes remain UNCHANGED:
    //   POST /api/chatbot/intake       â† Python bot pushes completed candidates here
    //   GET  /api/public/job-context   â† Python bot fetches ad job context here
    //   POST /api/chatbot-sync/job     â† Recruitment system pushes new jobs to Python KB
    // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const chatbotUrl = (process.env.CHATBOT_API_URL || 'http://localhost:8000').replace(/\/$/, '');

    try {
        logger.info(`[WhatsApp] Forwarding webhook â†’ ${chatbotUrl}/webhook/whatsapp`);
        await axios.post(`${chatbotUrl}/webhook/whatsapp`, req.body, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 10000
        });
        logger.info('[WhatsApp] Webhook forwarded to Python chatbot successfully');

        // Keep local candidate/CV records in sync with incoming media events.
        setImmediate(() => {
            mirrorInboundCvUploads(req.body).catch((err) => {
                logger.warn(`[WhatsApp] Local CV mirror failed: ${err.message}`);
            });
        });
    } catch (error) {
        // HTTP 200 has already been sent to Meta â€” this error will NOT cause
        // Meta to retry. Log it clearly so the issue is easy to diagnose.
        logger.error(`[WhatsApp] Failed to forward to Python chatbot at ${chatbotUrl}: ${error.message}`);
        logger.error('[WhatsApp] Fix: ensure CHATBOT_API_URL is set in .env and the Python chatbot is running (pip install -r requirements.txt && python -m uvicorn app.main:app --port 8000).');

        setImmediate(() => {
            mirrorInboundCvUploads(req.body).catch((err) => {
                logger.warn(`[WhatsApp] Local CV mirror failed after forward error: ${err.message}`);
            });
        });
    }
});

function extractWhatsAppMessages(payload) {
    if (!payload || payload.object !== 'whatsapp_business_account') return [];

    const messages = [];
    for (const entry of payload.entry || []) {
        for (const change of entry.changes || []) {
            const value = change.value || {};
            if (Array.isArray(value.messages)) {
                messages.push(...value.messages);
            }
        }
    }
    return messages;
}

async function mirrorInboundCvUploads(payload) {
    const messages = extractWhatsAppMessages(payload);
    if (messages.length === 0) return;

    for (const msg of messages) {
        try {
            if (!msg?.from) continue;

            const candidate = await getOrCreateCandidate(msg.from, 'whatsapp', `+${msg.from}`);

            // Track latest interaction regardless of message type.
            await pool.query(
                `UPDATE candidates
                 SET last_interaction = NOW(),
                     conversation_stage = CASE
                         WHEN conversation_stage = 'new' THEN 'responding'
                         ELSE conversation_stage
                     END,
                     updated_at = NOW()
                 WHERE id = $1`,
                [candidate.id]
            );

            if (msg?.id) {
                markMessageAsRead(msg.id).catch(() => {});
            }

            if (msg.type === 'document') {
                await handleWhatsAppDocument(msg, candidate, { sendAck: false, continueFlow: false });
            }
        } catch (err) {
            logger.warn(`Webhook mirror message failed: ${err.message}`);
        }
    }
}

/**
 * Handle WhatsApp text messages - ENHANCED VERSION
 * Uses advanced chatbot AI with:
 * - Trilingual support (EN/SI/TA)
 * - Sentiment analysis
 * - Knowledge base integration
 * - Slang detection
 */
async function handleWhatsAppTextMessage(message, candidate) {
    const text = message.text.body;
    const from = message.from;

    try {
        // Check if candidate has a CV
        const cvResult = await pool.query(
            'SELECT id FROM cv_files WHERE candidate_id = $1 LIMIT 1',
            [candidate.id]
        );
        const hasCV = cvResult.rows.length > 0;

        // Generate response using enhanced chatbot AI
        const response = await generateResponse({
            message: text,
            candidateId: candidate.id,
            tenantId: candidate.tenant_id || null,
            channel: 'whatsapp',
            hasCV,
            sessionData: null // Will be fetched/created by the service
        });

        // Update candidate's preferred language based on detection
        await pool.query(
            'UPDATE candidates SET preferred_language = $1, last_contact_at = NOW() WHERE id = $2',
            [response.language, candidate.id]
        );

        // Send response
        await sendTextMessage(from, response.text);

        // Log bot response
        await logCommunication({
            candidate_id: candidate.id,
            channel: 'whatsapp',
            direction: 'outbound',
            message_type: 'text',
            content: response.text,
            metadata: {
                intent: response.intent,
                sentiment: response.sentiment,
                language: response.language,
                session_state: response.sessionState,
                kb_articles_used: response.metadata?.kbArticlesUsed || []
            }
        });

        // Log any frustration/handoff requests for recruiter attention
        if (response.sessionState === STATES.HUMAN_HANDOFF) {
            logger.warn(`âš ï¸ Human handoff requested for candidate ${candidate.phone}`);
            setImmediate(() =>
                recruiterAlert('human_handoff', {
                    candidatePhone: candidate.phone,
                    lastMessage: text
                }).catch(err => logger.warn(`Human handoff alert failed: ${err.message}`))
            );
        }

    } catch (error) {
        logger.error('Enhanced chatbot error: ' + error.message + '\n' + error.stack);

        // Fallback to basic response
        const fallbackResponse = await getGreeting('frustrated', candidate.preferred_language || 'en');
        await sendTextMessage(from, fallbackResponse);

        await logCommunication({
            candidate_id: candidate.id,
            channel: 'whatsapp',
            direction: 'outbound',
            message_type: 'text',
            content: fallbackResponse,
            metadata: { error: true, fallback: true }
        });
    }
}

/**
 * Handle WhatsApp document (CV) uploads
 */
async function handleWhatsAppDocument(message, candidate, options = {}) {
    const from = message.from;
    const document = message.document;
    const { sendAck = true, continueFlow = true } = options;

    try {
        const allowedMimeTypes = new Set([
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        ]);

        if (document?.mime_type && !allowedMimeTypes.has(document.mime_type)) {
            logger.info(`Skipping non-CV document (${document.mime_type}) from ${from}`);
            return;
        }

        // Download the document
        const { data, mimeType, filename } = await downloadMedia(document.id);

        // Get file extension
        const fileExt = path.extname(filename).toLowerCase().replace('.', '') || 'pdf';

        // Save to cloud storage first, then fallback to local disk.
        const base64Data = Buffer.from(data).toString('base64');
        let fileUrl;
        try {
            const cloudSaved = await saveCloudCVFile(base64Data, filename, candidate.id);
            fileUrl = cloudSaved?.url || cloudSaved;
        } catch (cloudErr) {
            logger.warn(`Cloud CV save failed, using local fallback: ${cloudErr.message}`);
            fileUrl = await saveLocalCVFile(data, candidate.id, filename, mimeType);
        }

        // Save CV file record
        const cvFileResult = await pool.query(
            `INSERT INTO cv_files (candidate_id, file_url, file_name, file_type, ocr_status)
             VALUES ($1, $2, $3, $4, 'pending')
             RETURNING id`,
            [candidate.id, fileUrl, filename, fileExt]
        );

        const cvFileId = cvFileResult.rows[0].id;

        await pool.query(
            `UPDATE candidates
             SET cv_uploaded = TRUE,
                 cv_status = 'uploaded',
                 conversation_stage = 'cv_sent',
                 last_interaction = NOW(),
                 updated_at = NOW()
             WHERE id = $1`,
            [candidate.id]
        );

        // Send acknowledgment
        if (sendAck) {
            const language = candidate.preferred_language || 'en';
            const ackMessage = translate('cv_received', language);
            await sendTextMessage(from, ackMessage);
        }

        // Process CV asynchronously (don't wait)
        processCVFile(cvFileId, candidate.id, from, { continueFlow }).catch(err =>
            console.error('CV processing error:', err)
        );

    } catch (error) {
        console.error('Document handling error:', error);
        const language = candidate.preferred_language || 'en';
        await sendTextMessage(from, translate('error_generic', language));
    }
}

/**
 * Handle WhatsApp image uploads (also treat as potential CV)
 */
async function handleWhatsAppImage(message, candidate) {
    // Similar to document handling
    await handleWhatsAppDocument(message, candidate);
}

// ===============================================
// MESSENGER WEBHOOK
// ===============================================

/**
 * Messenger webhook verification
 */
router.get('/messenger', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    const VERIFY_TOKEN = process.env.MESSENGER_VERIFY_TOKEN;

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('Messenger webhook verified');
        res.status(200).send(challenge);
    } else {
        res.status(403).send('Verification failed');
    }
});

/**
 * Messenger webhook handler
 */
router.post('/messenger', async (req, res) => {
    // Respond immediately
    res.sendStatus(200);

    try {
        const body = req.body;

        if (body.object !== 'page') {
            return;
        }

        const entry = body.entry[0];
        const messaging = entry.messaging[0];

        if (!messaging.message) {
            return;
        }

        const senderId = messaging.sender.id;
        const messageText = messaging.message.text;

        // Show typing indicator
        await sendTypingIndicator(senderId, true);

        // Get or create candidate (use Messenger ID as phone for now)
        let candidate = await getOrCreateCandidate(`messenger_${senderId}`, 'messenger');

        // Handle the message
        await handleMessengerTextMessage(messageText, senderId, candidate);

        // Turn off typing indicator
        await sendTypingIndicator(senderId, false);

        // Log communication
        await logCommunication({
            candidate_id: candidate.id,
            channel: 'messenger',
            direction: 'inbound',
            message_type: 'text',
            content: messageText,
            metadata: { sender_id: senderId }
        });

    } catch (error) {
        console.error('Messenger webhook error:', error);
    }
});

/**
 * Handle Messenger text messages
 */
async function handleMessengerTextMessage(text, senderId, candidate) {
    // Detect language
    const language = await detectLanguage(text);

    // Update candidate's preferred language
    await pool.query(
        'UPDATE candidates SET preferred_language = $1 WHERE id = $2',
        [language, candidate.id]
    );

    // Get conversation history
    const conversationHistory = await getConversationHistory(candidate.id, 'messenger');

    // Generate system prompt
    const systemPrompt = `You are a friendly recruitment assistant for a Sri Lankan recruitment agency.
You are conversing in ${language === 'en' ? 'English' : language === 'si' ? 'Sinhala' : 'Tamil'}.

IMPORTANT: Messenger does not support file uploads directly. 
After collecting basic info, provide a link for CV upload: "Please upload your CV here: ${process.env.FRONTEND_URL}/upload?ref=${candidate.id}"

Your tasks:
1. Greet the candidate warmly
2. Ask for their name, phone number, and email
3. Ask which position they're interested in
4. Provide the upload link for their CV

Keep responses concise. Be friendly and professional.`;

    // Add user message to history
    conversationHistory.push({ role: 'user', content: text });

    // Generate response
    const response = await generateChatbotResponse(conversationHistory, systemPrompt);

    // Check if we should provide upload link
    if (response.includes('upload') || response.includes('CV') || response.includes('resume')) {
        const uploadUrl = `${process.env.FRONTEND_URL || 'https://apply.company.lk'}/upload?ref=${candidate.id}`;
        await sendButtonMessage(senderId, response, [
            { title: 'Upload CV', url: uploadUrl }
        ]);
    } else {
        await sendMessengerMessage(senderId, response);
    }

    // Log bot response
    await logCommunication({
        candidate_id: candidate.id,
        channel: 'messenger',
        direction: 'outbound',
        message_type: 'text',
        content: response
    });
}

// ===============================================
// HELPER FUNCTIONS
// ===============================================

/**
 * Get or create candidate by phone/identifier
 */
async function getOrCreateCandidate(identifier, source, name = 'Unknown Candidate') {
    try {
        // Try to find existing candidate
        const queriedCandidate = await pool.query(
            'SELECT * FROM candidates WHERE phone = $1',
            [identifier]
        );

        if (queriedCandidate.rows.length > 0) {
            return queriedCandidate.rows[0];
        }

        // Create new candidate
        const insertResult = await pool.query(
            `INSERT INTO candidates (phone, source, status, name)
             VALUES ($1, $2, 'new', $3) RETURNING id`,
            [identifier, source, name]
        );

        // Fetch the newly created candidate
        const newCandidateRes = await pool.query('SELECT * FROM candidates WHERE id = $1', [insertResult.rows[0].id]);
        return newCandidateRes.rows[0];
    } catch (error) {
        console.error('Get or create candidate error:', error);
        throw error;
    }
}

/**
 * Get conversation history for chatbot context
 */
async function getConversationHistory(candidateId, channel, limit = 10) {
    try {
        const commsResult = await pool.query(
            `SELECT content, direction 
             FROM communications 
             WHERE candidate_id = $1 AND channel = $2 AND message_type = 'text'
             ORDER BY sent_at DESC
             LIMIT $3`,
            [candidateId, channel, limit]
        );

        // Convert to OpenAI message format
        const history = commsResult.rows.reverse().map(row => ({
            role: row.direction === 'inbound' ? 'user' : 'assistant',
            content: row.content
        }));

        return history;
    } catch (error) {
        console.error('Get conversation history error:', error);
        return [];
    }
}

/**
 * Log communication to database
 */
async function logCommunication(data) {
    try {
        await pool.query(
            `INSERT INTO communications (candidate_id, channel, direction, message_type, content, metadata)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
                data.candidate_id,
                data.channel,
                data.direction,
                data.message_type,
                data.content,
                JSON.stringify(data.metadata || {})
            ]
        );

        const nextStage = data.direction === 'inbound' ? 'responding' : null;
        if (nextStage) {
            await pool.query(
                `UPDATE candidates
                 SET last_interaction = NOW(),
                     conversation_stage = CASE
                         WHEN conversation_stage = 'new' THEN 'responding'
                         ELSE conversation_stage
                     END,
                     updated_at = NOW()
                 WHERE id = $1`,
                [data.candidate_id]
            );
        } else {
            await pool.query(
                'UPDATE candidates SET last_interaction = NOW(), updated_at = NOW() WHERE id = $1',
                [data.candidate_id]
            );
        }
    } catch (error) {
        console.error('Log communication error:', error);
    }
}

/**
 * Continue Application Flow (Stage 2)
 * Identifies missing fields and asks the user
 */
async function continueApplicationFlow(candidateId, language, from) {
    // Reload candidate to get latest metadata
    const candidateResult = await pool.query('SELECT * FROM candidates WHERE id = $1', [candidateId]);
    const candidate = candidateResult.rows[0];
    let metadata = candidate.metadata || {};
    if (!metadata.application_form) metadata.application_form = {};

    // Identify missing fields
    const requiredFields = [
        { key: 'full_name', label: 'Full Name' },
        { key: 'address', label: 'Address' },
        { key: 'passport_no', label: 'Passport Number' },
        { key: 'nic_no', label: 'NIC Number' },
        { key: 'email', label: 'Email Address' },
        { key: 'dob', label: 'Date of Birth (YYYY-MM-DD)' },
        { key: 'age', label: 'Age' },
        { key: 'gender', label: 'Gender' },
        { key: 'marital_status', label: 'Marital Status' },
        { key: 'position_applied_for', label: 'Position Applied For' }
    ];

    let nextMissingField = null;
    let nextMissingFieldLabel = null;

    for (const field of requiredFields) {
        if (!metadata.application_form[field.key]) {
            nextMissingField = field.key;
            nextMissingFieldLabel = field.label;
            break;
        }
    }

    // Check contact numbers
    if (!nextMissingField && (!metadata.application_form.contact_numbers || metadata.application_form.contact_numbers.length === 0)) {
        nextMissingField = 'contact_numbers';
        nextMissingFieldLabel = 'Contact Number';
    }

    // Generate system prompt
    const systemPrompt = `You are a friendly recruitment assistant for a Sri Lankan recruitment agency.
You are conversing in ${language === 'en' ? 'English' : language === 'si' ? 'Sinhala' : 'Tamil'}.

Current Status: The candidate has uploaded their CV.
We have extracted some data, but need to fill the rest of the application form.

Current known info: ${JSON.stringify(metadata.application_form, null, 2)}
Missing info: ${nextMissingField ? nextMissingFieldLabel : "None - Application Complete"}

Instruction:
${nextMissingField
            ? `Ask the candidate politely for their ${nextMissingFieldLabel}. Do not ask for multiple things at once. If the user just answered a question, acknowledge it briefly and ask the next one.`
            : `Thank the candidate and confirm their application is complete. Tell them a recruiter will be in touch.`}

Be friendly, empathetic, and professional. Keep responses concise.`;

    // Get conversation history
    const conversationHistory = await getConversationHistory(candidate.id, 'whatsapp');

    // Generate response
    const response = await generateChatbotResponse(conversationHistory, systemPrompt);

    // Update metadata with the field we are likely asking for
    if (nextMissingField) {
        metadata.last_asked_field = nextMissingField;
        await pool.query('UPDATE candidates SET metadata = $1 WHERE id = $2', [metadata, candidate.id]);
    }

    // Send response
    await sendTextMessage(from, response);

    // Log bot response
    await logCommunication({
        candidate_id: candidate.id,
        channel: 'whatsapp',
        direction: 'outbound',
        message_type: 'text',
        content: response
    });
}

/**
 * Process CV file asynchronously
 */
async function processCVFile(cvFileId, candidateId, from, options = {}) {
    try {
        const { continueFlow = true } = options;

        // Update status to processing
        await pool.query(
            'UPDATE cv_files SET ocr_status = $1 WHERE id = $2',
            ['processing', cvFileId]
        );

        // Get CV file info
        const cvResult = await pool.query(
            'SELECT * FROM cv_files WHERE id = $1',
            [cvFileId]
        );
        const cvFile = cvResult.rows[0];

        const resolvedCv = resolveCvAccessUrl(cvFile);
        if (!resolvedCv.url) {
            throw new Error(`CV URL cannot be resolved for file ${cvFileId}`);
        }

        const tempFilePath = path.join('/tmp', `${cvFileId}.${cvFile.file_type}`);
        if (resolvedCv.url.startsWith('/')) {
            const localFilePath = path.join(__dirname, '../../', resolvedCv.url.replace(/^\//, ''));
            const localBuffer = await fs.readFile(localFilePath);
            await fs.writeFile(tempFilePath, localBuffer);
        } else {
            const response = await fetch(resolvedCv.url);
            if (!response.ok) {
                throw new Error(`Failed to fetch CV file (${response.status})`);
            }
            const buffer = await response.arrayBuffer();
            await fs.writeFile(tempFilePath, Buffer.from(buffer));
        }

        // Extract text using OCR
        const extractedText = await extractText(tempFilePath, cvFile.file_type);

        // Parse resume into structured profile (AI with heuristic fallback).
        const parsedProfile = await extractCandidateProfile(extractedText);
        const parsedData = parsedProfile.parsedData || {};
        const extractedName = extractNameFromParsedCv(parsedData, parsedProfile.full_name || null);

        // Get current candidate metadata
        const candidateResult = await pool.query('SELECT * FROM candidates WHERE id = $1', [candidateId]);
        const candidate = candidateResult.rows[0];
        const currentMetadata = typeof candidate.metadata === 'string'
            ? (() => {
                try { return JSON.parse(candidate.metadata); } catch (_) { return {}; }
            })()
            : (candidate.metadata || {});

        // Initialize application_form if not present
        if (!currentMetadata.application_form) {
            currentMetadata.application_form = {};
        }

        // Merge parsed data into application_form
        currentMetadata.application_form = { ...currentMetadata.application_form, ...parsedData };

        // Update CV file with OCR text and parsed data
        await pool.query(
            'UPDATE cv_files SET ocr_text = $1, parsed_data = $2, ocr_status = $3, processed_at = NOW() WHERE id = $4',
            [extractedText, JSON.stringify(parsedData), 'completed', cvFileId]
        );

        // Update candidate with parsed data and metadata
        await pool.query(
            `UPDATE candidates
             SET name = COALESCE($1, name),
                 full_name = COALESCE($1, full_name),
                 email = COALESCE($2, email),
                 skills = COALESCE($3, skills),
                 experience_years = COALESCE($4, experience_years),
                 metadata = $5,
                 cv_uploaded = TRUE,
                 cv_status = 'parsed',
                 conversation_stage = 'cv_sent',
                 last_interaction = NOW(),
                 updated_at = NOW()
             WHERE id = $6`,
            [
                extractedName,
                parsedData.email,
                Array.isArray(parsedProfile.skills) && parsedProfile.skills.length > 0 ? parsedProfile.skills.join(', ') : null,
                parsedProfile.experience_years,
                currentMetadata,
                candidateId
            ]
        );

        // Clean up temp file
        await fs.unlink(tempFilePath);

        console.log(`CV ${cvFileId} processed successfully`);

        if (continueFlow) {
            // TRIGGER NEXT STEP: Continue flow
            const language = candidate.preferred_language || 'en';
            // We pass 'from' (phone number) if available, otherwise candidate.phone
            const phone = from || candidate.phone;
            await continueApplicationFlow(candidateId, language, phone);
        }

    } catch (error) {
        console.error('CV processing error:', error);
        await pool.query(
            `UPDATE cv_files SET ocr_status = $1 WHERE id = $2`,
            ['failed', cvFileId]
        );
        await pool.query(
            `UPDATE candidates
             SET cv_uploaded = TRUE,
                 cv_status = 'failed',
                 last_interaction = NOW(),
                 updated_at = NOW()
             WHERE id = $1`,
            [candidateId]
        );
    }
}

module.exports = router;
~~~

## recruitment-system/backend/src/services/candidateService.js

Previous code:
~~~
(File did not exist at baseline commit)
~~~

Current code:
~~~
function computeDisplayIdentity(candidate = {}) {
    const fullName = typeof candidate.full_name === 'string' ? candidate.full_name.trim() : '';
    if (candidate.cv_uploaded && fullName) return fullName;

    const whatsappPhone = typeof candidate.whatsapp_phone === 'string' ? candidate.whatsapp_phone.trim() : '';
    const phone = typeof candidate.phone === 'string' ? candidate.phone.trim() : '';
    return whatsappPhone || phone || candidate.name || 'Unknown';
}

function normalizeConversationStage(stage) {
    const allowed = new Set(['new', 'responding', 'cv_sent', 'completed', 'dropped']);
    return allowed.has(stage) ? stage : 'new';
}

function extractNameFromParsedCv(parsedData = {}, fallback = '') {
    if (!parsedData || typeof parsedData !== 'object') return fallback || null;

    if (typeof parsedData.full_name === 'string' && parsedData.full_name.trim()) {
        return parsedData.full_name.trim();
    }

    if (typeof parsedData.name === 'string' && parsedData.name.trim()) {
        return parsedData.name.trim();
    }

    if (typeof parsedData.candidate_name === 'string' && parsedData.candidate_name.trim()) {
        return parsedData.candidate_name.trim();
    }

    return fallback || null;
}

module.exports = {
    computeDisplayIdentity,
    normalizeConversationStage,
    extractNameFromParsedCv,
};

~~~

## recruitment-system/backend/src/services/cvParser.js

Previous code:
~~~
(File did not exist at baseline commit)
~~~

Current code:
~~~
const { parseResume } = require('../config/openai');

function extractNameHeuristic(text = '') {
    const firstLine = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 2 && line.length < 80);

    if (!firstLine) return null;

    const cleaned = firstLine.replace(/[^a-zA-Z .'-]/g, '').trim();
    if (!cleaned) return null;

    const words = cleaned.split(/\s+/).filter(Boolean);
    if (words.length < 2 || words.length > 6) return null;
    return cleaned;
}

function extractSkillsHeuristic(text = '') {
    const skillsSection = text.match(/skills?[:\s\n]+([\s\S]{0,300})/i)?.[1] || '';
    if (!skillsSection) return [];

    return skillsSection
        .split(/[\n,|â€¢\-]+/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 2 && s.length <= 40)
        .slice(0, 20);
}

function extractExperienceYearsHeuristic(text = '') {
    const yearsMatch = text.match(/(\d{1,2})\+?\s*(years?|yrs?)\s+(of\s+)?experience/i);
    if (!yearsMatch) return null;

    const value = parseInt(yearsMatch[1], 10);
    if (Number.isNaN(value)) return null;
    return value;
}

async function extractCandidateProfile(cvText = '') {
    try {
        const parsed = await parseResume(cvText);
        const experienceYears = Array.isArray(parsed?.experience)
            ? parsed.experience.reduce((acc, item) => {
                const years = Number(item?.years || 0);
                return Number.isFinite(years) ? acc + years : acc;
            }, 0)
            : null;

        return {
            parsedData: parsed,
            full_name: parsed?.full_name || null,
            skills: Array.isArray(parsed?.skills) ? parsed.skills : extractSkillsHeuristic(cvText),
            experience_years: Number.isFinite(experienceYears) && experienceYears > 0 ? experienceYears : extractExperienceYearsHeuristic(cvText),
        };
    } catch (_) {
        return {
            parsedData: {
                full_name: extractNameHeuristic(cvText),
                skills: extractSkillsHeuristic(cvText),
                experience: [],
            },
            full_name: extractNameHeuristic(cvText),
            skills: extractSkillsHeuristic(cvText),
            experience_years: extractExperienceYearsHeuristic(cvText),
        };
    }
}

module.exports = {
    extractCandidateProfile,
};

~~~

## recruitment-system/backend/src/services/whatsapp.js

Previous code:
~~~
const axios = require('axios');
const FormData = require('form-data');

const WHATSAPP_API_URL = 'https://graph.facebook.com/v18.0';
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

/**
 * Send WhatsApp text message
 */
async function sendTextMessage(to, message) {
    try {
        const response = await axios.post(
            `${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: to.replace(/[^0-9]/g, ''), // Clean phone number
                type: 'text',
                text: { body: message }
            },
            {
                headers: {
                    'Authorization': `Bearer ${ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        return response.data;
    } catch (error) {
        console.error('WhatsApp send error:', error.response?.data || error.message);
        throw error;
    }
}

/**
 * Send WhatsApp template message
 */
async function sendTemplateMessage(to, templateName, languageCode, components = []) {
    try {
        const response = await axios.post(
            `${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: 'whatsapp',
                to: to.replace(/[^0-9]/g, ''),
                type: 'template',
                template: {
                    name: templateName,
                    language: { code: languageCode },
                    components
                }
            },
            {
                headers: {
                    'Authorization': `Bearer ${ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        return response.data;
    } catch (error) {
        console.error('WhatsApp template send error:', error.response?.data || error.message);
        throw error;
    }
}

/**
 * Download media from WhatsApp
 */
async function downloadMedia(mediaId) {
    try {
        // Step 1: Get media URL
        const mediaResponse = await axios.get(
            `${WHATSAPP_API_URL}/${mediaId}`,
            {
                headers: {
                    'Authorization': `Bearer ${ACCESS_TOKEN}`
                }
            }
        );
        
        const mediaUrl = mediaResponse.data.url;
        
        // Step 2: Download the actual file
        const fileResponse = await axios.get(mediaUrl, {
            headers: {
                'Authorization': `Bearer ${ACCESS_TOKEN}`
            },
            responseType: 'arraybuffer'
        });
        
        return {
            data: fileResponse.data,
            mimeType: fileResponse.headers['content-type'],
            filename: `whatsapp_${mediaId}.${getExtensionFromMimeType(fileResponse.headers['content-type'])}`
        };
    } catch (error) {
        console.error('WhatsApp media download error:', error.response?.data || error.message);
        throw error;
    }
}

/**
 * Mark message as read
 */
async function markMessageAsRead(messageId) {
    try {
        await axios.post(
            `${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: 'whatsapp',
                status: 'read',
                message_id: messageId
            },
            {
                headers: {
                    'Authorization': `Bearer ${ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );
    } catch (error) {
        console.error('WhatsApp mark read error:', error.response?.data || error.message);
    }
}

/**
 * Helper function to get file extension from MIME type
 */
function getExtensionFromMimeType(mimeType) {
    const extensions = {
        'application/pdf': 'pdf',
        'application/msword': 'doc',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/jpg': 'jpg'
    };
    return extensions[mimeType] || 'bin';
}

module.exports = {
    sendTextMessage,
    sendTemplateMessage,
    downloadMedia,
    markMessageAsRead
};
~~~

Current code:
~~~
const axios = require('axios');
const FormData = require('form-data');
const logger = require('../utils/logger');

const WHATSAPP_API_URL = 'https://graph.facebook.com/v18.0';
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizePhone(to) {
    return String(to || '').replace(/[^0-9]/g, '');
}

function extractDeliveryStatus(data) {
    const messageId = data?.messages?.[0]?.id || null;
    return {
        state: messageId ? 'sent' : 'failed',
        messageId,
        contactWaId: data?.contacts?.[0]?.wa_id || null,
    };
}

async function postWithRetry(payload, label, maxRetries = 3) {
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
        try {
            const response = await axios.post(
                `${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/messages`,
                payload,
                {
                    headers: {
                        Authorization: `Bearer ${ACCESS_TOKEN}`,
                        'Content-Type': 'application/json',
                    },
                    timeout: 15000,
                }
            );

            const delivery = extractDeliveryStatus(response.data);
            logger.info(`[WhatsApp] ${label} succeeded: ${JSON.stringify(delivery)}`);
            return {
                ...delivery,
                raw: response.data,
                attempts: attempt,
            };
        } catch (error) {
            lastError = error;
            const statusCode = error?.response?.status;
            const isRetryable = !statusCode || statusCode >= 500 || statusCode === 429;

            logger.warn(
                `[WhatsApp] ${label} attempt ${attempt}/${maxRetries} failed: ` +
                `${statusCode || 'network'} ${JSON.stringify(error?.response?.data || error.message)}`
            );

            if (!isRetryable || attempt === maxRetries) {
                break;
            }

            await sleep(300 * attempt);
        }
    }

    logger.error(`[WhatsApp] ${label} failed after retries: ${lastError?.message || 'unknown error'}`);
    throw lastError;
}

/**
 * Send WhatsApp text message
 */
async function sendTextMessage(to, message) {
    const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: sanitizePhone(to),
        type: 'text',
        text: { body: message }
    };

    return postWithRetry(payload, 'sendTextMessage');
}

/**
 * Send WhatsApp template message
 */
async function sendTemplateMessage(to, templateName, languageCode, components = []) {
    const payload = {
        messaging_product: 'whatsapp',
        to: sanitizePhone(to),
        type: 'template',
        template: {
            name: templateName,
            language: { code: languageCode },
            components
        }
    };

    return postWithRetry(payload, 'sendTemplateMessage');
}

/**
 * Send WhatsApp document message (for CVs or file attachments)
 */
async function sendDocumentMessage(to, documentUrl, caption = '', filename = undefined) {
    const payload = {
        messaging_product: 'whatsapp',
        to: sanitizePhone(to),
        type: 'document',
        document: {
            link: documentUrl,
            caption,
            ...(filename ? { filename } : {}),
        },
    };

    return postWithRetry(payload, 'sendDocumentMessage');
}

/**
 * Download media from WhatsApp
 */
async function downloadMedia(mediaId) {
    try {
        // Step 1: Get media URL
        const mediaResponse = await axios.get(
            `${WHATSAPP_API_URL}/${mediaId}`,
            {
                headers: {
                    'Authorization': `Bearer ${ACCESS_TOKEN}`
                }
            }
        );
        
        const mediaUrl = mediaResponse.data.url;
        
        // Step 2: Download the actual file
        const fileResponse = await axios.get(mediaUrl, {
            headers: {
                'Authorization': `Bearer ${ACCESS_TOKEN}`
            },
            responseType: 'arraybuffer'
        });
        
        return {
            data: fileResponse.data,
            mimeType: fileResponse.headers['content-type'],
            filename: `whatsapp_${mediaId}.${getExtensionFromMimeType(fileResponse.headers['content-type'])}`
        };
    } catch (error) {
        console.error('WhatsApp media download error:', error.response?.data || error.message);
        throw error;
    }
}

/**
 * Mark message as read
 */
async function markMessageAsRead(messageId) {
    try {
        await axios.post(
            `${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: 'whatsapp',
                status: 'read',
                message_id: messageId
            },
            {
                headers: {
                    'Authorization': `Bearer ${ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );
    } catch (error) {
        console.error('WhatsApp mark read error:', error.response?.data || error.message);
    }
}

/**
 * Helper function to get file extension from MIME type
 */
function getExtensionFromMimeType(mimeType) {
    const extensions = {
        'application/pdf': 'pdf',
        'application/msword': 'doc',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/jpg': 'jpg'
    };
    return extensions[mimeType] || 'bin';
}

module.exports = {
    sendTextMessage,
    sendTemplateMessage,
    sendDocumentMessage,
    downloadMedia,
    markMessageAsRead
};

~~~

## recruitment-system/database/schema.sql

Previous code:
~~~
-- Recruitment System Database Schema
-- PostgreSQL 14+

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- For fuzzy text matching

-- ===============================================
-- CANDIDATES TABLE
-- ===============================================
CREATE TABLE candidates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    phone TEXT UNIQUE NOT NULL,
    email TEXT,
    source TEXT NOT NULL, -- 'whatsapp', 'email', 'messenger', 'phone', 'walkin', 'web'
    preferred_language TEXT DEFAULT 'en', -- 'en', 'si', 'ta'
    status TEXT DEFAULT 'new', -- 'new', 'screening', 'interview', 'hired', 'rejected', 'future_pool'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_contact_at TIMESTAMP,
    notes TEXT,
    tags TEXT[], -- Array of tags like ['urgent', 'excellent_english', 'height_borderline']
    metadata JSONB DEFAULT '{}'::jsonb
);

-- Indexes for performance
CREATE INDEX idx_candidates_phone ON candidates(phone);
CREATE INDEX idx_candidates_email ON candidates(email);
CREATE INDEX idx_candidates_status ON candidates(status);
CREATE INDEX idx_candidates_source ON candidates(source);
CREATE INDEX idx_candidates_created_at ON candidates(created_at DESC);
CREATE INDEX idx_candidates_name_trgm ON candidates USING gin(name gin_trgm_ops);

-- ===============================================
-- CV_FILES TABLE
-- ===============================================
CREATE TABLE cv_files (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    file_url TEXT NOT NULL,
    file_name TEXT,
    file_size INTEGER,
    file_type TEXT, -- 'pdf', 'doc', 'docx', 'image'
    ocr_status TEXT DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'failed'
    ocr_text TEXT,
    parsed_data JSONB DEFAULT '{}'::jsonb, -- Structured extraction from LLM
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP,
    is_primary BOOLEAN DEFAULT false
);

CREATE INDEX idx_cv_files_candidate ON cv_files(candidate_id);
CREATE INDEX idx_cv_files_ocr_status ON cv_files(ocr_status);

-- ===============================================
-- JOBS TABLE
-- ===============================================
CREATE TABLE jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title TEXT NOT NULL,
    category TEXT NOT NULL, -- 'security', 'hospitality', 'manufacturing', etc.
    description TEXT,
    requirements JSONB NOT NULL DEFAULT '{}'::jsonb, -- Min/max criteria
    wiggle_room JSONB DEFAULT '{}'::jsonb, -- Tolerance settings
    status TEXT DEFAULT 'active', -- 'active', 'paused', 'closed', 'filled'
    positions_available INTEGER DEFAULT 1,
    positions_filled INTEGER DEFAULT 0,
    salary_range TEXT,
    location TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by UUID, -- Reference to users table
    deadline DATE
);

CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_category ON jobs(category);
CREATE INDEX idx_jobs_created_at ON jobs(created_at DESC);

-- ===============================================
-- PROJECTS TABLE
-- ===============================================
CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title TEXT NOT NULL,
    client_name TEXT NOT NULL,
    industry_type TEXT NOT NULL, -- 'Hypermarket', 'Restaurant', 'Construction', 'Healthcare', 'Hospitality', etc.
    description TEXT,
    countries JSONB NOT NULL DEFAULT '[]'::jsonb, -- ['UAE', 'Qatar', 'Oman', 'Bahrain', 'Saudi Arabia', 'Kuwait']
    status TEXT DEFAULT 'planning', -- 'planning', 'active', 'on_hold', 'completed', 'cancelled'
    priority TEXT DEFAULT 'normal', -- 'normal', 'high', 'urgent'
    total_positions INTEGER DEFAULT 0,
    filled_positions INTEGER DEFAULT 0,
    start_date DATE,
    interview_date DATE,
    end_date DATE,
    benefits JSONB DEFAULT '{}'::jsonb, -- { accommodation: true, transport: true, meals: true, visa: true, ticket: true }
    salary_info JSONB DEFAULT '{}'::jsonb, -- { min: 1500, max: 2000, currency: 'AED' }
    contact_info JSONB DEFAULT '{}'::jsonb, -- { whatsapp: '', email: '', address: '' }
    requirements JSONB DEFAULT '{}'::jsonb, -- Project-specific requirements
    metadata JSONB DEFAULT '{}'::jsonb,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_projects_status ON projects(status);
CREATE INDEX idx_projects_priority ON projects(priority);
CREATE INDEX idx_projects_client_name ON projects(client_name);
CREATE INDEX idx_projects_interview_date ON projects(interview_date);
CREATE INDEX idx_projects_created_at ON projects(created_at DESC);
CREATE INDEX idx_projects_industry ON projects(industry_type);

-- ===============================================
-- PROJECT_ASSIGNMENTS TABLE (User-Project Mapping)
-- ===============================================
CREATE TABLE project_assignments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL, -- 'owner', 'handler', 'agent', 'officer'
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    assigned_by UUID REFERENCES users(id)
);

CREATE UNIQUE INDEX idx_project_assignments_unique ON project_assignments(project_id, user_id, role);
CREATE INDEX idx_project_assignments_project ON project_assignments(project_id);
CREATE INDEX idx_project_assignments_user ON project_assignments(user_id);

-- Add project_id to jobs table (REQUIRED - Jobs must belong to a project)
ALTER TABLE jobs ADD COLUMN project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT;
CREATE INDEX idx_jobs_project ON jobs(project_id);

-- ===============================================
-- APPLICATIONS TABLE
-- ===============================================
CREATE TABLE applications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    status TEXT DEFAULT 'applied', -- 'applied', 'screening', 'certified', 'interview_scheduled', 'interviewed', 'selected', 'rejected', 'placed'
    match_score DECIMAL(3,2), -- 0.00 to 1.00
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    certified_at TIMESTAMP,
    certified_by UUID, -- Reference to users table
    interview_datetime TIMESTAMP,
    interview_location TEXT,
    interview_notes TEXT,
    rejection_reason TEXT,
    alternative_jobs_suggested UUID[], -- Array of job IDs
    metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX idx_applications_candidate ON applications(candidate_id);
CREATE INDEX idx_applications_job ON applications(job_id);
CREATE INDEX idx_applications_status ON applications(status);
CREATE INDEX idx_applications_match_score ON applications(match_score DESC);
CREATE UNIQUE INDEX idx_applications_unique ON applications(candidate_id, job_id);

-- ===============================================
-- COMMUNICATIONS TABLE
-- ===============================================
CREATE TABLE communications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    channel TEXT NOT NULL, -- 'whatsapp', 'messenger', 'email', 'sms', 'phone', 'in_person'
    direction TEXT NOT NULL, -- 'inbound', 'outbound'
    message_type TEXT, -- 'text', 'voice', 'document', 'image'
    content TEXT,
    metadata JSONB DEFAULT '{}'::jsonb, -- Store additional data like call duration, message IDs, etc.
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    delivered_at TIMESTAMP,
    read_at TIMESTAMP,
    responded_at TIMESTAMP,
    sent_by UUID, -- Reference to users table (for outbound)
    call_recording_url TEXT,
    attachments TEXT[] -- Array of file URLs
);

CREATE INDEX idx_communications_candidate ON communications(candidate_id);
CREATE INDEX idx_communications_channel ON communications(channel);
CREATE INDEX idx_communications_sent_at ON communications(sent_at DESC);

-- ===============================================
-- USERS TABLE (Recruiters/Handlers)
-- ===============================================
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name TEXT NOT NULL,
    role TEXT DEFAULT 'recruiter', -- 'admin', 'recruiter', 'supervisor'
    phone TEXT,
    is_active BOOLEAN DEFAULT true,
    assigned_jobs UUID[], -- Array of job IDs
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMP,
    metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);

-- ===============================================
-- INTERVIEW_SCHEDULES TABLE
-- ===============================================
CREATE TABLE interview_schedules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    scheduled_datetime TIMESTAMP NOT NULL,
    location TEXT,
    interviewer_id UUID REFERENCES users(id),
    duration_minutes INTEGER DEFAULT 30,
    status TEXT DEFAULT 'scheduled', -- 'scheduled', 'confirmed', 'completed', 'cancelled', 'no_show'
    confirmation_sent_at TIMESTAMP,
    reminder_sent_at TIMESTAMP,
    completed_at TIMESTAMP,
    feedback TEXT,
    rating INTEGER, -- 1-5 scale
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by UUID REFERENCES users(id)
);

CREATE INDEX idx_interview_schedules_application ON interview_schedules(application_id);
CREATE INDEX idx_interview_schedules_datetime ON interview_schedules(scheduled_datetime);
CREATE INDEX idx_interview_schedules_status ON interview_schedules(status);

-- ===============================================
-- TRANSFER_REQUESTS TABLE
-- ===============================================
CREATE TABLE transfer_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    from_job_id UUID REFERENCES jobs(id),
    to_job_id UUID NOT NULL REFERENCES jobs(id),
    requested_by UUID NOT NULL REFERENCES users(id),
    reason TEXT NOT NULL,
    status TEXT DEFAULT 'pending', -- 'pending', 'approved', 'rejected'
    reviewed_by UUID REFERENCES users(id),
    reviewed_at TIMESTAMP,
    review_notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_transfer_requests_candidate ON transfer_requests(candidate_id);
CREATE INDEX idx_transfer_requests_status ON transfer_requests(status);

-- ===============================================
-- AUDIT_LOGS TABLE
-- ===============================================
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id),
    action TEXT NOT NULL, -- 'create', 'update', 'delete', 'view', 'export'
    entity_type TEXT NOT NULL, -- 'candidate', 'job', 'application', etc.
    entity_id UUID,
    changes JSONB, -- Store old and new values
    ip_address TEXT,
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);

-- ===============================================
-- TRANSLATIONS TABLE
-- ===============================================
CREATE TABLE translations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    key TEXT NOT NULL,
    language TEXT NOT NULL, -- 'en', 'si', 'ta'
    value TEXT NOT NULL,
    context TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(key, language)
);

CREATE INDEX idx_translations_key ON translations(key);
CREATE INDEX idx_translations_language ON translations(language);

-- ===============================================
-- NOTIFICATION_QUEUE TABLE
-- ===============================================
CREATE TABLE notification_queue (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    channel TEXT NOT NULL, -- 'whatsapp', 'sms', 'email'
    template TEXT NOT NULL,
    variables JSONB DEFAULT '{}'::jsonb,
    scheduled_for TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'pending', -- 'pending', 'sent', 'failed', 'cancelled'
    sent_at TIMESTAMP,
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_notification_queue_status ON notification_queue(status);
CREATE INDEX idx_notification_queue_scheduled ON notification_queue(scheduled_for);

-- ===============================================
-- FUNCTIONS AND TRIGGERS
-- ===============================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for updated_at
CREATE TRIGGER update_candidates_updated_at BEFORE UPDATE ON candidates
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_jobs_updated_at BEFORE UPDATE ON jobs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Function to check for duplicate candidates
CREATE OR REPLACE FUNCTION check_duplicate_candidate()
RETURNS TRIGGER AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM candidates 
        WHERE (phone = NEW.phone OR email = NEW.email) 
        AND id != NEW.id
    ) THEN
        RAISE EXCEPTION 'Duplicate candidate with same phone or email exists';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER check_duplicate_before_insert BEFORE INSERT ON candidates
    FOR EACH ROW EXECUTE FUNCTION check_duplicate_candidate();

-- ===============================================
-- SAMPLE DATA FOR TESTING
-- ===============================================

-- Insert sample job categories
INSERT INTO jobs (title, category, requirements, wiggle_room, status, positions_available) VALUES
('Security Guard - Dubai', 'security', 
    '{"min_height_cm": 170, "max_height_cm": 190, "required_languages": ["English"], "min_age": 21, "max_age": 45, "licenses": ["security_license"]}'::jsonb,
    '{"height_tolerance_cm": 5, "age_tolerance_years": 2}'::jsonb,
    'active', 10
),
('Hospitality Staff - Qatar', 'hospitality',
    '{"min_height_cm": 160, "required_languages": ["English"], "min_age": 21, "max_age": 40, "experience_years": 2}'::jsonb,
    '{"height_tolerance_cm": 3, "experience_tolerance_years": 1}'::jsonb,
    'active', 5
),
('Factory Worker - Saudi Arabia', 'manufacturing',
    '{"required_languages": ["English"], "min_age": 21, "max_age": 45}'::jsonb,
    '{"age_tolerance_years": 3}'::jsonb,
    'active', 20
);

-- Insert sample translations
INSERT INTO translations (key, language, value, context) VALUES
('greeting', 'en', 'Hello! Welcome to our recruitment agency.', 'chatbot'),
('greeting', 'si', 'α╢åα╢║α╖öα╢╢α╖¥α╖Çα╢▒α╖è! α╢àα╢┤α╢£α╖Ü α╢╗α╖Éα╢Üα╖Æα╢║α╖Å α╢▒α╖Æα╢║α╖¥α╢óα╖Æα╢¡α╖Åα╢║α╢¡α╢▒α╢║ α╖Çα╖Öα╢¡ α╖âα╖Åα╢»α╢╗α╢║α╖Öα╢▒α╖è α╢┤α╖Æα╖àα╖Æα╢£α╢▒α╖Æα╢╕α╖ö.', 'chatbot'),
('greeting', 'ta', 'α«╡α«úα«òα»ìα«òα««α»ì! α«Äα«Öα»ìα«òα«│α»ì α«åα«ƒα»ìα«Üα»çα«░α»ìα«¬α»ìα«¬α»ü α«¿α«┐α«▒α»üα«╡α«⌐α«ñα»ìα«ñα«┐α«▒α»ìα«òα»ü α«╡α«░α«╡α»çα«▒α»ìα«òα«┐α«▒α»ïα««α»ì.', 'chatbot'),
('ask_name', 'en', 'What is your name?', 'chatbot'),
('ask_name', 'si', 'α╢öα╢╢α╖Ü α╢▒α╢╕ α╢Üα╖öα╢╕α╢Üα╖èα╢»?', 'chatbot'),
('ask_name', 'ta', 'α«ëα«Öα»ìα«òα«│α»ì α«¬α»åα«»α«░α»ì α«Äα«⌐α»ìα«⌐?', 'chatbot'),
('ask_position', 'en', 'Which position are you interested in?', 'chatbot'),
('ask_position', 'si', 'α╢öα╢╢ α╢Üα╖Éα╢╕α╢¡α╖Æ α╢╗α╖Éα╢Üα╖Æα╢║α╖Åα╖Ç α╢Üα╖öα╢╕α╢Üα╖èα╢»?', 'chatbot'),
('ask_position', 'ta', 'α«¿α»Çα«Öα»ìα«òα«│α»ì α«Äα«¿α»ìα«ñ α«╡α»çα«▓α»êα«òα»ìα«òα»ü α«åα«░α»ìα«╡α««α«╛α«ò α«ëα«│α»ìα«│α»Çα«░α»ìα«òα«│α»ì?', 'chatbot');

COMMENT ON TABLE candidates IS 'Stores candidate information from all sources';
COMMENT ON TABLE cv_files IS 'Stores CV file references and parsed data';
COMMENT ON TABLE jobs IS 'Job listings with requirements and tolerances';
COMMENT ON TABLE applications IS 'Links candidates to jobs with screening status';
COMMENT ON TABLE communications IS 'All communication history across channels';
COMMENT ON TABLE users IS 'System users (recruiters, admins)';
COMMENT ON TABLE interview_schedules IS 'Interview scheduling and tracking';
COMMENT ON TABLE transfer_requests IS 'Candidate transfer requests between jobs';
COMMENT ON TABLE audit_logs IS 'Security and compliance audit trail';
COMMENT ON TABLE translations IS 'Multilingual content storage';
COMMENT ON TABLE notification_queue IS 'Queued notifications for sending';
~~~

Current code:
~~~
-- Recruitment System Database Schema
-- PostgreSQL 14+

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- For fuzzy text matching

-- ===============================================
-- CANDIDATES TABLE
-- ===============================================
CREATE TABLE candidates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    phone TEXT UNIQUE NOT NULL,
    email TEXT,
    source TEXT NOT NULL, -- 'whatsapp', 'email', 'messenger', 'phone', 'walkin', 'web'
    preferred_language TEXT DEFAULT 'en', -- 'en', 'si', 'ta'
    status TEXT DEFAULT 'new', -- 'new', 'screening', 'interview', 'hired', 'rejected', 'future_pool'
    conversation_stage TEXT DEFAULT 'new', -- 'new', 'responding', 'cv_sent', 'completed', 'dropped'
    cv_uploaded BOOLEAN DEFAULT false,
    full_name TEXT,
    cv_status TEXT DEFAULT 'missing', -- 'missing', 'uploaded', 'processing', 'parsed', 'failed'
    last_interaction TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_contact_at TIMESTAMP,
    notes TEXT,
    tags TEXT[], -- Array of tags like ['urgent', 'excellent_english', 'height_borderline']
    metadata JSONB DEFAULT '{}'::jsonb
);

-- Indexes for performance
CREATE INDEX idx_candidates_phone ON candidates(phone);
CREATE INDEX idx_candidates_email ON candidates(email);
CREATE INDEX idx_candidates_status ON candidates(status);
CREATE INDEX idx_candidates_source ON candidates(source);
CREATE INDEX idx_candidates_created_at ON candidates(created_at DESC);
CREATE INDEX idx_candidates_name_trgm ON candidates USING gin(name gin_trgm_ops);
CREATE INDEX idx_candidates_conversation_stage ON candidates(conversation_stage);
CREATE INDEX idx_candidates_last_interaction ON candidates(last_interaction DESC);

-- ===============================================
-- CV_FILES TABLE
-- ===============================================
CREATE TABLE cv_files (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    file_url TEXT NOT NULL,
    file_name TEXT,
    file_size INTEGER,
    file_type TEXT, -- 'pdf', 'doc', 'docx', 'image'
    ocr_status TEXT DEFAULT 'pending', -- 'pending', 'processing', 'completed', 'failed'
    ocr_text TEXT,
    parsed_data JSONB DEFAULT '{}'::jsonb, -- Structured extraction from LLM
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP,
    is_primary BOOLEAN DEFAULT false
);

CREATE INDEX idx_cv_files_candidate ON cv_files(candidate_id);
CREATE INDEX idx_cv_files_ocr_status ON cv_files(ocr_status);

-- ===============================================
-- JOBS TABLE
-- ===============================================
CREATE TABLE jobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title TEXT NOT NULL,
    category TEXT NOT NULL, -- 'security', 'hospitality', 'manufacturing', etc.
    description TEXT,
    requirements JSONB NOT NULL DEFAULT '{}'::jsonb, -- Min/max criteria
    wiggle_room JSONB DEFAULT '{}'::jsonb, -- Tolerance settings
    status TEXT DEFAULT 'active', -- 'active', 'paused', 'closed', 'filled'
    positions_available INTEGER DEFAULT 1,
    positions_filled INTEGER DEFAULT 0,
    salary_range TEXT,
    location TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by UUID, -- Reference to users table
    deadline DATE
);

CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_category ON jobs(category);
CREATE INDEX idx_jobs_created_at ON jobs(created_at DESC);

-- ===============================================
-- PROJECTS TABLE
-- ===============================================
CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title TEXT NOT NULL,
    client_name TEXT NOT NULL,
    industry_type TEXT NOT NULL, -- 'Hypermarket', 'Restaurant', 'Construction', 'Healthcare', 'Hospitality', etc.
    description TEXT,
    countries JSONB NOT NULL DEFAULT '[]'::jsonb, -- ['UAE', 'Qatar', 'Oman', 'Bahrain', 'Saudi Arabia', 'Kuwait']
    country_of_recruitment JSONB NOT NULL DEFAULT '[]'::jsonb,
    status TEXT DEFAULT 'planning', -- 'planning', 'active', 'on_hold', 'completed', 'cancelled'
    priority TEXT DEFAULT 'normal', -- 'normal', 'high', 'urgent'
    total_positions INTEGER DEFAULT 0,
    filled_positions INTEGER DEFAULT 0,
    start_date DATE,
    interview_date DATE,
    end_date DATE,
    currency TEXT,
    benefits JSONB DEFAULT '{}'::jsonb, -- { accommodation: true, transport: true, meals: true, visa: true, ticket: true }
    salary_info JSONB DEFAULT '{}'::jsonb, -- { min: 1500, max: 2000, currency: 'AED' }
    client_details JSONB DEFAULT '{}'::jsonb,
    contact_info JSONB DEFAULT '{}'::jsonb, -- { whatsapp: '', email: '', address: '' }
    requirements JSONB DEFAULT '{}'::jsonb, -- Project-specific requirements
    metadata JSONB DEFAULT '{}'::jsonb,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_projects_status ON projects(status);
CREATE INDEX idx_projects_priority ON projects(priority);
CREATE INDEX idx_projects_client_name ON projects(client_name);
CREATE INDEX idx_projects_interview_date ON projects(interview_date);
CREATE INDEX idx_projects_created_at ON projects(created_at DESC);
CREATE INDEX idx_projects_industry ON projects(industry_type);
CREATE INDEX idx_projects_country_of_recruitment ON projects USING gin(country_of_recruitment);

-- ===============================================
-- PROJECT_ASSIGNMENTS TABLE (User-Project Mapping)
-- ===============================================
CREATE TABLE project_assignments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL, -- 'owner', 'handler', 'agent', 'officer'
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    assigned_by UUID REFERENCES users(id)
);

CREATE UNIQUE INDEX idx_project_assignments_unique ON project_assignments(project_id, user_id, role);
CREATE INDEX idx_project_assignments_project ON project_assignments(project_id);
CREATE INDEX idx_project_assignments_user ON project_assignments(user_id);

-- Add project_id to jobs table (REQUIRED - Jobs must belong to a project)
ALTER TABLE jobs ADD COLUMN project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT;
CREATE INDEX idx_jobs_project ON jobs(project_id);

-- ===============================================
-- APPLICATIONS TABLE
-- ===============================================
CREATE TABLE applications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    status TEXT DEFAULT 'applied', -- 'applied', 'screening', 'certified', 'interview_scheduled', 'interviewed', 'selected', 'rejected', 'placed'
    match_score DECIMAL(3,2), -- 0.00 to 1.00
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    certified_at TIMESTAMP,
    certified_by UUID, -- Reference to users table
    interview_datetime TIMESTAMP,
    interview_location TEXT,
    interview_notes TEXT,
    rejection_reason TEXT,
    alternative_jobs_suggested UUID[], -- Array of job IDs
    metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX idx_applications_candidate ON applications(candidate_id);
CREATE INDEX idx_applications_job ON applications(job_id);
CREATE INDEX idx_applications_status ON applications(status);
CREATE INDEX idx_applications_match_score ON applications(match_score DESC);
CREATE INDEX idx_applications_applied_at ON applications(applied_at DESC);
CREATE INDEX idx_applications_filter_combo ON applications(status, job_id, applied_at DESC);
CREATE UNIQUE INDEX idx_applications_unique ON applications(candidate_id, job_id);

-- ===============================================
-- COMMUNICATIONS TABLE
-- ===============================================
CREATE TABLE communications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    channel TEXT NOT NULL, -- 'whatsapp', 'messenger', 'email', 'sms', 'phone', 'in_person'
    direction TEXT NOT NULL, -- 'inbound', 'outbound'
    message_type TEXT, -- 'text', 'voice', 'document', 'image'
    content TEXT,
    metadata JSONB DEFAULT '{}'::jsonb, -- Store additional data like call duration, message IDs, etc.
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    delivered_at TIMESTAMP,
    read_at TIMESTAMP,
    responded_at TIMESTAMP,
    sent_by UUID, -- Reference to users table (for outbound)
    call_recording_url TEXT,
    attachments TEXT[] -- Array of file URLs
);

CREATE INDEX idx_communications_candidate ON communications(candidate_id);
CREATE INDEX idx_communications_channel ON communications(channel);
CREATE INDEX idx_communications_sent_at ON communications(sent_at DESC);

-- ===============================================
-- USERS TABLE (Recruiters/Handlers)
-- ===============================================
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name TEXT NOT NULL,
    role TEXT DEFAULT 'recruiter', -- 'admin', 'recruiter', 'supervisor'
    phone TEXT,
    is_active BOOLEAN DEFAULT true,
    assigned_jobs UUID[], -- Array of job IDs
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMP,
    metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);

-- ===============================================
-- INTERVIEW_SCHEDULES TABLE
-- ===============================================
CREATE TABLE interview_schedules (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    scheduled_datetime TIMESTAMP NOT NULL,
    location TEXT,
    interviewer_id UUID REFERENCES users(id),
    duration_minutes INTEGER DEFAULT 30,
    status TEXT DEFAULT 'scheduled', -- 'scheduled', 'confirmed', 'completed', 'cancelled', 'no_show'
    confirmation_sent_at TIMESTAMP,
    reminder_sent_at TIMESTAMP,
    completed_at TIMESTAMP,
    feedback TEXT,
    rating INTEGER, -- 1-5 scale
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by UUID REFERENCES users(id)
);

CREATE INDEX idx_interview_schedules_application ON interview_schedules(application_id);
CREATE INDEX idx_interview_schedules_datetime ON interview_schedules(scheduled_datetime);
CREATE INDEX idx_interview_schedules_status ON interview_schedules(status);

-- ===============================================
-- TRANSFER_REQUESTS TABLE
-- ===============================================
CREATE TABLE transfer_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    from_job_id UUID REFERENCES jobs(id),
    to_job_id UUID NOT NULL REFERENCES jobs(id),
    requested_by UUID NOT NULL REFERENCES users(id),
    reason TEXT NOT NULL,
    status TEXT DEFAULT 'pending', -- 'pending', 'approved', 'rejected'
    reviewed_by UUID REFERENCES users(id),
    reviewed_at TIMESTAMP,
    review_notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_transfer_requests_candidate ON transfer_requests(candidate_id);
CREATE INDEX idx_transfer_requests_status ON transfer_requests(status);

-- ===============================================
-- AUDIT_LOGS TABLE
-- ===============================================
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id),
    action TEXT NOT NULL, -- 'create', 'update', 'delete', 'view', 'export'
    entity_type TEXT NOT NULL, -- 'candidate', 'job', 'application', etc.
    entity_id UUID,
    changes JSONB, -- Store old and new values
    ip_address TEXT,
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);

-- ===============================================
-- TRANSLATIONS TABLE
-- ===============================================
CREATE TABLE translations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    key TEXT NOT NULL,
    language TEXT NOT NULL, -- 'en', 'si', 'ta'
    value TEXT NOT NULL,
    context TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(key, language)
);

CREATE INDEX idx_translations_key ON translations(key);
CREATE INDEX idx_translations_language ON translations(language);

-- ===============================================
-- NOTIFICATION_QUEUE TABLE
-- ===============================================
CREATE TABLE notification_queue (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    channel TEXT NOT NULL, -- 'whatsapp', 'sms', 'email'
    template TEXT NOT NULL,
    variables JSONB DEFAULT '{}'::jsonb,
    scheduled_for TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'pending', -- 'pending', 'sent', 'failed', 'cancelled'
    sent_at TIMESTAMP,
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    max_retries INTEGER DEFAULT 3,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_notification_queue_status ON notification_queue(status);
CREATE INDEX idx_notification_queue_scheduled ON notification_queue(scheduled_for);

-- ===============================================
-- FUNCTIONS AND TRIGGERS
-- ===============================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for updated_at
CREATE TRIGGER update_candidates_updated_at BEFORE UPDATE ON candidates
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_jobs_updated_at BEFORE UPDATE ON jobs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Function to check for duplicate candidates
CREATE OR REPLACE FUNCTION check_duplicate_candidate()
RETURNS TRIGGER AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM candidates 
        WHERE (phone = NEW.phone OR email = NEW.email) 
        AND id != NEW.id
    ) THEN
        RAISE EXCEPTION 'Duplicate candidate with same phone or email exists';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER check_duplicate_before_insert BEFORE INSERT ON candidates
    FOR EACH ROW EXECUTE FUNCTION check_duplicate_candidate();

-- ===============================================
-- SAMPLE DATA FOR TESTING
-- ===============================================

-- Insert sample job categories
INSERT INTO jobs (title, category, requirements, wiggle_room, status, positions_available) VALUES
('Security Guard - Dubai', 'security', 
    '{"min_height_cm": 170, "max_height_cm": 190, "required_languages": ["English"], "min_age": 21, "max_age": 45, "licenses": ["security_license"]}'::jsonb,
    '{"height_tolerance_cm": 5, "age_tolerance_years": 2}'::jsonb,
    'active', 10
),
('Hospitality Staff - Qatar', 'hospitality',
    '{"min_height_cm": 160, "required_languages": ["English"], "min_age": 21, "max_age": 40, "experience_years": 2}'::jsonb,
    '{"height_tolerance_cm": 3, "experience_tolerance_years": 1}'::jsonb,
    'active', 5
),
('Factory Worker - Saudi Arabia', 'manufacturing',
    '{"required_languages": ["English"], "min_age": 21, "max_age": 45}'::jsonb,
    '{"age_tolerance_years": 3}'::jsonb,
    'active', 20
);

-- Insert sample translations
INSERT INTO translations (key, language, value, context) VALUES
('greeting', 'en', 'Hello! Welcome to our recruitment agency.', 'chatbot'),
('greeting', 'si', 'à¶†à¶ºà·”à¶¶à·à·€à¶±à·Š! à¶…à¶´à¶œà·š à¶»à·à¶šà·’à¶ºà· à¶±à·’à¶ºà·à¶¢à·’à¶­à·à¶ºà¶­à¶±à¶º à·€à·™à¶­ à·ƒà·à¶¯à¶»à¶ºà·™à¶±à·Š à¶´à·’à·…à·’à¶œà¶±à·’à¶¸à·”.', 'chatbot'),
('greeting', 'ta', 'à®µà®£à®•à¯à®•à®®à¯! à®Žà®™à¯à®•à®³à¯ à®†à®Ÿà¯à®šà¯‡à®°à¯à®ªà¯à®ªà¯ à®¨à®¿à®±à¯à®µà®©à®¤à¯à®¤à®¿à®±à¯à®•à¯ à®µà®°à®µà¯‡à®±à¯à®•à®¿à®±à¯‹à®®à¯.', 'chatbot'),
('ask_name', 'en', 'What is your name?', 'chatbot'),
('ask_name', 'si', 'à¶”à¶¶à·š à¶±à¶¸ à¶šà·”à¶¸à¶šà·Šà¶¯?', 'chatbot'),
('ask_name', 'ta', 'à®‰à®™à¯à®•à®³à¯ à®ªà¯†à®¯à®°à¯ à®Žà®©à¯à®©?', 'chatbot'),
('ask_position', 'en', 'Which position are you interested in?', 'chatbot'),
('ask_position', 'si', 'à¶”à¶¶ à¶šà·à¶¸à¶­à·’ à¶»à·à¶šà·’à¶ºà·à·€ à¶šà·”à¶¸à¶šà·Šà¶¯?', 'chatbot'),
('ask_position', 'ta', 'à®¨à¯€à®™à¯à®•à®³à¯ à®Žà®¨à¯à®¤ à®µà¯‡à®²à¯ˆà®•à¯à®•à¯ à®†à®°à¯à®µà®®à®¾à®• à®‰à®³à¯à®³à¯€à®°à¯à®•à®³à¯?', 'chatbot');

COMMENT ON TABLE candidates IS 'Stores candidate information from all sources';
COMMENT ON TABLE cv_files IS 'Stores CV file references and parsed data';
COMMENT ON TABLE jobs IS 'Job listings with requirements and tolerances';
COMMENT ON TABLE applications IS 'Links candidates to jobs with screening status';
COMMENT ON TABLE communications IS 'All communication history across channels';
COMMENT ON TABLE users IS 'System users (recruiters, admins)';
COMMENT ON TABLE interview_schedules IS 'Interview scheduling and tracking';
COMMENT ON TABLE transfer_requests IS 'Candidate transfer requests between jobs';
COMMENT ON TABLE audit_logs IS 'Security and compliance audit trail';
COMMENT ON TABLE translations IS 'Multilingual content storage';
COMMENT ON TABLE notification_queue IS 'Queued notifications for sending';

~~~

## recruitment-system/database/schema-mysql.sql

Previous code:
~~~
-- Recruitment System Database Schema (MySQL 8.0+)
-- Converted from PostgreSQL for Serverbyt MySQL hosting

-- ===============================================
-- TENANTS TABLE (Multi-tenancy for SaaS)
-- ===============================================
CREATE TABLE IF NOT EXISTS tenants (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    name VARCHAR(255) NOT NULL,
    subdomain VARCHAR(100) UNIQUE NOT NULL,
    email VARCHAR(255) NOT NULL,
    plan VARCHAR(50) DEFAULT 'basic',
    status VARCHAR(50) DEFAULT 'active',
    settings JSON DEFAULT ('{}'),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ===============================================
-- CANDIDATES TABLE
-- ===============================================
CREATE TABLE IF NOT EXISTS candidates (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36),
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255),
    source VARCHAR(50) NOT NULL COMMENT 'whatsapp, email, messenger, phone, walkin, web',
    preferred_language VARCHAR(10) DEFAULT 'en' COMMENT 'en, si, ta',
    status VARCHAR(50) DEFAULT 'new' COMMENT 'new, screening, interview, hired, rejected, future_pool',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    last_contact_at TIMESTAMP NULL,
    notes TEXT,
    tags JSON DEFAULT ('[]'),
    metadata JSON DEFAULT ('{}'),
    FULLTEXT INDEX idx_candidates_name (name),
    INDEX idx_candidates_phone (phone),
    INDEX idx_candidates_status (status),
    INDEX idx_candidates_source (source),
    INDEX idx_candidates_tenant (tenant_id),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL
);

-- ===============================================
-- CV_FILES TABLE
-- ===============================================
CREATE TABLE IF NOT EXISTS cv_files (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36),
    candidate_id CHAR(36) NOT NULL,
    file_url TEXT NOT NULL,
    file_name VARCHAR(255),
    file_size INT,
    file_type VARCHAR(50) COMMENT 'pdf, doc, docx, image',
    ocr_status VARCHAR(50) DEFAULT 'pending' COMMENT 'pending, processing, completed, failed',
    ocr_text LONGTEXT,
    parsed_data JSON DEFAULT ('{}'),
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP NULL,
    is_primary BOOLEAN DEFAULT FALSE,
    FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE,
    INDEX idx_cv_candidate (candidate_id),
    INDEX idx_cv_ocr_status (ocr_status)
);

-- ===============================================
-- JOBS TABLE
-- ===============================================
CREATE TABLE IF NOT EXISTS jobs (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36),
    title VARCHAR(255) NOT NULL,
    category VARCHAR(100) NOT NULL COMMENT 'security, hospitality, manufacturing, etc.',
    description TEXT,
    requirements JSON NOT NULL DEFAULT ('{}'),
    wiggle_room JSON DEFAULT ('{}'),
    status VARCHAR(50) DEFAULT 'active' COMMENT 'active, paused, closed, filled',
    positions_available INT DEFAULT 1,
    positions_filled INT DEFAULT 0,
    salary_range VARCHAR(100),
    location VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_by CHAR(36),
    deadline DATE,
    project_id CHAR(36) NOT NULL,
    INDEX idx_jobs_status (status),
    INDEX idx_jobs_category (category),
    INDEX idx_jobs_tenant (tenant_id),
    INDEX idx_jobs_project (project_id),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL
);

-- ===============================================
-- PROJECTS TABLE
-- ===============================================
CREATE TABLE IF NOT EXISTS projects (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36),
    title VARCHAR(255) NOT NULL,
    client_name VARCHAR(255) NOT NULL,
    industry_type VARCHAR(100) NOT NULL COMMENT 'Hypermarket, Restaurant, Construction, Healthcare, Hospitality, etc.',
    description TEXT,
    countries JSON NOT NULL DEFAULT ('[]'),
    status VARCHAR(50) DEFAULT 'planning' COMMENT 'planning, active, on_hold, completed, cancelled',
    priority VARCHAR(50) DEFAULT 'normal' COMMENT 'normal, high, urgent',
    total_positions INT DEFAULT 0,
    filled_positions INT DEFAULT 0,
    start_date DATE,
    interview_date DATE,
    end_date DATE,
    benefits JSON DEFAULT ('{}'),
    salary_info JSON DEFAULT ('{}'),
    contact_info JSON DEFAULT ('{}'),
    requirements JSON DEFAULT ('{}'),
    metadata JSON DEFAULT ('{}'),
    created_by CHAR(36),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_projects_status (status),
    INDEX idx_projects_priority (priority),
    INDEX idx_projects_client_name (client_name),
    INDEX idx_projects_interview_date (interview_date),
    INDEX idx_projects_industry (industry_type),
    INDEX idx_projects_tenant (tenant_id),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL
);

-- ===============================================
-- PROJECT_ASSIGNMENTS TABLE (User-Project Mapping)
-- ===============================================
CREATE TABLE IF NOT EXISTS project_assignments (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36),
    project_id CHAR(36) NOT NULL,
    user_id CHAR(36) NOT NULL,
    role VARCHAR(50) NOT NULL COMMENT 'owner, handler, agent, officer',
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    assigned_by CHAR(36),
    UNIQUE KEY unique_project_user_role (project_id, user_id, role),
    INDEX idx_proj_assign_project (project_id),
    INDEX idx_proj_assign_user (user_id),
    INDEX idx_proj_assign_tenant (tenant_id),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL
);

-- Add foreign key for jobs.project_id (REQUIRED - Jobs must belong to a project)
ALTER TABLE jobs ADD CONSTRAINT fk_jobs_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT;

-- ===============================================
-- APPLICATIONS TABLE
-- ===============================================
CREATE TABLE IF NOT EXISTS applications (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36),
    candidate_id CHAR(36) NOT NULL,
    job_id CHAR(36) NOT NULL,
    status VARCHAR(50) DEFAULT 'applied' COMMENT 'applied, screening, certified, interview_scheduled, interviewed, selected, rejected, placed',
    match_score DECIMAL(5,2),
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    certified_at TIMESTAMP NULL,
    certified_by CHAR(36),
    interview_datetime TIMESTAMP NULL,
    interview_location TEXT,
    interview_notes TEXT,
    rejection_reason TEXT,
    alternative_jobs_suggested JSON DEFAULT ('[]'),
    metadata JSON DEFAULT ('{}'),
    FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE,
    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
    UNIQUE KEY unique_application (candidate_id, job_id),
    INDEX idx_app_candidate (candidate_id),
    INDEX idx_app_job (job_id),
    INDEX idx_app_status (status),
    INDEX idx_app_match_score (match_score),
    INDEX idx_app_tenant (tenant_id)
);

-- ===============================================
-- USERS TABLE (Recruiters/Handlers)
-- ===============================================
CREATE TABLE IF NOT EXISTS users (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    role VARCHAR(50) DEFAULT 'recruiter' COMMENT 'admin, recruiter, supervisor',
    phone VARCHAR(50),
    is_active BOOLEAN DEFAULT TRUE,
    assigned_jobs JSON DEFAULT ('[]'),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMP NULL,
    metadata JSON DEFAULT ('{}'),
    INDEX idx_users_email (email),
    INDEX idx_users_role (role),
    INDEX idx_users_tenant (tenant_id),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL
);

-- ===============================================
-- COMMUNICATIONS TABLE
-- ===============================================
CREATE TABLE IF NOT EXISTS communications (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36),
    candidate_id CHAR(36) NOT NULL,
    channel VARCHAR(50) NOT NULL COMMENT 'whatsapp, messenger, email, sms, phone, in_person',
    direction VARCHAR(20) NOT NULL COMMENT 'inbound, outbound',
    message_type VARCHAR(50) COMMENT 'text, voice, document, image',
    content TEXT,
    metadata JSON DEFAULT ('{}'),
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    delivered_at TIMESTAMP NULL,
    read_at TIMESTAMP NULL,
    responded_at TIMESTAMP NULL,
    sent_by CHAR(36),
    call_recording_url TEXT,
    attachments JSON DEFAULT ('[]'),
    FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE,
    INDEX idx_comm_candidate (candidate_id),
    INDEX idx_comm_channel (channel),
    INDEX idx_comm_sent_at (sent_at),
    INDEX idx_comm_tenant (tenant_id)
);

-- ===============================================
-- INTERVIEW_SCHEDULES TABLE
-- ===============================================
CREATE TABLE IF NOT EXISTS interview_schedules (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36),
    application_id CHAR(36) NOT NULL,
    scheduled_datetime TIMESTAMP NOT NULL,
    location TEXT,
    interviewer_id CHAR(36),
    duration_minutes INT DEFAULT 30,
    status VARCHAR(50) DEFAULT 'scheduled' COMMENT 'scheduled, confirmed, completed, cancelled, no_show',
    confirmation_sent_at TIMESTAMP NULL,
    reminder_sent_at TIMESTAMP NULL,
    completed_at TIMESTAMP NULL,
    feedback TEXT,
    rating INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by CHAR(36),
    FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE,
    INDEX idx_interview_app (application_id),
    INDEX idx_interview_datetime (scheduled_datetime),
    INDEX idx_interview_status (status)
);

-- ===============================================
-- TRANSFER_REQUESTS TABLE
-- ===============================================
CREATE TABLE IF NOT EXISTS transfer_requests (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36),
    candidate_id CHAR(36) NOT NULL,
    from_job_id CHAR(36),
    to_job_id CHAR(36) NOT NULL,
    requested_by CHAR(36) NOT NULL,
    reason TEXT NOT NULL,
    status VARCHAR(50) DEFAULT 'pending' COMMENT 'pending, approved, rejected',
    reviewed_by CHAR(36),
    reviewed_at TIMESTAMP NULL,
    review_notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE,
    INDEX idx_transfer_candidate (candidate_id),
    INDEX idx_transfer_status (status)
);

-- ===============================================
-- AUDIT_LOGS TABLE
-- ===============================================
CREATE TABLE IF NOT EXISTS audit_logs (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36),
    user_id CHAR(36),
    action VARCHAR(100) NOT NULL COMMENT 'create, update, delete, view, export',
    entity_type VARCHAR(50) NOT NULL COMMENT 'candidate, job, application, etc.',
    entity_id CHAR(36),
    changes JSON,
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_audit_user (user_id),
    INDEX idx_audit_entity (entity_type, entity_id),
    INDEX idx_audit_created_at (created_at)
);

-- ===============================================
-- TRANSLATIONS TABLE
-- ===============================================
CREATE TABLE IF NOT EXISTS translations (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    `key` VARCHAR(255) NOT NULL,
    language VARCHAR(10) NOT NULL COMMENT 'en, si, ta',
    value TEXT NOT NULL,
    context VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_translation (`key`, language),
    INDEX idx_translations_key (`key`)
);

-- ===============================================
-- NOTIFICATION_QUEUE TABLE
-- ===============================================
CREATE TABLE IF NOT EXISTS notification_queue (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36),
    candidate_id CHAR(36) NOT NULL,
    channel VARCHAR(50) NOT NULL COMMENT 'whatsapp, sms, email',
    template VARCHAR(100) NOT NULL,
    variables JSON DEFAULT ('{}'),
    scheduled_for TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(50) DEFAULT 'pending' COMMENT 'pending, sent, failed, cancelled',
    sent_at TIMESTAMP NULL,
    error_message TEXT,
    retry_count INT DEFAULT 0,
    max_retries INT DEFAULT 3,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE,
    INDEX idx_notif_status (status),
    INDEX idx_notif_scheduled (scheduled_for)
);

-- ===============================================
-- SAMPLE DATA FOR TESTING
-- ===============================================

-- Insert default tenant
INSERT INTO tenants (id, name, subdomain, email, plan) VALUES
(UUID(), 'Demo Company', 'demo', 'admin@demo.com', 'basic');

-- Insert sample jobs
INSERT INTO jobs (id, title, category, requirements, wiggle_room, status, positions_available) VALUES
(UUID(), 'Security Guard - Dubai', 'security', 
    '{"min_height_cm": 170, "max_height_cm": 190, "required_languages": ["English"], "min_age": 21, "max_age": 45, "licenses": ["security_license"]}',
    '{"height_tolerance_cm": 5, "age_tolerance_years": 2}',
    'active', 10
),
(UUID(), 'Hospitality Staff - Qatar', 'hospitality',
    '{"min_height_cm": 160, "required_languages": ["English"], "min_age": 21, "max_age": 40, "experience_years": 2}',
    '{"height_tolerance_cm": 3, "experience_tolerance_years": 1}',
    'active', 5
),
(UUID(), 'Factory Worker - Saudi Arabia', 'manufacturing',
    '{"required_languages": ["English"], "min_age": 21, "max_age": 45}',
    '{"age_tolerance_years": 3}',
    'active', 20
);

-- Insert sample translations
INSERT INTO translations (`key`, language, value, context) VALUES
('greeting', 'en', 'Hello! Welcome to our recruitment agency.', 'chatbot'),
('greeting', 'si', 'α╢åα╢║α╖öα╢╢α╖¥α╖Çα╢▒α╖è! α╢àα╢┤α╢£α╖Ü α╢╗α╖Éα╢Üα╖Æα╢║α╖Å α╢▒α╖Æα╢║α╖¥α╢óα╖Æα╢¡α╖Åα╢║α╢¡α╢▒α╢║ α╖Çα╖Öα╢¡ α╖âα╖Åα╢»α╢╗α╢║α╖Öα╢▒α╖è α╢┤α╖Æα╖àα╖Æα╢£α╢▒α╖Æα╢╕α╖ö.', 'chatbot'),
('greeting', 'ta', 'α«╡α«úα«òα»ìα«òα««α»ì! α«Äα«Öα»ìα«òα«│α»ì α«åα«ƒα»ìα«Üα»çα«░α»ìα«¬α»ìα«¬α»ü α«¿α«┐α«▒α»üα«╡α«⌐α«ñα»ìα«ñα«┐α«▒α»ìα«òα»ü α«╡α«░α«╡α»çα«▒α»ìα«òα«┐α«▒α»ïα««α»ì.', 'chatbot'),
('ask_name', 'en', 'What is your name?', 'chatbot'),
('ask_name', 'si', 'α╢öα╢╢α╖Ü α╢▒α╢╕ α╢Üα╖öα╢╕α╢Üα╖èα╢»?', 'chatbot'),
('ask_name', 'ta', 'α«ëα«Öα»ìα«òα«│α»ì α«¬α»åα«»α«░α»ì α«Äα«⌐α»ìα«⌐?', 'chatbot'),
('ask_position', 'en', 'Which position are you interested in?', 'chatbot'),
('ask_position', 'si', 'α╢öα╢╢ α╢Üα╖Éα╢╕α╢¡α╖Æ α╢╗α╖Éα╢Üα╖Æα╢║α╖Åα╖Ç α╢Üα╖öα╢╕α╢Üα╖èα╢»?', 'chatbot'),
('ask_position', 'ta', 'α«¿α»Çα«Öα»ìα«òα«│α»ì α«Äα«¿α»ìα«ñ α«╡α»çα«▓α»êα«òα»ìα«òα»ü α«åα«░α»ìα«╡α««α«╛α«ò α«ëα«│α»ìα«│α»Çα«░α»ìα«òα«│α»ì?', 'chatbot');
~~~

Current code:
~~~
-- Recruitment System Database Schema (MySQL 8.0+)
-- Converted from PostgreSQL for Serverbyt MySQL hosting

-- ===============================================
-- TENANTS TABLE (Multi-tenancy for SaaS)
-- ===============================================
CREATE TABLE IF NOT EXISTS tenants (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    name VARCHAR(255) NOT NULL,
    subdomain VARCHAR(100) UNIQUE NOT NULL,
    email VARCHAR(255) NOT NULL,
    plan VARCHAR(50) DEFAULT 'basic',
    status VARCHAR(50) DEFAULT 'active',
    settings JSON DEFAULT ('{}'),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- ===============================================
-- CANDIDATES TABLE
-- ===============================================
CREATE TABLE IF NOT EXISTS candidates (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36),
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255),
    source VARCHAR(50) NOT NULL COMMENT 'whatsapp, email, messenger, phone, walkin, web',
    preferred_language VARCHAR(10) DEFAULT 'en' COMMENT 'en, si, ta',
    status VARCHAR(50) DEFAULT 'new' COMMENT 'new, screening, interview, hired, rejected, future_pool',
    conversation_stage VARCHAR(50) DEFAULT 'new' COMMENT 'new, responding, cv_sent, completed, dropped',
    cv_uploaded BOOLEAN DEFAULT FALSE,
    full_name VARCHAR(255),
    cv_status VARCHAR(50) DEFAULT 'missing' COMMENT 'missing, uploaded, processing, parsed, failed',
    last_interaction TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    last_contact_at TIMESTAMP NULL,
    notes TEXT,
    tags JSON DEFAULT ('[]'),
    metadata JSON DEFAULT ('{}'),
    FULLTEXT INDEX idx_candidates_name (name),
    INDEX idx_candidates_phone (phone),
    INDEX idx_candidates_status (status),
    INDEX idx_candidates_source (source),
    INDEX idx_candidates_conversation_stage (conversation_stage),
    INDEX idx_candidates_last_interaction (last_interaction),
    INDEX idx_candidates_tenant (tenant_id),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL
);

-- ===============================================
-- CV_FILES TABLE
-- ===============================================
CREATE TABLE IF NOT EXISTS cv_files (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36),
    candidate_id CHAR(36) NOT NULL,
    file_url TEXT NOT NULL,
    file_name VARCHAR(255),
    file_size INT,
    file_type VARCHAR(50) COMMENT 'pdf, doc, docx, image',
    ocr_status VARCHAR(50) DEFAULT 'pending' COMMENT 'pending, processing, completed, failed',
    ocr_text LONGTEXT,
    parsed_data JSON DEFAULT ('{}'),
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMP NULL,
    is_primary BOOLEAN DEFAULT FALSE,
    FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE,
    INDEX idx_cv_candidate (candidate_id),
    INDEX idx_cv_ocr_status (ocr_status)
);

-- ===============================================
-- JOBS TABLE
-- ===============================================
CREATE TABLE IF NOT EXISTS jobs (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36),
    title VARCHAR(255) NOT NULL,
    category VARCHAR(100) NOT NULL COMMENT 'security, hospitality, manufacturing, etc.',
    description TEXT,
    requirements JSON NOT NULL DEFAULT ('{}'),
    wiggle_room JSON DEFAULT ('{}'),
    status VARCHAR(50) DEFAULT 'active' COMMENT 'active, paused, closed, filled',
    positions_available INT DEFAULT 1,
    positions_filled INT DEFAULT 0,
    salary_range VARCHAR(100),
    location VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_by CHAR(36),
    deadline DATE,
    project_id CHAR(36) NOT NULL,
    INDEX idx_jobs_status (status),
    INDEX idx_jobs_category (category),
    INDEX idx_jobs_tenant (tenant_id),
    INDEX idx_jobs_project (project_id),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL
);

-- ===============================================
-- PROJECTS TABLE
-- ===============================================
CREATE TABLE IF NOT EXISTS projects (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36),
    title VARCHAR(255) NOT NULL,
    client_name VARCHAR(255) NOT NULL,
    industry_type VARCHAR(100) NOT NULL COMMENT 'Hypermarket, Restaurant, Construction, Healthcare, Hospitality, etc.',
    description TEXT,
    countries JSON NOT NULL DEFAULT ('[]'),
    country_of_recruitment JSON NOT NULL DEFAULT ('[]'),
    status VARCHAR(50) DEFAULT 'planning' COMMENT 'planning, active, on_hold, completed, cancelled',
    priority VARCHAR(50) DEFAULT 'normal' COMMENT 'normal, high, urgent',
    total_positions INT DEFAULT 0,
    filled_positions INT DEFAULT 0,
    start_date DATE,
    interview_date DATE,
    end_date DATE,
    currency VARCHAR(16),
    benefits JSON DEFAULT ('{}'),
    salary_info JSON DEFAULT ('{}'),
    client_details JSON DEFAULT ('{}'),
    contact_info JSON DEFAULT ('{}'),
    requirements JSON DEFAULT ('{}'),
    metadata JSON DEFAULT ('{}'),
    created_by CHAR(36),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_projects_status (status),
    INDEX idx_projects_priority (priority),
    INDEX idx_projects_client_name (client_name),
    INDEX idx_projects_interview_date (interview_date),
    INDEX idx_projects_industry (industry_type),
    INDEX idx_projects_tenant (tenant_id),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL
);

-- ===============================================
-- PROJECT_ASSIGNMENTS TABLE (User-Project Mapping)
-- ===============================================
CREATE TABLE IF NOT EXISTS project_assignments (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36),
    project_id CHAR(36) NOT NULL,
    user_id CHAR(36) NOT NULL,
    role VARCHAR(50) NOT NULL COMMENT 'owner, handler, agent, officer',
    assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    assigned_by CHAR(36),
    UNIQUE KEY unique_project_user_role (project_id, user_id, role),
    INDEX idx_proj_assign_project (project_id),
    INDEX idx_proj_assign_user (user_id),
    INDEX idx_proj_assign_tenant (tenant_id),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL
);

-- Add foreign key for jobs.project_id (REQUIRED - Jobs must belong to a project)
ALTER TABLE jobs ADD CONSTRAINT fk_jobs_project FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT;

-- ===============================================
-- APPLICATIONS TABLE
-- ===============================================
CREATE TABLE IF NOT EXISTS applications (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36),
    candidate_id CHAR(36) NOT NULL,
    job_id CHAR(36) NOT NULL,
    status VARCHAR(50) DEFAULT 'applied' COMMENT 'applied, screening, certified, interview_scheduled, interviewed, selected, rejected, placed',
    match_score DECIMAL(5,2),
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    certified_at TIMESTAMP NULL,
    certified_by CHAR(36),
    interview_datetime TIMESTAMP NULL,
    interview_location TEXT,
    interview_notes TEXT,
    rejection_reason TEXT,
    alternative_jobs_suggested JSON DEFAULT ('[]'),
    metadata JSON DEFAULT ('{}'),
    FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE,
    FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
    UNIQUE KEY unique_application (candidate_id, job_id),
    INDEX idx_app_candidate (candidate_id),
    INDEX idx_app_job (job_id),
    INDEX idx_app_status (status),
    INDEX idx_app_match_score (match_score),
    INDEX idx_app_applied_at (applied_at),
    INDEX idx_app_filter_combo (status, job_id, applied_at),
    INDEX idx_app_tenant (tenant_id)
);

-- ===============================================
-- USERS TABLE (Recruiters/Handlers)
-- ===============================================
CREATE TABLE IF NOT EXISTS users (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    role VARCHAR(50) DEFAULT 'recruiter' COMMENT 'admin, recruiter, supervisor',
    phone VARCHAR(50),
    is_active BOOLEAN DEFAULT TRUE,
    assigned_jobs JSON DEFAULT ('[]'),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMP NULL,
    metadata JSON DEFAULT ('{}'),
    INDEX idx_users_email (email),
    INDEX idx_users_role (role),
    INDEX idx_users_tenant (tenant_id),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL
);

-- ===============================================
-- COMMUNICATIONS TABLE
-- ===============================================
CREATE TABLE IF NOT EXISTS communications (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36),
    candidate_id CHAR(36) NOT NULL,
    channel VARCHAR(50) NOT NULL COMMENT 'whatsapp, messenger, email, sms, phone, in_person',
    direction VARCHAR(20) NOT NULL COMMENT 'inbound, outbound',
    message_type VARCHAR(50) COMMENT 'text, voice, document, image',
    content TEXT,
    metadata JSON DEFAULT ('{}'),
    sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    delivered_at TIMESTAMP NULL,
    read_at TIMESTAMP NULL,
    responded_at TIMESTAMP NULL,
    sent_by CHAR(36),
    call_recording_url TEXT,
    attachments JSON DEFAULT ('[]'),
    FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE,
    INDEX idx_comm_candidate (candidate_id),
    INDEX idx_comm_channel (channel),
    INDEX idx_comm_sent_at (sent_at),
    INDEX idx_comm_tenant (tenant_id)
);

-- ===============================================
-- INTERVIEW_SCHEDULES TABLE
-- ===============================================
CREATE TABLE IF NOT EXISTS interview_schedules (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36),
    application_id CHAR(36) NOT NULL,
    scheduled_datetime TIMESTAMP NOT NULL,
    location TEXT,
    interviewer_id CHAR(36),
    duration_minutes INT DEFAULT 30,
    status VARCHAR(50) DEFAULT 'scheduled' COMMENT 'scheduled, confirmed, completed, cancelled, no_show',
    confirmation_sent_at TIMESTAMP NULL,
    reminder_sent_at TIMESTAMP NULL,
    completed_at TIMESTAMP NULL,
    feedback TEXT,
    rating INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    created_by CHAR(36),
    FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE,
    INDEX idx_interview_app (application_id),
    INDEX idx_interview_datetime (scheduled_datetime),
    INDEX idx_interview_status (status)
);

-- ===============================================
-- TRANSFER_REQUESTS TABLE
-- ===============================================
CREATE TABLE IF NOT EXISTS transfer_requests (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36),
    candidate_id CHAR(36) NOT NULL,
    from_job_id CHAR(36),
    to_job_id CHAR(36) NOT NULL,
    requested_by CHAR(36) NOT NULL,
    reason TEXT NOT NULL,
    status VARCHAR(50) DEFAULT 'pending' COMMENT 'pending, approved, rejected',
    reviewed_by CHAR(36),
    reviewed_at TIMESTAMP NULL,
    review_notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE,
    INDEX idx_transfer_candidate (candidate_id),
    INDEX idx_transfer_status (status)
);

-- ===============================================
-- AUDIT_LOGS TABLE
-- ===============================================
CREATE TABLE IF NOT EXISTS audit_logs (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36),
    user_id CHAR(36),
    action VARCHAR(100) NOT NULL COMMENT 'create, update, delete, view, export',
    entity_type VARCHAR(50) NOT NULL COMMENT 'candidate, job, application, etc.',
    entity_id CHAR(36),
    changes JSON,
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_audit_user (user_id),
    INDEX idx_audit_entity (entity_type, entity_id),
    INDEX idx_audit_created_at (created_at)
);

-- ===============================================
-- TRANSLATIONS TABLE
-- ===============================================
CREATE TABLE IF NOT EXISTS translations (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    `key` VARCHAR(255) NOT NULL,
    language VARCHAR(10) NOT NULL COMMENT 'en, si, ta',
    value TEXT NOT NULL,
    context VARCHAR(100),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_translation (`key`, language),
    INDEX idx_translations_key (`key`)
);

-- ===============================================
-- NOTIFICATION_QUEUE TABLE
-- ===============================================
CREATE TABLE IF NOT EXISTS notification_queue (
    id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
    tenant_id CHAR(36),
    candidate_id CHAR(36) NOT NULL,
    channel VARCHAR(50) NOT NULL COMMENT 'whatsapp, sms, email',
    template VARCHAR(100) NOT NULL,
    variables JSON DEFAULT ('{}'),
    scheduled_for TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status VARCHAR(50) DEFAULT 'pending' COMMENT 'pending, sent, failed, cancelled',
    sent_at TIMESTAMP NULL,
    error_message TEXT,
    retry_count INT DEFAULT 0,
    max_retries INT DEFAULT 3,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE,
    INDEX idx_notif_status (status),
    INDEX idx_notif_scheduled (scheduled_for)
);

-- ===============================================
-- SAMPLE DATA FOR TESTING
-- ===============================================

-- Insert default tenant
INSERT INTO tenants (id, name, subdomain, email, plan) VALUES
(UUID(), 'Demo Company', 'demo', 'admin@demo.com', 'basic');

-- Insert sample jobs
INSERT INTO jobs (id, title, category, requirements, wiggle_room, status, positions_available) VALUES
(UUID(), 'Security Guard - Dubai', 'security', 
    '{"min_height_cm": 170, "max_height_cm": 190, "required_languages": ["English"], "min_age": 21, "max_age": 45, "licenses": ["security_license"]}',
    '{"height_tolerance_cm": 5, "age_tolerance_years": 2}',
    'active', 10
),
(UUID(), 'Hospitality Staff - Qatar', 'hospitality',
    '{"min_height_cm": 160, "required_languages": ["English"], "min_age": 21, "max_age": 40, "experience_years": 2}',
    '{"height_tolerance_cm": 3, "experience_tolerance_years": 1}',
    'active', 5
),
(UUID(), 'Factory Worker - Saudi Arabia', 'manufacturing',
    '{"required_languages": ["English"], "min_age": 21, "max_age": 45}',
    '{"age_tolerance_years": 3}',
    'active', 20
);

-- Insert sample translations
INSERT INTO translations (`key`, language, value, context) VALUES
('greeting', 'en', 'Hello! Welcome to our recruitment agency.', 'chatbot'),
('greeting', 'si', 'à¶†à¶ºà·”à¶¶à·à·€à¶±à·Š! à¶…à¶´à¶œà·š à¶»à·à¶šà·’à¶ºà· à¶±à·’à¶ºà·à¶¢à·’à¶­à·à¶ºà¶­à¶±à¶º à·€à·™à¶­ à·ƒà·à¶¯à¶»à¶ºà·™à¶±à·Š à¶´à·’à·…à·’à¶œà¶±à·’à¶¸à·”.', 'chatbot'),
('greeting', 'ta', 'à®µà®£à®•à¯à®•à®®à¯! à®Žà®™à¯à®•à®³à¯ à®†à®Ÿà¯à®šà¯‡à®°à¯à®ªà¯à®ªà¯ à®¨à®¿à®±à¯à®µà®©à®¤à¯à®¤à®¿à®±à¯à®•à¯ à®µà®°à®µà¯‡à®±à¯à®•à®¿à®±à¯‹à®®à¯.', 'chatbot'),
('ask_name', 'en', 'What is your name?', 'chatbot'),
('ask_name', 'si', 'à¶”à¶¶à·š à¶±à¶¸ à¶šà·”à¶¸à¶šà·Šà¶¯?', 'chatbot'),
('ask_name', 'ta', 'à®‰à®™à¯à®•à®³à¯ à®ªà¯†à®¯à®°à¯ à®Žà®©à¯à®©?', 'chatbot'),
('ask_position', 'en', 'Which position are you interested in?', 'chatbot'),
('ask_position', 'si', 'à¶”à¶¶ à¶šà·à¶¸à¶­à·’ à¶»à·à¶šà·’à¶ºà·à·€ à¶šà·”à¶¸à¶šà·Šà¶¯?', 'chatbot'),
('ask_position', 'ta', 'à®¨à¯€à®™à¯à®•à®³à¯ à®Žà®¨à¯à®¤ à®µà¯‡à®²à¯ˆà®•à¯à®•à¯ à®†à®°à¯à®µà®®à®¾à®• à®‰à®³à¯à®³à¯€à®°à¯à®•à®³à¯?', 'chatbot');

~~~

## recruitment-system/frontend/.firebase/hosting.ZGlzdA.cache

Previous code:
~~~
index.html,1774176635975,dc9b98e27ea881cc60fb38722ff83901410073aee3286fe65d46ce18fcb42564
assets/index-BvKhJpMt.js,1774176635981,c6f2f10c602a6513bc523ab7dfc7d0aba0e77b194986e5c92c922199030f7098
assets/index-BBXvAjrq.css,1774176635975,071cd05c6ed8fdfad991695abbd01c34f5f40016fafb151a029b1258fc766e3e
~~~

Current code:
~~~
index.html,1775468113005,7430dc50ec853ed077e32f5794652e9e1067c73a6ae657f278be785706cf86f1
assets/index-gIpOCRKR.css,1775468113005,b7838974b3cd850e4766b06b0e923092a48d413d525a9762e4a97ce4389f9829
assets/index-Bz7OISHn.js,1775468113005,e4baddcd8fc909a5347c48d4a93fa5e7555f5ab2ccd0b36284b88da9d0b80108

~~~

## recruitment-system/frontend/src/components/ApplicationCard.jsx

Previous code:
~~~
(File did not exist at baseline commit)
~~~

Current code:
~~~
import { Link } from 'react-router-dom'
import { Eye, PencilLine, MapPin, Briefcase } from 'lucide-react'
import { Badge } from './ui/Badge'

function parseJson(value) {
  if (!value) return {}
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch (_) {
    return {}
  }
}

export default function ApplicationCard({ application, compact = false }) {
  const candidateName = application.candidate_name || application.candidate_full_name || 'Unknown candidate'
  const candidateMeta = parseJson(application.candidate_metadata)
  const appMeta = parseJson(application.metadata)

  const country = candidateMeta.country || appMeta.country || '-'
  const experience = application.experience_years ?? candidateMeta.experience_years ?? '-'

  return (
    <article className={`application-card ${compact ? 'application-card-compact' : 'application-card-expanded'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-full bg-sky-100 text-sky-700 font-semibold flex items-center justify-center shrink-0">
            {candidateName.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <Link
              to={`/candidates/${application.candidate_id}`}
              className="text-sm font-semibold text-slate-900 hover:text-sky-700 truncate block"
            >
              {candidateName}
            </Link>
            <p className="text-xs text-slate-500 truncate">{application.candidate_phone || '-'}</p>
          </div>
        </div>
        <Badge status={application.status} className="capitalize" />
      </div>

      <div className="mt-3 space-y-1">
        <p className="text-sm text-slate-700 flex items-center gap-1.5">
          <Briefcase size={14} className="text-slate-400" />
          <span className="font-medium truncate">{application.job_title || 'Job not assigned'}</span>
        </p>
        <p className="text-xs text-slate-500 flex items-center gap-1.5">
          <MapPin size={13} className="text-slate-400" />
          Country: {country} | Experience: {experience === '-' ? '-' : `${experience} yrs`}
        </p>
        <p className="text-xs text-slate-500">
          Applied: {application.applied_at ? new Date(application.applied_at).toLocaleDateString() : '-'}
        </p>
      </div>

      <div className="mt-3 pt-3 border-t border-slate-100 flex items-center gap-4 text-xs">
        <Link to={`/candidates/${application.candidate_id}`} className="text-sky-700 hover:text-sky-800 font-medium inline-flex items-center gap-1">
          <Eye size={13} /> View
        </Link>
        <Link to={`/jobs/${application.job_id}`} className="text-emerald-700 hover:text-emerald-800 font-medium inline-flex items-center gap-1">
          <PencilLine size={13} /> Edit
        </Link>
      </div>
    </article>
  )
}

~~~

## recruitment-system/frontend/src/components/CountrySelector.jsx

Previous code:
~~~
(File did not exist at baseline commit)
~~~

Current code:
~~~
import { useMemo, useState } from 'react'
import { Search, X } from 'lucide-react'
import { ALL_COUNTRIES } from '../constants/countries'

export default function CountrySelector({ value = [], onChange }) {
  const [query, setQuery] = useState('')

  const filteredCountries = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return ALL_COUNTRIES

    return ALL_COUNTRIES
      .filter((country) => country.toLowerCase().includes(normalized))
  }, [query])

  const selected = Array.isArray(value) ? value : []

  const toggle = (country) => {
    if (selected.includes(country)) {
      onChange(selected.filter((item) => item !== country))
    } else {
      onChange([...selected, country])
    }
  }

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search countries..."
          className="input w-full pl-9"
        />
      </div>

      {selected.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {selected.map((country) => (
            <button
              key={country}
              type="button"
              onClick={() => toggle(country)}
              className="inline-flex items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-700"
            >
              {country}
              <X size={12} />
            </button>
          ))}
        </div>
      )}

      <div className="max-h-52 overflow-y-auto rounded-xl border border-gray-200 p-2 bg-white">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {filteredCountries.map((country) => {
            const active = selected.includes(country)
            return (
              <button
                key={country}
                type="button"
                onClick={() => toggle(country)}
                className={`text-left px-3 py-2 rounded-lg border text-sm transition-colors ${active
                  ? 'border-sky-400 bg-sky-50 text-sky-700'
                  : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50 text-gray-700'}`}
              >
                {country}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

~~~

## recruitment-system/frontend/src/constants/countries.js

Previous code:
~~~
(File did not exist at baseline commit)
~~~

Current code:
~~~
const FALLBACK_COUNTRIES = [
  'Afghanistan',
  'Albania',
  'Algeria',
  'Andorra',
  'Angola',
  'Antigua and Barbuda',
  'Argentina',
  'Armenia',
  'Australia',
  'Austria',
  'Azerbaijan',
  'Bahamas',
  'Bahrain',
  'Bangladesh',
  'Barbados',
  'Belarus',
  'Belgium',
  'Belize',
  'Benin',
  'Bhutan',
  'Bolivia',
  'Bosnia and Herzegovina',
  'Botswana',
  'Brazil',
  'Brunei',
  'Bulgaria',
  'Burkina Faso',
  'Burundi',
  'Cabo Verde',
  'Cambodia',
  'Cameroon',
  'Canada',
  'Central African Republic',
  'Chad',
  'Chile',
  'China',
  'Colombia',
  'Comoros',
  'Congo',
  'Costa Rica',
  "Cote d'Ivoire",
  'Croatia',
  'Cuba',
  'Cyprus',
  'Czechia',
  'Democratic Republic of the Congo',
  'Denmark',
  'Djibouti',
  'Dominica',
  'Dominican Republic',
  'Ecuador',
  'Egypt',
  'El Salvador',
  'Equatorial Guinea',
  'Eritrea',
  'Estonia',
  'Eswatini',
  'Ethiopia',
  'Fiji',
  'Finland',
  'France',
  'Gabon',
  'Gambia',
  'Georgia',
  'Germany',
  'Ghana',
  'Greece',
  'Grenada',
  'Guatemala',
  'Guinea',
  'Guinea-Bissau',
  'Guyana',
  'Haiti',
  'Honduras',
  'Hungary',
  'Iceland',
  'India',
  'Indonesia',
  'Iran',
  'Iraq',
  'Ireland',
  'Israel',
  'Italy',
  'Jamaica',
  'Japan',
  'Jordan',
  'Kazakhstan',
  'Kenya',
  'Kiribati',
  'Kuwait',
  'Kyrgyzstan',
  'Laos',
  'Latvia',
  'Lebanon',
  'Lesotho',
  'Liberia',
  'Libya',
  'Liechtenstein',
  'Lithuania',
  'Luxembourg',
  'Madagascar',
  'Malawi',
  'Malaysia',
  'Maldives',
  'Mali',
  'Malta',
  'Marshall Islands',
  'Mauritania',
  'Mauritius',
  'Mexico',
  'Micronesia',
  'Moldova',
  'Monaco',
  'Mongolia',
  'Montenegro',
  'Morocco',
  'Mozambique',
  'Myanmar',
  'Namibia',
  'Nauru',
  'Nepal',
  'Netherlands',
  'New Zealand',
  'Nicaragua',
  'Niger',
  'Nigeria',
  'North Korea',
  'North Macedonia',
  'Norway',
  'Oman',
  'Pakistan',
  'Palau',
  'Palestine',
  'Panama',
  'Papua New Guinea',
  'Paraguay',
  'Peru',
  'Philippines',
  'Poland',
  'Portugal',
  'Qatar',
  'Romania',
  'Russia',
  'Rwanda',
  'Saint Kitts and Nevis',
  'Saint Lucia',
  'Saint Vincent and the Grenadines',
  'Samoa',
  'San Marino',
  'Sao Tome and Principe',
  'Saudi Arabia',
  'Senegal',
  'Serbia',
  'Seychelles',
  'Sierra Leone',
  'Singapore',
  'Slovakia',
  'Slovenia',
  'Solomon Islands',
  'Somalia',
  'South Africa',
  'South Korea',
  'South Sudan',
  'Spain',
  'Sri Lanka',
  'Sudan',
  'Suriname',
  'Sweden',
  'Switzerland',
  'Syria',
  'Taiwan',
  'Tajikistan',
  'Tanzania',
  'Thailand',
  'Timor-Leste',
  'Togo',
  'Tonga',
  'Trinidad and Tobago',
  'Tunisia',
  'Turkey',
  'Turkmenistan',
  'Tuvalu',
  'Uganda',
  'Ukraine',
  'United Arab Emirates',
  'United Kingdom',
  'United States',
  'Uruguay',
  'Uzbekistan',
  'Vanuatu',
  'Vatican City',
  'Venezuela',
  'Vietnam',
  'Yemen',
  'Zambia',
  'Zimbabwe'
];

function getIntlCountries() {
  try {
    if (typeof Intl.supportedValuesOf !== 'function') return [];

    const regionCodes = Intl.supportedValuesOf('region');
    const displayNames = new Intl.DisplayNames(['en'], { type: 'region' });

    const disallowedCodes = new Set(['EU', 'UN']);

    const countries = regionCodes
      .filter((code) => /^[A-Z]{2}$/.test(code) && !disallowedCodes.has(code))
      .map((code) => displayNames.of(code))
      .filter((name) => typeof name === 'string' && name.trim().length > 0)
      .filter((name) => !/^unknown region$/i.test(name));

    return countries;
  } catch (_) {
    return [];
  }
}

function buildCountryList() {
  const dynamic = getIntlCountries();
  const source = dynamic.length >= 150 ? dynamic : FALLBACK_COUNTRIES;

  return Array.from(new Set(source)).sort((a, b) => a.localeCompare(b));
}

export const ALL_COUNTRIES = buildCountryList();

~~~

## recruitment-system/frontend/src/pages/Applications.jsx

Previous code:
~~~
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { getApplications } from '../api'
import { FileText } from 'lucide-react'
import { Badge } from '../components/ui/Badge'
import { Card } from '../components/ui/Card'
import { TableSkeleton } from '../components/ui/Skeleton'

export default function Applications() {
  const { data: applications, isLoading } = useQuery({
    queryKey: ['applications'],
    queryFn: getApplications,
  })

  const list = Array.isArray(applications) ? applications : []

  return (
    <div className="p-6 lg:p-8 animate-fade-in">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Applications</h1>
        <p className="text-gray-600 mt-1">Track candidate applications across jobs</p>
      </div>

      <Card className="overflow-hidden">
        {isLoading ? (
          <TableSkeleton rows={6} cols={5} />
        ) : list.length === 0 ? (
          <div className="py-12 text-center text-gray-500">
            <FileText className="mx-auto h-12 w-12 text-gray-300 mb-2" aria-hidden />
            <p className="font-medium">No applications yet</p>
            <p className="text-sm mt-1">Applications will appear when candidates apply to jobs.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Candidate</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Job</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Status</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Applied</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Actions</th>
                </tr>
              </thead>
              <tbody>
                {list.map((app) => (
                  <tr key={app.id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                    <td className="py-3 px-4 font-medium text-gray-900">
                      <Link to={`/candidates/${app.candidate_id}`} className="text-primary-600 hover:text-primary-700">
                        {app.candidate_name || 'Candidate'}
                      </Link>
                    </td>
                    <td className="py-3 px-4 text-gray-600">
                      <Link to={`/jobs/${app.job_id}`} className="text-primary-600 hover:text-primary-700">
                        {app.job_title || 'Job'}
                      </Link>
                    </td>
                    <td className="py-3 px-4">
                      <Badge status={app.status} />
                    </td>
                    <td className="py-3 px-4 text-gray-600">
                      {app.applied_at ? new Date(app.applied_at).toLocaleDateString() : '-'}
                    </td>
                    <td className="py-3 px-4">
                      <Link to={`/candidates/${app.candidate_id}`} className="text-primary-600 hover:text-primary-700 text-sm font-medium">
                        View
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
~~~

Current code:
~~~
import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CalendarRange, FileText, LayoutGrid, List } from 'lucide-react'
import { getApplications, getJobs, getProjects } from '../api'
import { Card } from '../components/ui/Card'
import { TableSkeleton } from '../components/ui/Skeleton'
import ListView from './Applications/ListView'
import '../styles/applications.css'

export default function Applications() {
  const [status, setStatus] = useState('')
  const [jobId, setJobId] = useState('')
  const [projectId, setProjectId] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [compactView, setCompactView] = useState(false)
  const [debouncedFilters, setDebouncedFilters] = useState({})

  const filters = useMemo(() => ({
    status: status || undefined,
    job_id: jobId || undefined,
    project_id: projectId || undefined,
    date_from: dateFrom || undefined,
    date_to: dateTo || undefined,
    limit: 120,
    offset: 0,
  }), [status, jobId, projectId, dateFrom, dateTo])

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedFilters(filters), 250)
    return () => clearTimeout(timer)
  }, [filters])

  const { data: applications, isLoading } = useQuery({
    queryKey: ['applications', debouncedFilters],
    queryFn: () => getApplications(debouncedFilters),
  })

  const { data: jobs } = useQuery({
    queryKey: ['jobs', 'application-filters'],
    queryFn: () => getJobs({ limit: 200 }),
  })

  const { data: projects } = useQuery({
    queryKey: ['projects', 'application-filters'],
    queryFn: () => getProjects({ limit: 200 }),
  })

  const list = Array.isArray(applications) ? applications : []
  const jobsList = Array.isArray(jobs?.data) ? jobs.data : (Array.isArray(jobs) ? jobs : [])
  const projectsList = Array.isArray(projects?.data) ? projects.data : []

  return (
    <div className="p-6 lg:p-8 animate-fade-in">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Applications</h1>
          <p className="text-gray-600 mt-1">Filter by timeline, project, and status with instant updates</p>
        </div>
        <div className="inline-flex rounded-xl border border-gray-200 bg-white p-1 shadow-sm">
          <button
            type="button"
            onClick={() => setCompactView(false)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium inline-flex items-center gap-2 ${!compactView ? 'bg-sky-100 text-sky-700' : 'text-gray-600 hover:text-gray-900'}`}
          >
            <LayoutGrid size={15} /> Expanded
          </button>
          <button
            type="button"
            onClick={() => setCompactView(true)}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium inline-flex items-center gap-2 ${compactView ? 'bg-sky-100 text-sky-700' : 'text-gray-600 hover:text-gray-900'}`}
          >
            <List size={15} /> Compact
          </button>
        </div>
      </div>

      <Card className="p-4 mb-6">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
          <div>
            <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1">Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className="input w-full">
              <option value="">All statuses</option>
              <option value="applied">Applied</option>
              <option value="screening">Screening</option>
              <option value="certified">Certified</option>
              <option value="interview_scheduled">Interviewing</option>
              <option value="rejected">Rejected</option>
              <option value="selected">Selected</option>
              <option value="placed">Placed</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1">Job</label>
            <select value={jobId} onChange={(e) => setJobId(e.target.value)} className="input w-full">
              <option value="">All jobs</option>
              {jobsList.map((job) => (
                <option key={job.id} value={job.id}>{job.title}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1">Project</label>
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="input w-full">
              <option value="">All projects</option>
              {projectsList.map((project) => (
                <option key={project.id} value={project.id}>{project.title}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1">Date From</label>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="input w-full" />
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-600 uppercase tracking-wide mb-1">Date To</label>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="input w-full" />
          </div>
        </div>
      </Card>

      <Card className="overflow-hidden">
        {isLoading ? (
          <TableSkeleton rows={6} cols={5} />
        ) : list.length === 0 ? (
          <div className="py-12 text-center text-gray-500">
            <FileText className="mx-auto h-12 w-12 text-gray-300 mb-2" aria-hidden />
            <p className="font-medium">No applications yet</p>
            <p className="text-sm mt-1">Try broadening your filters or create new candidate applications.</p>
          </div>
        ) : (
          <div className="p-4">
            <div className="text-xs text-gray-500 mb-3 inline-flex items-center gap-1.5">
              <CalendarRange size={13} />
              Showing {list.length} matching applications
            </div>
            <ListView applications={list} compact={compactView} />
          </div>
        )}
      </Card>
    </div>
  )
}

~~~

## recruitment-system/frontend/src/pages/Applications/ListView.jsx

Previous code:
~~~
(File did not exist at baseline commit)
~~~

Current code:
~~~
import ApplicationCard from '../../components/ApplicationCard'

export default function ListView({ applications, compact }) {
  if (!applications || applications.length === 0) {
    return null
  }

  return (
    <div className={`applications-grid ${compact ? 'applications-grid-compact' : ''}`}>
      {applications.map((application) => (
        <ApplicationCard key={application.id} application={application} compact={compact} />
      ))}
    </div>
  )
}

~~~

## recruitment-system/frontend/src/pages/Communications.jsx

Previous code:
~~~
/**
 * Communications.jsx — Live Agent Chat Dashboard
 * ================================================
 * Three-panel layout:
 *   Left:   Active chat list with real-time activity badges
 *   Center: Full scrollable transcript with bot/agent/candidate bubbles
 *   Right:  Candidate context card (profile, job interest, state)
 *
 * Real-time via Socket.io:
 *   - new_message      → append message to transcript
 *   - chat_activity    → update last message in left list
 *   - handoff_start    → show "Agent Active" badge
 *   - handoff_end      → show "Bot Active" badge
 *   - agent_typing     → typing indicator in transcript
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { io } from 'socket.io-client'
import {
  MessageSquare, Search, Send, Phone, Mail, Bot, User,
  UserCheck, RefreshCw, Globe, Briefcase, MapPin, Clock,
  ChevronRight, AlertCircle, Wifi, WifiOff, Loader2
} from 'lucide-react'
import { clsx } from 'clsx'
import { format, formatDistanceToNow } from 'date-fns'
import { Button } from '../components/ui/Button'
import { Skeleton } from '../components/ui/Skeleton'
import { getCommunications, sendCommunication } from '../api'
import { useAuthStore } from '../stores/authStore'

// ── API helpers ──────────────────────────────────────────────────────────────

const API_BASE = 'http://localhost:3000'; // Hardcoded for local test

async function apiFetch(path, opts = {}) {
  const token = useAuthStore.getState().token
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...opts.headers },
    ...opts,
  })
  if (!res.ok) throw new Error(`${res.status}: ${res.statusText}`)
  return res.json()
}

const getActiveChats = (search) => apiFetch(`/api/communications/active-chats?search=${encodeURIComponent(search || '')}&limit=100`)
const getTranscript = (id) => apiFetch(`/api/communications/candidate/${id}?limit=200`)
const takeover = (id) => apiFetch(`/api/communications/candidate/${id}/takeover`, { method: 'POST' })
const release = (id) => apiFetch(`/api/communications/candidate/${id}/release`, { method: 'POST' })
const sendMsg = (body) => apiFetch('/api/communications/send', { method: 'POST', body: JSON.stringify(body) })

// ── Language badge ────────────────────────────────────────────────────────────

const LANG_LABEL = { en: 'EN', si: 'SI', ta: 'TA', singlish: 'SL', tanglish: 'TL' }
const LANG_COLOR = {
  en: 'bg-blue-100 text-blue-700', si: 'bg-yellow-100 text-yellow-700',
  ta: 'bg-orange-100 text-orange-700', singlish: 'bg-emerald-100 text-emerald-700',
  tanglish: 'bg-purple-100 text-purple-700',
}

function LangBadge({ lang }) {
  if (!lang) return null
  return (
    <span className={clsx('text-[10px] font-bold px-1.5 py-0.5 rounded-full', LANG_COLOR[lang] || 'bg-gray-100 text-gray-600')}>
      {LANG_LABEL[lang] || lang.toUpperCase()}
    </span>
  )
}

// ── Sender avatar ─────────────────────────────────────────────────────────────

function MsgBubble({ msg }) {
  const isInbound = msg.direction === 'inbound'
  const isSystem = msg.sender_type === 'system'
  const isAgent = msg.sender_type === 'agent'

  if (isSystem) {
    return (
      <div className="flex justify-center my-2">
        <span className="text-xs bg-amber-50 text-amber-600 border border-amber-200 px-3 py-1 rounded-full">
          {msg.content}
        </span>
      </div>
    )
  }

  return (
    <div className={clsx('flex gap-2 mb-3', isInbound ? 'justify-start' : 'justify-end')}>
      {isInbound && (
        <div className="w-7 h-7 rounded-full bg-slate-200 flex items-center justify-center shrink-0 mt-1">
          <User size={14} className="text-slate-500" />
        </div>
      )}
      <div className={clsx('max-w-[68%]', isInbound ? '' : 'items-end flex flex-col')}>
        {isAgent && (
          <span className="text-[10px] text-indigo-500 font-semibold mb-0.5 mr-1">
            {msg.sender_name || 'Agent'}
          </span>
        )}
        <div className={clsx(
          'rounded-2xl px-4 py-2.5 shadow-sm text-sm whitespace-pre-wrap break-words',
          isInbound
            ? 'bg-white text-gray-800 rounded-tl-none border border-gray-100'
            : isAgent
              ? 'bg-indigo-600 text-white rounded-tr-none'
              : 'bg-primary-600 text-white rounded-tr-none'
        )}>
          {msg.content}
        </div>
        <div className={clsx('flex items-center gap-1 mt-0.5 text-[10px] text-gray-400', isInbound ? 'ml-1' : 'mr-1 flex-row-reverse')}>
          <span>{format(new Date(msg.sent_at), 'HH:mm')}</span>
          {msg.detected_language && <LangBadge lang={msg.detected_language} />}
          {!isInbound && (
            <span>{isAgent ? '🧑‍💼' : '🤖'}</span>
          )}
        </div>
      </div>
      {!isInbound && (
        <div className={clsx(
          'w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-1',
          isAgent ? 'bg-indigo-100' : 'bg-primary-100'
        )}>
          {isAgent ? <UserCheck size={14} className="text-indigo-600" /> : <Bot size={14} className="text-primary-600" />}
        </div>
      )}
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function Communications() {
  const [selectedId, setSelectedId] = useState(null)
  const [message, setMessage] = useState('')
  const [search, setSearch] = useState('')
  const [chatList, setChatList] = useState([])
  const [transcript, setTranscript] = useState([])
  const [connected, setConnected] = useState(false)
  const [agentTyping, setAgentTyping] = useState(null)
  const [sendError, setSendError] = useState(null)
  const socketRef = useRef(null)
  const bottomRef = useRef(null)
  const queryClient = useQueryClient()

  // Selected candidate object from chatList
  const selectedCandidate = chatList.find(c => c.candidate_id === selectedId)

  // ── Fetch active chat list ─────────────────────────────────────────────────
  const { isLoading: listLoading } = useQuery({
    queryKey: ['active-chats', search],
    queryFn: () => getActiveChats(search),
    onSuccess: (data) => {
      setChatList(prev => {
        // Merge API data with any real-time updates we received
        const merged = Array.isArray(data) ? data : []
        return merged
      })
    },
    refetchInterval: 30000, // fallback poll every 30s
  })

  // ── Fetch transcript when candidate changes ────────────────────────────────
  const { isLoading: transcriptLoading } = useQuery({
    queryKey: ['transcript', selectedId],
    queryFn: () => getTranscript(selectedId),
    enabled: !!selectedId,
    onSuccess: (data) => setTranscript(Array.isArray(data) ? data : []),
  })

  // ── Socket.io real-time ────────────────────────────────────────────────────
  useEffect(() => {
    const token = useAuthStore.getState().token
    if (!token) {
      console.warn("Communications.jsx: No auth token found. Cannot connect Socket.io.")
      return
    }

    const socket = io(API_BASE, {
      auth: { token },
      transports: ['websocket', 'polling'],
    })
    socketRef.current = socket

    socket.on('connect', () => {
      setConnected(true)
      // Re-join current candidate room after reconnect
      if (selectedId) socket.emit('join_candidate', selectedId)
    })
    socket.on('disconnect', () => setConnected(false))

    socket.on('new_message', (msg) => {
      setTranscript(prev => [...prev, msg])
      // Update last message in chat list
      setChatList(prev => prev.map(c =>
        c.candidate_id === msg.candidate_id
          ? { ...c, last_message: msg.content, last_message_at: msg.sent_at, last_direction: msg.direction }
          : c
      ))
    })

    socket.on('chat_activity', (activity) => {
      setChatList(prev => {
        const exists = prev.find(c => c.candidate_id === activity.candidate_id)
        if (!exists && activity.candidate_name) {
          return [{ ...activity, name: activity.candidate_name }, ...prev]
        }
        return prev.map(c =>
          c.candidate_id === activity.candidate_id
            ? { ...c, ...activity, last_message: activity.last_message, last_message_at: activity.ts }
            : c
        )
      })
    })

    socket.on('handoff_start', ({ candidate_id, agent_name }) => {
      setChatList(prev => prev.map(c =>
        c.candidate_id === candidate_id ? { ...c, is_human_handoff: true, agent_name } : c
      ))
    })

    socket.on('handoff_end', ({ candidate_id }) => {
      setChatList(prev => prev.map(c =>
        c.candidate_id === candidate_id ? { ...c, is_human_handoff: false, agent_name: null } : c
      ))
    })

    socket.on('agent_typing', ({ agent_name, is_typing }) => {
      setAgentTyping(is_typing ? agent_name : null)
    })

    return () => socket.disconnect()
  }, []) // eslint-disable-line

  // Join/leave candidate room when selection changes
  useEffect(() => {
    const socket = socketRef.current
    if (!socket) return
    if (selectedId) socket.emit('join_candidate', selectedId)
    return () => { if (selectedId) socket.emit('leave_candidate', selectedId) }
  }, [selectedId])

  // Auto-scroll to bottom of transcript
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [transcript, agentTyping])

  // ── Takeover / Release mutations ───────────────────────────────────────────
  const takeoverMut = useMutation({
    mutationFn: () => takeover(selectedId),
    onSuccess: () => queryClient.invalidateQueries(['active-chats']),
  })
  const releaseMut = useMutation({
    mutationFn: () => release(selectedId),
    onSuccess: () => queryClient.invalidateQueries(['active-chats']),
  })

  // ── Send message ───────────────────────────────────────────────────────────
  const handleSend = useCallback(async (e) => {
    e?.preventDefault()
    if (!message.trim() || !selectedId) return
    setSendError(null)
    try {
      const result = await sendMsg({ candidate_id: selectedId, channel: 'whatsapp', message })
      setMessage('')
      // Optimistically add to transcript
      setTranscript(prev => [...prev, {
        id: result.id || Date.now(),
        direction: 'outbound',
        content: message,
        sender_type: 'agent',
        sender_name: 'You',
        sent_at: new Date().toISOString(),
      }])
    } catch (err) {
      setSendError('Failed to send. Please try again.')
    }
  }, [message, selectedId])

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-screen bg-slate-50 overflow-hidden">

      {/* ── Left: Chat list ─────────────────────────────────────────────────── */}
      <div className="w-80 shrink-0 border-r border-slate-200 bg-white flex flex-col">
        {/* Header */}
        <div className="px-4 py-3 border-b border-slate-100">
          <div className="flex items-center justify-between mb-3">
            <h1 className="text-lg font-bold text-slate-900">Conversations</h1>
            <div className="flex items-center gap-1.5">
              {connected
                ? <Wifi size={14} className="text-emerald-500" />
                : <WifiOff size={14} className="text-red-400 animate-pulse" />}
              <span className={clsx('text-[10px] font-medium', connected ? 'text-emerald-600' : 'text-red-400')}>
                {connected ? 'Live' : 'Offline'}
              </span>
            </div>
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
            <input
              type="text"
              placeholder="Search candidates..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-400 transition-all"
            />
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {listLoading ? (
            <div className="p-4 space-y-3">
              {[1, 2, 3, 4, 5].map(i => (
                <div key={i} className="flex gap-3 items-center">
                  <Skeleton className="w-10 h-10 rounded-full" />
                  <div className="flex-1"><Skeleton className="h-3 w-2/3 mb-2" /><Skeleton className="h-2 w-1/2" /></div>
                </div>
              ))}
            </div>
          ) : chatList.length === 0 ? (
            <div className="p-8 text-center text-slate-400">
              <MessageSquare size={40} className="mx-auto mb-2 text-slate-200" />
              <p className="text-sm">No conversations yet</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-50">
              {chatList.map((c) => (
                <button
                  key={c.candidate_id}
                  onClick={() => { setSelectedId(c.candidate_id); setTranscript([]) }}
                  className={clsx(
                    'w-full px-4 py-3 flex items-start gap-3 text-left hover:bg-slate-50 transition-colors',
                    selectedId === c.candidate_id && 'bg-primary-50 hover:bg-primary-50'
                  )}
                >
                  {/* Avatar */}
                  <div className={clsx(
                    'w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold shrink-0',
                    c.is_human_handoff ? 'bg-indigo-100 text-indigo-700' : 'bg-primary-100 text-primary-700'
                  )}>
                    {c.name?.charAt(0)?.toUpperCase() || '?'}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between gap-1 mb-0.5">
                      <p className="text-sm font-semibold text-slate-900 truncate">{c.name || 'Unknown'}</p>
                      {c.last_message_at && (
                        <span className="text-[10px] text-slate-400 shrink-0">
                          {formatDistanceToNow(new Date(c.last_message_at), { addSuffix: false })}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 truncate">{c.last_message || 'No messages'}</p>
                    <div className="flex items-center gap-1.5 mt-1">
                      {c.is_human_handoff
                        ? <span className="text-[10px] bg-indigo-100 text-indigo-600 px-1.5 py-0.5 rounded-full font-medium flex items-center gap-1">
                          <UserCheck size={10} /> {c.agent_name || 'Agent'}
                        </span>
                        : <span className="text-[10px] bg-emerald-100 text-emerald-600 px-1.5 py-0.5 rounded-full font-medium flex items-center gap-1">
                          <Bot size={10} /> Bot
                        </span>}
                      {c.last_language && <LangBadge lang={c.last_language} />}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Center: Transcript ───────────────────────────────────────────────── */}
      {selectedId ? (
        <div className="flex-1 flex flex-col min-w-0">
          {/* Transcript header */}
          <div className="h-16 px-5 bg-white border-b border-slate-200 flex items-center justify-between shadow-sm shrink-0">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-primary-100 flex items-center justify-center font-bold text-primary-700 text-sm">
                {selectedCandidate?.name?.charAt(0)?.toUpperCase() || '?'}
              </div>
              <div>
                <h2 className="font-semibold text-slate-900 text-sm">{selectedCandidate?.name || 'Candidate'}</h2>
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <span className="flex items-center gap-1"><Phone size={11} /> {selectedCandidate?.phone || selectedCandidate?.whatsapp_phone}</span>
                  {selectedCandidate?.last_chatbot_state && (
                    <span className="flex items-center gap-1 text-slate-400">
                      <ChevronRight size={11} /> {selectedCandidate.last_chatbot_state.replace(/_/g, ' ')}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Takeover / Release button */}
            <div className="flex items-center gap-2">
              {selectedCandidate?.is_human_handoff ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => releaseMut.mutate()}
                  disabled={releaseMut.isPending}
                  className="flex items-center gap-1.5 text-sm border-emerald-300 text-emerald-700 hover:bg-emerald-50"
                >
                  {releaseMut.isPending ? <Loader2 size={14} className="animate-spin" /> : <Bot size={14} />}
                  Release to Bot
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => takeoverMut.mutate()}
                  disabled={takeoverMut.isPending}
                  className="flex items-center gap-1.5 text-sm bg-indigo-600 hover:bg-indigo-700"
                >
                  {takeoverMut.isPending ? <Loader2 size={14} className="animate-spin" /> : <UserCheck size={14} />}
                  Take Over
                </Button>
              )}
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-5 py-4">
            {transcriptLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map(i => (
                  <div key={i} className={clsx('flex', i % 2 === 0 ? 'justify-end' : 'justify-start')}>
                    <Skeleton className={clsx('h-12 rounded-2xl', i % 2 === 0 ? 'w-48' : 'w-56')} />
                  </div>
                ))}
              </div>
            ) : transcript.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-slate-400">
                <MessageSquare size={48} className="mb-3 text-slate-200" />
                <p className="text-sm">No messages yet</p>
              </div>
            ) : (
              <>
                {transcript.map((msg, i) => <MsgBubble key={msg.id || i} msg={msg} />)}
                {agentTyping && (
                  <div className="flex justify-start mb-3">
                    <div className="bg-white border border-slate-100 rounded-2xl rounded-tl-none px-4 py-2 shadow-sm text-xs text-slate-400 flex items-center gap-2">
                      <span className="flex gap-1">
                        <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:0ms]" />
                        <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:150ms]" />
                        <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:300ms]" />
                      </span>
                      {agentTyping} is typing…
                    </div>
                  </div>
                )}
                <div ref={bottomRef} />
              </>
            )}
          </div>

          {/* Input */}
          {selectedCandidate?.is_human_handoff && (
            <div className="px-4 py-3 bg-white border-t border-slate-200 shrink-0">
              {sendError && (
                <div className="flex items-center gap-2 text-xs text-red-500 mb-2">
                  <AlertCircle size={12} /> {sendError}
                </div>
              )}
              <form onSubmit={handleSend} className="flex items-end gap-2">
                <div className="flex-1 bg-slate-50 rounded-xl border border-slate-200 focus-within:ring-2 focus-within:ring-indigo-400 focus-within:bg-white transition-all">
                  <textarea
                    value={message}
                    onChange={(e) => {
                      setMessage(e.target.value)
                      socketRef.current?.emit('typing', { candidateId: selectedId, isTyping: true })
                    }}
                    onBlur={() => socketRef.current?.emit('typing', { candidateId: selectedId, isTyping: false })}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
                    placeholder="Type a message as agent… (Enter to send)"
                    className="w-full bg-transparent border-0 focus:ring-0 p-3 max-h-28 resize-none text-sm"
                    rows={1}
                  />
                </div>
                <Button
                  type="submit"
                  disabled={!message.trim()}
                  className="mb-0.5 w-10 h-10 px-0 rounded-xl bg-indigo-600 hover:bg-indigo-700 flex items-center justify-center"
                >
                  <Send size={16} />
                </Button>
              </form>
            </div>
          )}

          {/* Bot-control notice */}
          {!selectedCandidate?.is_human_handoff && (
            <div className="px-4 py-3 bg-emerald-50 border-t border-emerald-100 shrink-0 flex items-center gap-2 text-sm text-emerald-700">
              <Bot size={16} />
              <span>Bot is handling this conversation. Click <strong>Take Over</strong> to reply as an agent.</span>
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center bg-slate-50">
          <div className="text-center text-slate-400">
            <MessageSquare size={56} className="mx-auto mb-3 text-slate-200" />
            <p className="text-lg font-medium text-slate-500">Select a conversation</p>
            <p className="text-sm">Choose from the list to view the full chat transcript</p>
          </div>
        </div>
      )}

      {/* ── Right: Candidate context ─────────────────────────────────────────── */}
      {selectedCandidate && (
        <div className="w-64 shrink-0 border-l border-slate-200 bg-white flex flex-col overflow-y-auto">
          <div className="p-4 border-b border-slate-100">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Candidate Info</h3>
            <div className="flex flex-col items-center text-center">
              <div className="w-14 h-14 rounded-full bg-primary-100 flex items-center justify-center text-primary-700 text-xl font-bold mb-2">
                {selectedCandidate.name?.charAt(0)?.toUpperCase() || '?'}
              </div>
              <p className="font-semibold text-slate-900">{selectedCandidate.name}</p>
              <p className="text-xs text-slate-500">{selectedCandidate.phone || selectedCandidate.whatsapp_phone}</p>
            </div>
          </div>

          <div className="p-4 space-y-3 text-sm">
            {/* Status */}
            <div className="flex items-center gap-2 text-slate-600">
              <div className={clsx('w-2 h-2 rounded-full', selectedCandidate.is_human_handoff ? 'bg-indigo-500' : 'bg-emerald-500')} />
              <span>{selectedCandidate.is_human_handoff ? `Agent: ${selectedCandidate.agent_name || 'Active'}` : 'Bot Active'}</span>
            </div>

            {/* Bot state */}
            {selectedCandidate.last_chatbot_state && (
              <div className="flex items-start gap-2 text-slate-600">
                <RefreshCw size={13} className="mt-0.5 shrink-0 text-slate-400" />
                <div>
                  <p className="text-[10px] text-slate-400 uppercase tracking-wide">Bot State</p>
                  <p className="text-xs font-medium">{selectedCandidate.last_chatbot_state.replace(/_/g, ' ')}</p>
                </div>
              </div>
            )}

            {/* Language */}
            {selectedCandidate.last_language && (
              <div className="flex items-center gap-2 text-slate-600">
                <Globe size={13} className="text-slate-400 shrink-0" />
                <span className="text-xs">Language: <LangBadge lang={selectedCandidate.last_language} /></span>
              </div>
            )}

            {/* Candidate status */}
            {selectedCandidate.candidate_status && (
              <div className="flex items-center gap-2 text-slate-600">
                <Briefcase size={13} className="text-slate-400 shrink-0" />
                <span className="text-xs capitalize">{selectedCandidate.candidate_status}</span>
              </div>
            )}

            {/* Last activity */}
            {selectedCandidate.last_message_at && (
              <div className="flex items-center gap-2 text-slate-600">
                <Clock size={13} className="text-slate-400 shrink-0" />
                <span className="text-xs">{formatDistanceToNow(new Date(selectedCandidate.last_message_at), { addSuffix: true })}</span>
              </div>
            )}
          </div>

          {/* Quick actions */}
          <div className="p-4 border-t border-slate-100 mt-auto">
            {selectedCandidate.is_human_handoff ? (
              <Button
                variant="outline"
                className="w-full text-xs flex items-center justify-center gap-1.5 border-emerald-300 text-emerald-700"
                onClick={() => releaseMut.mutate()}
                disabled={releaseMut.isPending}
              >
                <Bot size={13} /> Release to Bot
              </Button>
            ) : (
              <Button
                className="w-full text-xs flex items-center justify-center gap-1.5 bg-indigo-600 hover:bg-indigo-700"
                onClick={() => takeoverMut.mutate()}
                disabled={takeoverMut.isPending}
              >
                <UserCheck size={13} /> Take Over Chat
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
~~~

Current code:
~~~
/**
 * Communications.jsx — Live Agent Chat Dashboard
 * ================================================
 * Three-panel layout:
 *   Left:   Active chat list with real-time activity badges
 *   Center: Full scrollable transcript with bot/agent/candidate bubbles
 *   Right:  Candidate context card (profile, job interest, state)
 *
 * Real-time via Socket.io:
 *   - new_message      → append message to transcript
 *   - chat_activity    → update last message in left list
 *   - handoff_start    → show "Agent Active" badge
 *   - handoff_end      → show "Bot Active" badge
 *   - agent_typing     → typing indicator in transcript
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { io } from 'socket.io-client'
import {
  MessageSquare, Search, Send, Phone, Mail, Bot, User,
  UserCheck, RefreshCw, Globe, Briefcase, Clock,
  ChevronRight, AlertCircle, Wifi, WifiOff, Loader2, PencilLine
} from 'lucide-react'
import { clsx } from 'clsx'
import { format, formatDistanceToNow } from 'date-fns'
import { Button } from '../components/ui/Button'
import { Skeleton } from '../components/ui/Skeleton'
import { useAuthStore } from '../stores/authStore'

// ── API helpers ──────────────────────────────────────────────────────────────

const API_BASE = import.meta.env.VITE_API_URL || ''

async function apiFetch(path, opts = {}) {
  const token = useAuthStore.getState().token
  const res = await fetch(`${API_BASE}${path}`, {
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...opts.headers },
    ...opts,
  })
  if (!res.ok) throw new Error(`${res.status}: ${res.statusText}`)
  return res.json()
}

const getActiveChats = ({ search, conversationStage, responseStatus, dateFrom, dateTo }) => {
  const params = new URLSearchParams()
  params.set('limit', '100')
  if (search) params.set('search', search)
  if (conversationStage) params.set('conversation_stage', conversationStage)
  if (responseStatus) params.set('response_status', responseStatus)
  if (dateFrom) params.set('date_from', dateFrom)
  if (dateTo) params.set('date_to', dateTo)

  return apiFetch(`/api/communications/active-chats?${params.toString()}`)
}

const getTranscript = ({ id, responseStatus, dateFrom, dateTo }) => {
  const params = new URLSearchParams()
  params.set('limit', '200')
  if (responseStatus) params.set('response_status', responseStatus)
  if (dateFrom) params.set('date_from', dateFrom)
  if (dateTo) params.set('date_to', dateTo)
  return apiFetch(`/api/communications/candidate/${id}?${params.toString()}`)
}

const takeover = (id) => apiFetch(`/api/communications/candidate/${id}/takeover`, { method: 'POST' })
const release = (id) => apiFetch(`/api/communications/candidate/${id}/release`, { method: 'POST' })
const sendMsg = (body) => apiFetch('/api/communications/send', { method: 'POST', body: JSON.stringify(body) })
const updateCandidateName = (id, fullName) => apiFetch(`/api/candidates/${id}`, {
  method: 'PUT',
  body: JSON.stringify({ full_name: fullName }),
})

// ── Language badge ────────────────────────────────────────────────────────────

const LANG_LABEL = { en: 'EN', si: 'SI', ta: 'TA', singlish: 'SL', tanglish: 'TL' }
const LANG_COLOR = {
  en: 'bg-blue-100 text-blue-700', si: 'bg-yellow-100 text-yellow-700',
  ta: 'bg-orange-100 text-orange-700', singlish: 'bg-emerald-100 text-emerald-700',
  tanglish: 'bg-purple-100 text-purple-700',
}

function LangBadge({ lang }) {
  if (!lang) return null
  return (
    <span className={clsx('text-[10px] font-bold px-1.5 py-0.5 rounded-full', LANG_COLOR[lang] || 'bg-gray-100 text-gray-600')}>
      {LANG_LABEL[lang] || lang.toUpperCase()}
    </span>
  )
}

// ── Sender avatar ─────────────────────────────────────────────────────────────

function MsgBubble({ msg }) {
  const isInbound = msg.direction === 'inbound'
  const isSystem = msg.sender_type === 'system'
  const isAgent = msg.sender_type === 'agent'

  if (isSystem) {
    return (
      <div className="flex justify-center my-2">
        <span className="text-xs bg-amber-50 text-amber-600 border border-amber-200 px-3 py-1 rounded-full">
          {msg.content}
        </span>
      </div>
    )
  }

  return (
    <div className={clsx('flex gap-2 mb-3', isInbound ? 'justify-start' : 'justify-end')}>
      {isInbound && (
        <div className="w-7 h-7 rounded-full bg-slate-200 flex items-center justify-center shrink-0 mt-1">
          <User size={14} className="text-slate-500" />
        </div>
      )}
      <div className={clsx('max-w-[68%]', isInbound ? '' : 'items-end flex flex-col')}>
        {isAgent && (
          <span className="text-[10px] text-indigo-500 font-semibold mb-0.5 mr-1">
            {msg.sender_name || 'Agent'}
          </span>
        )}
        <div className={clsx(
          'rounded-2xl px-4 py-2.5 shadow-sm text-sm whitespace-pre-wrap break-words',
          isInbound
            ? 'bg-white text-gray-800 rounded-tl-none border border-gray-100'
            : isAgent
              ? 'bg-indigo-600 text-white rounded-tr-none'
              : 'bg-primary-600 text-white rounded-tr-none'
        )}>
          {msg.content}
        </div>
        <div className={clsx('flex items-center gap-1 mt-0.5 text-[10px] text-gray-400', isInbound ? 'ml-1' : 'mr-1 flex-row-reverse')}>
          <span>{format(new Date(msg.sent_at), 'HH:mm')}</span>
          {msg.detected_language && <LangBadge lang={msg.detected_language} />}
          {!isInbound && (
            <span>{isAgent ? '🧑‍💼' : '🤖'}</span>
          )}
        </div>
      </div>
      {!isInbound && (
        <div className={clsx(
          'w-7 h-7 rounded-full flex items-center justify-center shrink-0 mt-1',
          isAgent ? 'bg-indigo-100' : 'bg-primary-100'
        )}>
          {isAgent ? <UserCheck size={14} className="text-indigo-600" /> : <Bot size={14} className="text-primary-600" />}
        </div>
      )}
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function Communications() {
  const [selectedId, setSelectedId] = useState(null)
  const [message, setMessage] = useState('')
  const [search, setSearch] = useState('')
  const [conversationStage, setConversationStage] = useState('')
  const [responseStatus, setResponseStatus] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [chatList, setChatList] = useState([])
  const [transcript, setTranscript] = useState([])
  const [connected, setConnected] = useState(false)
  const [agentTyping, setAgentTyping] = useState(null)
  const [sendError, setSendError] = useState(null)
  const socketRef = useRef(null)
  const bottomRef = useRef(null)
  const queryClient = useQueryClient()

  // Selected candidate object from chatList
  const selectedCandidate = chatList.find(c => c.candidate_id === selectedId)

  // ── Fetch active chat list ─────────────────────────────────────────────────
  const { data: activeChatsData, isLoading: listLoading } = useQuery({
    queryKey: ['active-chats', search, conversationStage, responseStatus, dateFrom, dateTo],
    queryFn: () => getActiveChats({ search, conversationStage, responseStatus, dateFrom, dateTo }),
    refetchInterval: 30000, // fallback poll every 30s
  })

  // ── Fetch transcript when candidate changes ────────────────────────────────
  const { data: transcriptData, isLoading: transcriptLoading } = useQuery({
    queryKey: ['transcript', selectedId, responseStatus, dateFrom, dateTo],
    queryFn: () => getTranscript({ id: selectedId, responseStatus, dateFrom, dateTo }),
    enabled: !!selectedId,
  })

  // Keep UI state synced with fetched query data (React Query v5-safe).
  useEffect(() => {
    if (Array.isArray(activeChatsData)) {
      setChatList(activeChatsData)
    }
  }, [activeChatsData])

  useEffect(() => {
    if (Array.isArray(transcriptData)) {
      setTranscript(transcriptData)
    }
  }, [transcriptData])

  useEffect(() => {
    if (!selectedCandidate) {
      setNameDraft('')
      return
    }
    setNameDraft(selectedCandidate.full_name || selectedCandidate.display_name || selectedCandidate.name || '')
  }, [selectedCandidate?.candidate_id, selectedCandidate?.full_name, selectedCandidate?.display_name, selectedCandidate?.name])

  // ── Socket.io real-time ────────────────────────────────────────────────────
  useEffect(() => {
    const token = useAuthStore.getState().token
    if (!token) {
      console.warn("Communications.jsx: No auth token found. Cannot connect Socket.io.")
      return
    }

    const socket = io(API_BASE, {
      auth: { token },
      transports: ['websocket', 'polling'],
    })
    socketRef.current = socket

    socket.on('connect', () => {
      setConnected(true)
      // Re-join current candidate room after reconnect
      if (selectedId) socket.emit('join_candidate', selectedId)
    })
    socket.on('disconnect', () => setConnected(false))

    socket.on('new_message', (msg) => {
      setTranscript(prev => [...prev, msg])
      // Update last message in chat list
      setChatList(prev => prev.map(c =>
        c.candidate_id === msg.candidate_id
          ? { ...c, last_message: msg.content, last_message_at: msg.sent_at, last_direction: msg.direction }
          : c
      ))
    })

    socket.on('chat_activity', (activity) => {
      setChatList(prev => {
        const exists = prev.find(c => c.candidate_id === activity.candidate_id)
        if (!exists && activity.candidate_name) {
          return [{ ...activity, name: activity.candidate_name }, ...prev]
        }
        return prev.map(c =>
          c.candidate_id === activity.candidate_id
            ? { ...c, ...activity, last_message: activity.last_message, last_message_at: activity.ts }
            : c
        )
      })
    })

    socket.on('handoff_start', ({ candidate_id, agent_name }) => {
      setChatList(prev => prev.map(c =>
        c.candidate_id === candidate_id ? { ...c, is_human_handoff: true, agent_name } : c
      ))
    })

    socket.on('handoff_end', ({ candidate_id }) => {
      setChatList(prev => prev.map(c =>
        c.candidate_id === candidate_id ? { ...c, is_human_handoff: false, agent_name: null } : c
      ))
    })

    socket.on('agent_typing', ({ agent_name, is_typing }) => {
      setAgentTyping(is_typing ? agent_name : null)
    })

    return () => socket.disconnect()
  }, []) // eslint-disable-line

  // Join/leave candidate room when selection changes
  useEffect(() => {
    const socket = socketRef.current
    if (!socket) return
    if (selectedId) socket.emit('join_candidate', selectedId)
    return () => { if (selectedId) socket.emit('leave_candidate', selectedId) }
  }, [selectedId])

  // Auto-scroll to bottom of transcript
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [transcript, agentTyping])

  // ── Takeover / Release mutations ───────────────────────────────────────────
  const takeoverMut = useMutation({
    mutationFn: () => takeover(selectedId),
    onSuccess: () => queryClient.invalidateQueries(['active-chats']),
  })
  const releaseMut = useMutation({
    mutationFn: () => release(selectedId),
    onSuccess: () => queryClient.invalidateQueries(['active-chats']),
  })

  const updateNameMut = useMutation({
    mutationFn: ({ id, fullName }) => updateCandidateName(id, fullName),
    onSuccess: () => {
      setEditingName(false)
      queryClient.invalidateQueries(['active-chats'])
    },
  })

  // ── Send message ───────────────────────────────────────────────────────────
  const handleSend = useCallback(async (e) => {
    e?.preventDefault()
    if (!message.trim() || !selectedId) return
    setSendError(null)
    try {
      const result = await sendMsg({ candidate_id: selectedId, channel: 'whatsapp', message })
      setMessage('')
      // Optimistically add to transcript
      setTranscript(prev => [...prev, {
        id: result.id || Date.now(),
        direction: 'outbound',
        content: message,
        sender_type: 'agent',
        sender_name: 'You',
        sent_at: new Date().toISOString(),
      }])
    } catch (err) {
      setSendError('Failed to send. Please try again.')
    }
  }, [message, selectedId])

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-screen bg-slate-50 overflow-hidden">

      {/* ── Left: Chat list ─────────────────────────────────────────────────── */}
      <div className="w-80 shrink-0 border-r border-slate-200 bg-white flex flex-col">
        {/* Header */}
        <div className="px-4 py-3 border-b border-slate-100">
          <div className="flex items-center justify-between mb-3">
            <h1 className="text-lg font-bold text-slate-900">Conversations</h1>
            <div className="flex items-center gap-1.5">
              {connected
                ? <Wifi size={14} className="text-emerald-500" />
                : <WifiOff size={14} className="text-red-400 animate-pulse" />}
              <span className={clsx('text-[10px] font-medium', connected ? 'text-emerald-600' : 'text-red-400')}>
                {connected ? 'Live' : 'Offline'}
              </span>
            </div>
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
            <input
              type="text"
              placeholder="Search candidates..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary-400 transition-all"
            />
          </div>
          <div className="grid grid-cols-2 gap-2 mt-2">
            <select
              value={conversationStage}
              onChange={(e) => setConversationStage(e.target.value)}
              className="text-xs bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5"
            >
              <option value="">All Stages</option>
              <option value="new">New</option>
              <option value="responding">Responding</option>
              <option value="cv_sent">CV Sent</option>
              <option value="completed">Completed</option>
              <option value="dropped">Dropped</option>
            </select>
            <select
              value={responseStatus}
              onChange={(e) => setResponseStatus(e.target.value)}
              className="text-xs bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5"
            >
              <option value="">All Responses</option>
              <option value="awaiting_candidate">Awaiting Candidate</option>
              <option value="awaiting_agent">Awaiting Agent</option>
            </select>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="text-xs bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5"
            />
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="text-xs bg-slate-50 border border-slate-200 rounded-lg px-2 py-1.5"
            />
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {listLoading ? (
            <div className="p-4 space-y-3">
              {[1, 2, 3, 4, 5].map(i => (
                <div key={i} className="flex gap-3 items-center">
                  <Skeleton className="w-10 h-10 rounded-full" />
                  <div className="flex-1"><Skeleton className="h-3 w-2/3 mb-2" /><Skeleton className="h-2 w-1/2" /></div>
                </div>
              ))}
            </div>
          ) : chatList.length === 0 ? (
            <div className="p-8 text-center text-slate-400">
              <MessageSquare size={40} className="mx-auto mb-2 text-slate-200" />
              <p className="text-sm">No conversations yet</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-50">
              {chatList.map((c) => (
                <button
                  key={c.candidate_id}
                  onClick={() => { setSelectedId(c.candidate_id); setTranscript([]) }}
                  className={clsx(
                    'w-full px-4 py-3 flex items-start gap-3 text-left hover:bg-slate-50 transition-colors',
                    selectedId === c.candidate_id && 'bg-primary-50 hover:bg-primary-50'
                  )}
                >
                  {/* Avatar */}
                  <div className={clsx(
                    'w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold shrink-0',
                    c.is_human_handoff ? 'bg-indigo-100 text-indigo-700' : 'bg-primary-100 text-primary-700'
                  )}>
                    {(c.display_name || c.name || '?').charAt(0).toUpperCase()}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between gap-1 mb-0.5">
                      <p className="text-sm font-semibold text-slate-900 truncate">{c.display_name || c.name || 'Unknown'}</p>
                      {c.last_message_at && (
                        <span className="text-[10px] text-slate-400 shrink-0">
                          {formatDistanceToNow(new Date(c.last_message_at), { addSuffix: false })}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-slate-500 truncate">{c.phone || c.whatsapp_phone || '-'}</p>
                    <p className="text-xs text-slate-500 truncate">{c.last_message || 'No messages'}</p>
                    <div className="flex items-center gap-1.5 mt-1">
                      {c.is_human_handoff
                        ? <span className="text-[10px] bg-indigo-100 text-indigo-600 px-1.5 py-0.5 rounded-full font-medium flex items-center gap-1">
                          <UserCheck size={10} /> {c.agent_name || 'Agent'}
                        </span>
                        : <span className="text-[10px] bg-emerald-100 text-emerald-600 px-1.5 py-0.5 rounded-full font-medium flex items-center gap-1">
                          <Bot size={10} /> Bot
                        </span>}
                      {c.conversation_stage && (
                        <span className="text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded-full font-medium capitalize">
                          {c.conversation_stage.replace('_', ' ')}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Center: Transcript ───────────────────────────────────────────────── */}
      {selectedId ? (
        <div className="flex-1 flex flex-col min-w-0">
          {/* Transcript header */}
          <div className="h-16 px-5 bg-white border-b border-slate-200 flex items-center justify-between shadow-sm shrink-0">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-primary-100 flex items-center justify-center font-bold text-primary-700 text-sm">
                {(selectedCandidate?.display_name || selectedCandidate?.name || '?').charAt(0).toUpperCase()}
              </div>
              <div>
                <h2 className="font-semibold text-slate-900 text-sm">{selectedCandidate?.display_name || selectedCandidate?.name || 'Candidate'}</h2>
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <span className="flex items-center gap-1"><Phone size={11} /> {selectedCandidate?.phone || selectedCandidate?.whatsapp_phone}</span>
                  {selectedCandidate?.conversation_stage && (
                    <span className="flex items-center gap-1 text-slate-400">
                      <ChevronRight size={11} /> {selectedCandidate.conversation_stage.replace(/_/g, ' ')}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Takeover / Release button */}
            <div className="flex items-center gap-2">
              {selectedCandidate?.is_human_handoff ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => releaseMut.mutate()}
                  disabled={releaseMut.isPending}
                  className="flex items-center gap-1.5 text-sm border-emerald-300 text-emerald-700 hover:bg-emerald-50"
                >
                  {releaseMut.isPending ? <Loader2 size={14} className="animate-spin" /> : <Bot size={14} />}
                  Release to Bot
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => takeoverMut.mutate()}
                  disabled={takeoverMut.isPending}
                  className="flex items-center gap-1.5 text-sm bg-indigo-600 hover:bg-indigo-700"
                >
                  {takeoverMut.isPending ? <Loader2 size={14} className="animate-spin" /> : <UserCheck size={14} />}
                  Take Over
                </Button>
              )}
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-5 py-4">
            {transcriptLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map(i => (
                  <div key={i} className={clsx('flex', i % 2 === 0 ? 'justify-end' : 'justify-start')}>
                    <Skeleton className={clsx('h-12 rounded-2xl', i % 2 === 0 ? 'w-48' : 'w-56')} />
                  </div>
                ))}
              </div>
            ) : transcript.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-slate-400">
                <MessageSquare size={48} className="mb-3 text-slate-200" />
                <p className="text-sm">No messages yet</p>
              </div>
            ) : (
              <>
                {transcript.map((msg, i) => <MsgBubble key={msg.id || i} msg={msg} />)}
                {agentTyping && (
                  <div className="flex justify-start mb-3">
                    <div className="bg-white border border-slate-100 rounded-2xl rounded-tl-none px-4 py-2 shadow-sm text-xs text-slate-400 flex items-center gap-2">
                      <span className="flex gap-1">
                        <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:0ms]" />
                        <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:150ms]" />
                        <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce [animation-delay:300ms]" />
                      </span>
                      {agentTyping} is typing…
                    </div>
                  </div>
                )}
                <div ref={bottomRef} />
              </>
            )}
          </div>

          {/* Input */}
          {selectedCandidate?.is_human_handoff && (
            <div className="px-4 py-3 bg-white border-t border-slate-200 shrink-0">
              {sendError && (
                <div className="flex items-center gap-2 text-xs text-red-500 mb-2">
                  <AlertCircle size={12} /> {sendError}
                </div>
              )}
              <form onSubmit={handleSend} className="flex items-end gap-2">
                <div className="flex-1 bg-slate-50 rounded-xl border border-slate-200 focus-within:ring-2 focus-within:ring-indigo-400 focus-within:bg-white transition-all">
                  <textarea
                    value={message}
                    onChange={(e) => {
                      setMessage(e.target.value)
                      socketRef.current?.emit('typing', { candidateId: selectedId, isTyping: true })
                    }}
                    onBlur={() => socketRef.current?.emit('typing', { candidateId: selectedId, isTyping: false })}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() } }}
                    placeholder="Type a message as agent… (Enter to send)"
                    className="w-full bg-transparent border-0 focus:ring-0 p-3 max-h-28 resize-none text-sm"
                    rows={1}
                  />
                </div>
                <Button
                  type="submit"
                  disabled={!message.trim()}
                  className="mb-0.5 w-10 h-10 px-0 rounded-xl bg-indigo-600 hover:bg-indigo-700 flex items-center justify-center"
                >
                  <Send size={16} />
                </Button>
              </form>
            </div>
          )}

          {/* Bot-control notice */}
          {!selectedCandidate?.is_human_handoff && (
            <div className="px-4 py-3 bg-emerald-50 border-t border-emerald-100 shrink-0 flex items-center gap-2 text-sm text-emerald-700">
              <Bot size={16} />
              <span>Bot is handling this conversation. Click <strong>Take Over</strong> to reply as an agent.</span>
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center bg-slate-50">
          <div className="text-center text-slate-400">
            <MessageSquare size={56} className="mx-auto mb-3 text-slate-200" />
            <p className="text-lg font-medium text-slate-500">Select a conversation</p>
            <p className="text-sm">Choose from the list to view the full chat transcript</p>
          </div>
        </div>
      )}

      {/* ── Right: Candidate context ─────────────────────────────────────────── */}
      {selectedCandidate && (
        <div className="w-64 shrink-0 border-l border-slate-200 bg-white flex flex-col overflow-y-auto">
          <div className="p-4 border-b border-slate-100">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Candidate Info</h3>
            <div className="flex flex-col items-center text-center">
              <div className="w-14 h-14 rounded-full bg-primary-100 flex items-center justify-center text-primary-700 text-xl font-bold mb-2">
                {(selectedCandidate.display_name || selectedCandidate.name || '?').charAt(0).toUpperCase()}
              </div>
              <p className="font-semibold text-slate-900">{selectedCandidate.display_name || selectedCandidate.name}</p>
              <p className="text-xs text-slate-500">{selectedCandidate.phone || selectedCandidate.whatsapp_phone}</p>
            </div>
            <div className="mt-3">
              {!editingName ? (
                <Button
                  type="button"
                  variant="outline"
                  className="w-full text-xs"
                  onClick={() => setEditingName(true)}
                >
                  <PencilLine size={12} className="mr-1" /> Edit Name
                </Button>
              ) : (
                <div className="space-y-2">
                  <input
                    type="text"
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    className="w-full text-xs border border-slate-200 rounded-lg px-2 py-1.5"
                    placeholder="Enter candidate name"
                  />
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      className="flex-1 text-xs"
                      disabled={!nameDraft.trim() || updateNameMut.isPending}
                      onClick={() => updateNameMut.mutate({ id: selectedCandidate.candidate_id, fullName: nameDraft.trim() })}
                    >
                      {updateNameMut.isPending ? 'Saving...' : 'Save'}
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      className="flex-1 text-xs"
                      onClick={() => {
                        setEditingName(false)
                        setNameDraft(selectedCandidate.full_name || selectedCandidate.display_name || selectedCandidate.name || '')
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="p-4 space-y-3 text-sm">
            {/* Status */}
            <div className="flex items-center gap-2 text-slate-600">
              <div className={clsx('w-2 h-2 rounded-full', selectedCandidate.is_human_handoff ? 'bg-indigo-500' : 'bg-emerald-500')} />
              <span>{selectedCandidate.is_human_handoff ? `Agent: ${selectedCandidate.agent_name || 'Active'}` : 'Bot Active'}</span>
            </div>

            {/* Conversation stage */}
            {selectedCandidate.conversation_stage && (
              <div className="flex items-start gap-2 text-slate-600">
                <RefreshCw size={13} className="mt-0.5 shrink-0 text-slate-400" />
                <div>
                  <p className="text-[10px] text-slate-400 uppercase tracking-wide">Conversation Stage</p>
                  <p className="text-xs font-medium capitalize">{selectedCandidate.conversation_stage.replace(/_/g, ' ')}</p>
                </div>
              </div>
            )}

            {/* CV status */}
            {selectedCandidate.cv_status && (
              <div className="flex items-center gap-2 text-slate-600">
                <Mail size={13} className="text-slate-400 shrink-0" />
                <span className="text-xs capitalize">CV: {selectedCandidate.cv_status}</span>
              </div>
            )}

            {/* Candidate status */}
            {selectedCandidate.candidate_status && (
              <div className="flex items-center gap-2 text-slate-600">
                <Briefcase size={13} className="text-slate-400 shrink-0" />
                <span className="text-xs capitalize">{selectedCandidate.candidate_status}</span>
              </div>
            )}

            {/* Last activity */}
            {(selectedCandidate.last_interaction || selectedCandidate.last_message_at) && (
              <div className="flex items-center gap-2 text-slate-600">
                <Clock size={13} className="text-slate-400 shrink-0" />
                <span className="text-xs">{formatDistanceToNow(new Date(selectedCandidate.last_interaction || selectedCandidate.last_message_at), { addSuffix: true })}</span>
              </div>
            )}

            {/* Language */}
            {selectedCandidate.last_language && (
              <div className="flex items-center gap-2 text-slate-600">
                <Globe size={13} className="text-slate-400 shrink-0" />
                <span className="text-xs">Language: <LangBadge lang={selectedCandidate.last_language} /></span>
              </div>
            )}
          </div>

          {/* Quick actions */}
          <div className="p-4 border-t border-slate-100 mt-auto">
            {selectedCandidate.is_human_handoff ? (
              <Button
                variant="outline"
                className="w-full text-xs flex items-center justify-center gap-1.5 border-emerald-300 text-emerald-700"
                onClick={() => releaseMut.mutate()}
                disabled={releaseMut.isPending}
              >
                <Bot size={13} /> Release to Bot
              </Button>
            ) : (
              <Button
                className="w-full text-xs flex items-center justify-center gap-1.5 bg-indigo-600 hover:bg-indigo-700"
                onClick={() => takeoverMut.mutate()}
                disabled={takeoverMut.isPending}
              >
                <UserCheck size={13} /> Take Over Chat
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

~~~

## recruitment-system/frontend/src/pages/KnowledgeBase.jsx

Previous code:
~~~
import { useState, useEffect } from 'react'
import { Plus, Search, Filter, BookOpen, Edit2, Trash2, Languages, Activity } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useAuthStore } from '../stores/authStore'

export default function KnowledgeBase() {
  const { token, user } = useAuthStore()
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('list') // list, create
  const [activeLang, setActiveLang] = useState('en') // en, si, ta
  const [search, setSearch] = useState('')
  const [stats, setStats] = useState({ total: 0, topCategory: '-' })
  
  // Fetch entries
  useEffect(() => {
    fetchEntries()
  }, [])

  const fetchEntries = async () => {
    try {
      setLoading(true)
      const res = await fetch(`http://localhost:3000/api/knowledge-base?limit=100`, {
        headers: { 'Authorization': `Bearer ${token}` }
      })
      const data = await res.json()
      setEntries(data.entries || [])
      setStats({
        total: data.pagination?.total || data.entries?.length || 0,
        topCategory: data.entries?.[0]?.category || '-'
      })
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  // Handle Delete
  const handleDelete = async (id) => {
    if(!window.confirm("Delete this FAQ entry permanently?")) return

    try {
      await fetch(`http://localhost:3000/api/knowledge-base/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` }
      })
      fetchEntries()
    } catch (err) {
      console.error("Delete failed", err)
    }
  }

  // Filter local entries
  const filtered = entries.filter(e => 
    (e.question_en?.toLowerCase() || '').includes(search.toLowerCase()) ||
    (e.category?.toLowerCase() || '').includes(search.toLowerCase())
  )

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 tracking-tight">Knowledge Manager</h1>
          <p className="text-zinc-500 mt-1">Manage FAQs, translations, and conversational knowledge for the AI chatbot.</p>
        </div>
        <div className="flex items-center gap-3">
          <button 
            onClick={() => setActiveTab('create')}
            className="px-4 py-2 bg-zinc-900 text-white font-medium rounded-xl hover:bg-zinc-800 transition-colors shadow-sm flex items-center gap-2"
          >
            <Plus size={18} />
            <span>New FAQ</span>
          </button>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-2xl p-6 border border-zinc-200/50 shadow-sm flex items-start justify-between">
          <div>
            <p className="text-sm font-semibold text-zinc-500 mb-1">Total Entries</p>
            <h3 className="text-3xl font-bold text-zinc-900">{stats.total}</h3>
          </div>
          <div className="p-3 bg-blue-50 text-blue-600 rounded-xl"><BookOpen size={24} /></div>
        </div>
        <div className="bg-white rounded-2xl p-6 border border-zinc-200/50 shadow-sm flex items-start justify-between">
          <div>
            <p className="text-sm font-semibold text-zinc-500 mb-1">Most Questions In</p>
            <h3 className="text-3xl font-bold text-zinc-900 capitalize">{stats.topCategory.replace(/_/g, ' ')}</h3>
          </div>
          <div className="p-3 bg-purple-50 text-purple-600 rounded-xl"><Activity size={24} /></div>
        </div>
        <div className="bg-white rounded-2xl p-6 border border-zinc-200/50 shadow-sm flex flex-col justify-center">
          <p className="text-sm font-semibold text-zinc-500 mb-2">Live Languages</p>
          <div className="flex gap-2">
            <span className="px-3 py-1 bg-zinc-100 text-zinc-900 font-medium text-sm rounded-lg">English</span>
            <span className="px-3 py-1 bg-zinc-100 text-zinc-900 font-medium text-sm rounded-lg">Sinhala</span>
            <span className="px-3 py-1 bg-zinc-100 text-zinc-900 font-medium text-sm rounded-lg">Tamil</span>
          </div>
        </div>
      </div>

      {activeTab === 'list' && (
      <div className="bg-white border border-zinc-200/50 rounded-3xl shadow-sm overflow-hidden flex flex-col">
        {/* Controls */}
        <div className="p-4 border-b border-zinc-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-zinc-50/50">
          <div className="relative max-w-md w-full">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" size={18} />
            <input
              type="text"
              placeholder="Search questions or categories..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-white border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900/10 focus:border-zinc-900 transition-all"
            />
          </div>
          <div className="flex items-center gap-2 bg-white p-1 border border-zinc-200 rounded-xl">
             <button onClick={()=>setActiveLang('en')} className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors ${activeLang==='en'?'bg-zinc-100 text-zinc-900':'text-zinc-500 hover:text-zinc-900'}`}>EN</button>
             <button onClick={()=>setActiveLang('si')} className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors ${activeLang==='si'?'bg-zinc-100 text-zinc-900':'text-zinc-500 hover:text-zinc-900'}`}>SI</button>
             <button onClick={()=>setActiveLang('ta')} className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors ${activeLang==='ta'?'bg-zinc-100 text-zinc-900':'text-zinc-500 hover:text-zinc-900'}`}>TA</button>
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-zinc-50/50">
                <th className="px-6 py-4 text-xs font-semibold text-zinc-500 uppercase tracking-wider">Question ({activeLang.toUpperCase()})</th>
                <th className="px-6 py-4 text-xs font-semibold text-zinc-500 uppercase tracking-wider">Category</th>
                <th className="px-6 py-4 text-xs font-semibold text-zinc-500 uppercase tracking-wider text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200/50">
              {loading ? (
                <tr><td colSpan="4" className="px-6 py-12 text-center text-zinc-500">Loading knowledge base...</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan="4" className="px-6 py-12 text-center text-zinc-500">No matching FAQs found.</td></tr>
              ) : (
                filtered.map((entry) => (
                  <tr key={entry.id} className="hover:bg-zinc-50/50 transition-colors">
                    <td className="px-6 py-4">
                      <div className="font-medium text-zinc-900 mb-1 w-[400px] truncate">
                         {activeLang === 'en' ? entry.question_en : activeLang === 'si' ? entry.question_si : entry.question_ta}
                      </div>
                      <div className="text-sm text-zinc-500 w-[400px] truncate">
                         {activeLang === 'en' ? entry.answer_en : activeLang === 'si' ? entry.answer_si : entry.answer_ta}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span className="px-3 py-1 bg-blue-50 text-blue-700 font-medium text-xs rounded-lg border border-blue-100 capitalize">
                        {entry.category.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button className="p-2 text-zinc-400 hover:text-zinc-900 hover:bg-zinc-100 rounded-lg transition-colors">
                          <Edit2 size={16} />
                        </button>
                        <button onClick={()=>handleDelete(entry.id)} className="p-2 text-zinc-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors">
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      )}

      {activeTab === 'create' && (
        <CreateFAQ onBack={() => { setActiveTab('list'); fetchEntries(); }} token={token} />
      )}
    </div>
  )
}

function CreateFAQ({ onBack, token }) {
  const [formData, setFormData] = useState({
    category: 'general',
    question_en: '',
    answer_en: '',
    question_si: '',
    answer_si: '',
    question_ta: '',
    answer_ta: '',
    keywords: ''
  })
  const [saving, setSaving] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setSaving(true)
    
    const payload = {
      ...formData,
      keywords: formData.keywords.split(',').map(k => k.trim()).filter(Boolean)
    }

    try {
      await fetch(`http://localhost:3000/api/knowledge-base`, {
        method: 'POST',
        headers: { 
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json' 
        },
        body: JSON.stringify(payload)
      })
      onBack()
    } catch (err) {
      console.error(err)
      alert("Failed to save")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-white border border-zinc-200/50 rounded-3xl shadow-sm p-6 max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold text-zinc-900">Add New FAQ Entry</h2>
        <button onClick={onBack} className="text-sm font-semibold text-zinc-500 hover:text-zinc-900">Cancel</button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div>
          <label className="block text-sm font-semibold text-zinc-700 mb-2">Category</label>
          <select 
            value={formData.category}
            onChange={e => setFormData({...formData, category: e.target.value})}
            className="w-full px-4 py-3 bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
          >
            <option value="general">General</option>
            <option value="salary_and_compensation">Salary & Compensation</option>
            <option value="visa_and_immigration">Visa & Immigration</option>
            <option value="medical_and_gamca">Medical & GAMCA</option>
            <option value="requirements">Job Requirements</option>
            <option value="documents_required">Documents Required</option>
          </select>
        </div>

        <div className="space-y-4">
          <h3 className="font-semibold text-zinc-900 flex items-center gap-2"><span className="w-6 h-6 rounded bg-blue-100 text-blue-700 flex items-center justify-center text-xs">EN</span> English</h3>
          <div>
            <input required placeholder="Question (English)" value={formData.question_en} onChange={e=>setFormData({...formData, question_en: e.target.value})} className="w-full px-4 py-3 bg-zinc-50 border border-zinc-200 rounded-xl mb-2" />
            <textarea required placeholder="Answer (English)" rows={3} value={formData.answer_en} onChange={e=>setFormData({...formData, answer_en: e.target.value})} className="w-full px-4 py-3 bg-zinc-50 border border-zinc-200 rounded-xl" />
          </div>
        </div>

        <div className="space-y-4 pt-4 border-t border-zinc-100">
          <h3 className="font-semibold text-zinc-900 flex items-center gap-2"><span className="w-6 h-6 rounded bg-orange-100 text-orange-700 flex items-center justify-center text-xs">SI</span> Sinhala</h3>
          <div>
            <input placeholder="Question (Sinhala Unicode)" value={formData.question_si} onChange={e=>setFormData({...formData, question_si: e.target.value})} className="w-full px-4 py-3 bg-zinc-50 border border-zinc-200 rounded-xl mb-2 font-si" />
            <textarea placeholder="Answer (Sinhala Unicode)" rows={3} value={formData.answer_si} onChange={e=>setFormData({...formData, answer_si: e.target.value})} className="w-full px-4 py-3 bg-zinc-50 border border-zinc-200 rounded-xl font-si" />
          </div>
        </div>

        <div className="space-y-4 pt-4 border-t border-zinc-100">
          <h3 className="font-semibold text-zinc-900 flex items-center gap-2"><span className="w-6 h-6 rounded bg-green-100 text-green-700 flex items-center justify-center text-xs">TA</span> Tamil</h3>
          <div>
            <input placeholder="Question (Tamil Unicode)" value={formData.question_ta} onChange={e=>setFormData({...formData, question_ta: e.target.value})} className="w-full px-4 py-3 bg-zinc-50 border border-zinc-200 rounded-xl mb-2 font-ta" />
            <textarea placeholder="Answer (Tamil Unicode)" rows={3} value={formData.answer_ta} onChange={e=>setFormData({...formData, answer_ta: e.target.value})} className="w-full px-4 py-3 bg-zinc-50 border border-zinc-200 rounded-xl font-ta" />
          </div>
        </div>

        <div className="pt-4 border-t border-zinc-100">
          <label className="block text-sm font-semibold text-zinc-700 mb-2">Search Keywords (Comma separated)</label>
          <input placeholder="e.g. salary, padi, wetupa, money" value={formData.keywords} onChange={e=>setFormData({...formData, keywords: e.target.value})} className="w-full px-4 py-3 bg-zinc-50 border border-zinc-200 rounded-xl" />
          <p className="text-xs text-zinc-500 mt-2">Include Singlish/Tanglish terms here so the chatbot can find this answer easily.</p>
        </div>

        <div className="pt-6 flex justify-end">
          <button type="submit" disabled={saving} className="px-6 py-3 bg-indigo-600 text-white font-medium rounded-xl hover:bg-indigo-700 transition-colors shadow-sm disabled:opacity-50">
            {saving ? 'Saving...' : 'Save Knowledge Entry'}
          </button>
        </div>
      </form>
    </div>
  )
}
~~~

Current code:
~~~
import { useState, useEffect } from 'react'
import { Plus, Search, Filter, BookOpen, Edit2, Trash2, Languages, Activity } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { useAuthStore } from '../stores/authStore'

const API_BASE = import.meta.env.VITE_API_URL || ''

async function kbFetch(path, token, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
    ...options,
  })

  if (!res.ok) {
    throw new Error(`Knowledge base API error: ${res.status}`)
  }

  return res
}

export default function KnowledgeBase() {
  const { token, user } = useAuthStore()
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('list') // list, create
  const [activeLang, setActiveLang] = useState('en') // en, si, ta
  const [search, setSearch] = useState('')
  const [stats, setStats] = useState({ total: 0, topCategory: '-' })
  
  // Fetch entries
  useEffect(() => {
    fetchEntries()
  }, [])

  const fetchEntries = async () => {
    try {
      setLoading(true)
      const res = await kbFetch('/api/knowledge-base?limit=100', token)
      const data = await res.json()
      setEntries(data.entries || [])
      setStats({
        total: data.pagination?.total || data.entries?.length || 0,
        topCategory: data.entries?.[0]?.category || '-'
      })
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  // Handle Delete
  const handleDelete = async (id) => {
    if(!window.confirm("Delete this FAQ entry permanently?")) return

    try {
      await kbFetch(`/api/knowledge-base/${id}`, token, {
        method: 'DELETE',
      })
      fetchEntries()
    } catch (err) {
      console.error("Delete failed", err)
    }
  }

  // Filter local entries
  const filtered = entries.filter(e => 
    (e.question_en?.toLowerCase() || '').includes(search.toLowerCase()) ||
    (e.category?.toLowerCase() || '').includes(search.toLowerCase())
  )

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900 tracking-tight">Knowledge Manager</h1>
          <p className="text-zinc-500 mt-1">Manage FAQs, translations, and conversational knowledge for the AI chatbot.</p>
        </div>
        <div className="flex items-center gap-3">
          <button 
            onClick={() => setActiveTab('create')}
            className="px-4 py-2 bg-zinc-900 text-white font-medium rounded-xl hover:bg-zinc-800 transition-colors shadow-sm flex items-center gap-2"
          >
            <Plus size={18} />
            <span>New FAQ</span>
          </button>
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-2xl p-6 border border-zinc-200/50 shadow-sm flex items-start justify-between">
          <div>
            <p className="text-sm font-semibold text-zinc-500 mb-1">Total Entries</p>
            <h3 className="text-3xl font-bold text-zinc-900">{stats.total}</h3>
          </div>
          <div className="p-3 bg-blue-50 text-blue-600 rounded-xl"><BookOpen size={24} /></div>
        </div>
        <div className="bg-white rounded-2xl p-6 border border-zinc-200/50 shadow-sm flex items-start justify-between">
          <div>
            <p className="text-sm font-semibold text-zinc-500 mb-1">Most Questions In</p>
            <h3 className="text-3xl font-bold text-zinc-900 capitalize">{stats.topCategory.replace(/_/g, ' ')}</h3>
          </div>
          <div className="p-3 bg-purple-50 text-purple-600 rounded-xl"><Activity size={24} /></div>
        </div>
        <div className="bg-white rounded-2xl p-6 border border-zinc-200/50 shadow-sm flex flex-col justify-center">
          <p className="text-sm font-semibold text-zinc-500 mb-2">Live Languages</p>
          <div className="flex gap-2">
            <span className="px-3 py-1 bg-zinc-100 text-zinc-900 font-medium text-sm rounded-lg">English</span>
            <span className="px-3 py-1 bg-zinc-100 text-zinc-900 font-medium text-sm rounded-lg">Sinhala</span>
            <span className="px-3 py-1 bg-zinc-100 text-zinc-900 font-medium text-sm rounded-lg">Tamil</span>
          </div>
        </div>
      </div>

      {activeTab === 'list' && (
      <div className="bg-white border border-zinc-200/50 rounded-3xl shadow-sm overflow-hidden flex flex-col">
        {/* Controls */}
        <div className="p-4 border-b border-zinc-200 flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-zinc-50/50">
          <div className="relative max-w-md w-full">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" size={18} />
            <input
              type="text"
              placeholder="Search questions or categories..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2 bg-white border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900/10 focus:border-zinc-900 transition-all"
            />
          </div>
          <div className="flex items-center gap-2 bg-white p-1 border border-zinc-200 rounded-xl">
             <button onClick={()=>setActiveLang('en')} className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors ${activeLang==='en'?'bg-zinc-100 text-zinc-900':'text-zinc-500 hover:text-zinc-900'}`}>EN</button>
             <button onClick={()=>setActiveLang('si')} className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors ${activeLang==='si'?'bg-zinc-100 text-zinc-900':'text-zinc-500 hover:text-zinc-900'}`}>SI</button>
             <button onClick={()=>setActiveLang('ta')} className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors ${activeLang==='ta'?'bg-zinc-100 text-zinc-900':'text-zinc-500 hover:text-zinc-900'}`}>TA</button>
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-zinc-50/50">
                <th className="px-6 py-4 text-xs font-semibold text-zinc-500 uppercase tracking-wider">Question ({activeLang.toUpperCase()})</th>
                <th className="px-6 py-4 text-xs font-semibold text-zinc-500 uppercase tracking-wider">Category</th>
                <th className="px-6 py-4 text-xs font-semibold text-zinc-500 uppercase tracking-wider text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200/50">
              {loading ? (
                <tr><td colSpan="4" className="px-6 py-12 text-center text-zinc-500">Loading knowledge base...</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan="4" className="px-6 py-12 text-center text-zinc-500">No matching FAQs found.</td></tr>
              ) : (
                filtered.map((entry) => (
                  <tr key={entry.id} className="hover:bg-zinc-50/50 transition-colors">
                    <td className="px-6 py-4">
                      <div className="font-medium text-zinc-900 mb-1 w-[400px] truncate">
                         {activeLang === 'en' ? entry.question_en : activeLang === 'si' ? entry.question_si : entry.question_ta}
                      </div>
                      <div className="text-sm text-zinc-500 w-[400px] truncate">
                         {activeLang === 'en' ? entry.answer_en : activeLang === 'si' ? entry.answer_si : entry.answer_ta}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <span className="px-3 py-1 bg-blue-50 text-blue-700 font-medium text-xs rounded-lg border border-blue-100 capitalize">
                        {entry.category.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button className="p-2 text-zinc-400 hover:text-zinc-900 hover:bg-zinc-100 rounded-lg transition-colors">
                          <Edit2 size={16} />
                        </button>
                        <button onClick={()=>handleDelete(entry.id)} className="p-2 text-zinc-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors">
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      )}

      {activeTab === 'create' && (
        <CreateFAQ onBack={() => { setActiveTab('list'); fetchEntries(); }} token={token} />
      )}
    </div>
  )
}

function CreateFAQ({ onBack, token }) {
  const [formData, setFormData] = useState({
    category: 'general',
    question_en: '',
    answer_en: '',
    question_si: '',
    answer_si: '',
    question_ta: '',
    answer_ta: '',
    keywords: ''
  })
  const [saving, setSaving] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setSaving(true)
    
    const payload = {
      ...formData,
      keywords: formData.keywords.split(',').map(k => k.trim()).filter(Boolean)
    }

    try {
      await kbFetch('/api/knowledge-base', token, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json' 
        },
        body: JSON.stringify(payload)
      })
      onBack()
    } catch (err) {
      console.error(err)
      alert("Failed to save")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-white border border-zinc-200/50 rounded-3xl shadow-sm p-6 max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold text-zinc-900">Add New FAQ Entry</h2>
        <button onClick={onBack} className="text-sm font-semibold text-zinc-500 hover:text-zinc-900">Cancel</button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div>
          <label className="block text-sm font-semibold text-zinc-700 mb-2">Category</label>
          <select 
            value={formData.category}
            onChange={e => setFormData({...formData, category: e.target.value})}
            className="w-full px-4 py-3 bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
          >
            <option value="general">General</option>
            <option value="salary_and_compensation">Salary & Compensation</option>
            <option value="visa_and_immigration">Visa & Immigration</option>
            <option value="medical_and_gamca">Medical & GAMCA</option>
            <option value="requirements">Job Requirements</option>
            <option value="documents_required">Documents Required</option>
          </select>
        </div>

        <div className="space-y-4">
          <h3 className="font-semibold text-zinc-900 flex items-center gap-2"><span className="w-6 h-6 rounded bg-blue-100 text-blue-700 flex items-center justify-center text-xs">EN</span> English</h3>
          <div>
            <input required placeholder="Question (English)" value={formData.question_en} onChange={e=>setFormData({...formData, question_en: e.target.value})} className="w-full px-4 py-3 bg-zinc-50 border border-zinc-200 rounded-xl mb-2" />
            <textarea required placeholder="Answer (English)" rows={3} value={formData.answer_en} onChange={e=>setFormData({...formData, answer_en: e.target.value})} className="w-full px-4 py-3 bg-zinc-50 border border-zinc-200 rounded-xl" />
          </div>
        </div>

        <div className="space-y-4 pt-4 border-t border-zinc-100">
          <h3 className="font-semibold text-zinc-900 flex items-center gap-2"><span className="w-6 h-6 rounded bg-orange-100 text-orange-700 flex items-center justify-center text-xs">SI</span> Sinhala</h3>
          <div>
            <input placeholder="Question (Sinhala Unicode)" value={formData.question_si} onChange={e=>setFormData({...formData, question_si: e.target.value})} className="w-full px-4 py-3 bg-zinc-50 border border-zinc-200 rounded-xl mb-2 font-si" />
            <textarea placeholder="Answer (Sinhala Unicode)" rows={3} value={formData.answer_si} onChange={e=>setFormData({...formData, answer_si: e.target.value})} className="w-full px-4 py-3 bg-zinc-50 border border-zinc-200 rounded-xl font-si" />
          </div>
        </div>

        <div className="space-y-4 pt-4 border-t border-zinc-100">
          <h3 className="font-semibold text-zinc-900 flex items-center gap-2"><span className="w-6 h-6 rounded bg-green-100 text-green-700 flex items-center justify-center text-xs">TA</span> Tamil</h3>
          <div>
            <input placeholder="Question (Tamil Unicode)" value={formData.question_ta} onChange={e=>setFormData({...formData, question_ta: e.target.value})} className="w-full px-4 py-3 bg-zinc-50 border border-zinc-200 rounded-xl mb-2 font-ta" />
            <textarea placeholder="Answer (Tamil Unicode)" rows={3} value={formData.answer_ta} onChange={e=>setFormData({...formData, answer_ta: e.target.value})} className="w-full px-4 py-3 bg-zinc-50 border border-zinc-200 rounded-xl font-ta" />
          </div>
        </div>

        <div className="pt-4 border-t border-zinc-100">
          <label className="block text-sm font-semibold text-zinc-700 mb-2">Search Keywords (Comma separated)</label>
          <input placeholder="e.g. salary, padi, wetupa, money" value={formData.keywords} onChange={e=>setFormData({...formData, keywords: e.target.value})} className="w-full px-4 py-3 bg-zinc-50 border border-zinc-200 rounded-xl" />
          <p className="text-xs text-zinc-500 mt-2">Include Singlish/Tanglish terms here so the chatbot can find this answer easily.</p>
        </div>

        <div className="pt-6 flex justify-end">
          <button type="submit" disabled={saving} className="px-6 py-3 bg-indigo-600 text-white font-medium rounded-xl hover:bg-indigo-700 transition-colors shadow-sm disabled:opacity-50">
            {saving ? 'Saving...' : 'Save Knowledge Entry'}
          </button>
        </div>
      </form>
    </div>
  )
}

~~~

## recruitment-system/frontend/src/pages/Projects.jsx

Previous code:
~~~
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { getProjects, createProject, deleteProject } from '../api'
import { FolderKanban, Plus, Trash2, Users, Briefcase } from 'lucide-react'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { TableSkeleton } from '../components/ui/Skeleton'
import { Input } from '../components/ui/Input'
import { useAuthStore } from '../stores/authStore'
import toast from 'react-hot-toast'
import { format } from 'date-fns'
import { clsx } from 'clsx'

const COUNTRIES = ['UAE', 'Qatar', 'Oman', 'Bahrain', 'Saudi Arabia', 'Kuwait']
const INDUSTRIES = ['Hypermarket', 'Restaurant', 'Construction', 'Healthcare', 'Hospitality', 'Manufacturing', 'Retail', 'Logistics']

export default function Projects() {
  const { user } = useAuthStore()
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState('')
  const [countryFilter, setCountryFilter] = useState('')
  const [industryFilter, setIndustryFilter] = useState('')
  const [priorityFilter, setPriorityFilter] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [modalOpen, setModalOpen] = useState(false)

  // Form state for new project
  const [formData, setFormData] = useState({
    title: '',
    client_name: '',
    industry_type: '',
    description: '',
    countries: [],
    priority: 'normal',
    total_positions: 0,
    start_date: '',
    interview_date: '',
    end_date: '',
    benefits: {
      accommodation: false,
      transport: false,
      meals: false,
      visa: false,
      ticket: false
    },
    salary_info: {
      min: '',
      max: '',
      currency: 'AED'
    },
    contact_info: {
      whatsapp: '',
      email: '',
      address: ''
    }
  })

  const { data, isLoading } = useQuery({
    queryKey: ['projects', { 
      page, 
      status: statusFilter || undefined,
      country: countryFilter || undefined,
      industry_type: industryFilter || undefined,
      priority: priorityFilter || undefined,
      search: searchQuery || undefined
    }],
    queryFn: () => getProjects({ 
      page, 
      status: statusFilter || undefined,
      country: countryFilter || undefined,
      industry_type: industryFilter || undefined,
      priority: priorityFilter || undefined,
      search: searchQuery || undefined
    })
  })

  const createMutation = useMutation({
    mutationFn: createProject,
    onSuccess: () => {
      queryClient.invalidateQueries(['projects'])
      setModalOpen(false)
      resetForm()
      toast.success('Project created successfully')
    },
    onError: (error) => {
      toast.error(error.response?.data?.error || 'Failed to create project')
    }
  })

  const deleteMutation = useMutation({
    mutationFn: deleteProject,
    onSuccess: () => {
      queryClient.invalidateQueries(['projects'])
      toast.success('Project deleted successfully')
    },
    onError: (error) => {
      toast.error(error.response?.data?.error || 'Failed to delete project')
    }
  })

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!formData.title || !formData.client_name || !formData.industry_type || formData.countries.length === 0) {
      toast.error('Please fill in all required fields')
      return
    }
    createMutation.mutate(formData)
  }

  const handleDelete = (id) => {
    if (window.confirm('Are you sure you want to delete this project? All related jobs will be unlinked.')) {
      deleteMutation.mutate(id)
    }
  }

  const resetForm = () => {
    setFormData({
      title: '',
      client_name: '',
      industry_type: '',
      description: '',
      countries: [],
      priority: 'normal',
      total_positions: 0,
      start_date: '',
      interview_date: '',
      end_date: '',
      benefits: {
        accommodation: false,
        transport: false,
        meals: false,
        visa: false,
        ticket: false
      },
      salary_info: {
        min: '',
        max: '',
        currency: 'AED'
      },
      contact_info: {
        whatsapp: '',
        email: '',
        address: ''
      }
    })
  }

  const handleCountryToggle = (country) => {
    setFormData(prev => ({
      ...prev,
      countries: prev.countries.includes(country)
        ? prev.countries.filter(c => c !== country)
        : [...prev.countries, country]
    }))
  }

  const projectsList = data?.data || []
  const canCreateProject = user?.role === 'admin' || user?.role === 'supervisor'
  const canDeleteProject = user?.role === 'admin'

  return (
    <div className="p-6 lg:p-8 animate-fade-in">
      {/* Header */}
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Projects</h1>
          <p className="text-gray-600 mt-1">Manage multi-country recruitment projects</p>
        </div>
        {canCreateProject && (
          <Button onClick={() => setModalOpen(true)}>
            <Plus size={20} className="mr-2" />
            New Project
          </Button>
        )}
      </div>

      {/* Filters */}
      <div className="card mb-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Search</label>
            <input
              type="text"
              placeholder="Search projects..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="input w-full"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="input w-full"
            >
              <option value="">All Status</option>
              <option value="planning">Planning</option>
              <option value="active">Active</option>
              <option value="on_hold">On Hold</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Country</label>
            <select
              value={countryFilter}
              onChange={(e) => setCountryFilter(e.target.value)}
              className="input w-full"
            >
              <option value="">All Countries</option>
              {COUNTRIES.map(country => (
                <option key={country} value={country}>{country}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Industry</label>
            <select
              value={industryFilter}
              onChange={(e) => setIndustryFilter(e.target.value)}
              className="input w-full"
            >
              <option value="">All Industries</option>
              {INDUSTRIES.map(industry => (
                <option key={industry} value={industry}>{industry}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Priority</label>
            <select
              value={priorityFilter}
              onChange={(e) => setPriorityFilter(e.target.value)}
              className="input w-full"
            >
              <option value="">All Priority</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </div>
        </div>
      </div>

      {/* Projects Table */}
      <div className="card overflow-hidden">
        {isLoading ? (
          <TableSkeleton rows={6} cols={8} />
        ) : projectsList.length === 0 ? (
          <div className="py-12 text-center text-gray-500">
            <FolderKanban className="mx-auto h-12 w-12 text-gray-300 mb-2" />
            <p className="font-medium">No projects found</p>
            <p className="text-sm mt-1">Create your first project to get started.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Project</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Client</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Countries</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Industry</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Status</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Priority</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Positions</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Interview Date</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Team</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Actions</th>
                </tr>
              </thead>
              <tbody>
                {projectsList.map((project) => {
                  const countries = typeof project.countries === 'string' 
                    ? JSON.parse(project.countries) 
                    : project.countries
                  
                  return (
                    <tr key={project.id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                      <td className="py-3 px-4">
                        <Link to={`/projects/${project.id}`} className="font-medium text-gray-900 hover:text-primary-600">
                          {project.title}
                        </Link>
                      </td>
                      <td className="py-3 px-4 text-gray-600">{project.client_name}</td>
                      <td className="py-3 px-4">
                        <div className="flex flex-wrap gap-1">
                          {countries?.slice(0, 2).map((country) => (
                            <span key={country} className="text-xs px-2 py-1 bg-blue-50 text-blue-700 rounded-md">
                              {country}
                            </span>
                          ))}
                          {countries?.length > 2 && (
                            <span className="text-xs px-2 py-1 bg-gray-100 text-gray-600 rounded-md">
                              +{countries.length - 2}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-gray-600 text-sm">{project.industry_type}</td>
                      <td className="py-3 px-4">
                        <Badge status={project.status} />
                      </td>
                      <td className="py-3 px-4">
                        <Badge status={project.priority} />
                      </td>
                      <td className="py-3 px-4 text-gray-600">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{project.filled_positions || 0}</span>
                          <span className="text-gray-400">/</span>
                          <span>{project.total_positions || 0}</span>
                        </div>
                      </td>
                      <td className="py-3 px-4 text-gray-600 text-sm">
                        {project.interview_date ? format(new Date(project.interview_date), 'MMM dd, yyyy') : '-'}
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-1">
                          <Users size={16} className="text-gray-400" />
                          <span className="text-sm text-gray-600">{project.team_count || 0}</span>
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex gap-2 items-center">
                          <Link
                            to={`/projects/${project.id}`}
                            className="text-primary-600 hover:text-primary-700 font-medium text-sm"
                          >
                            View
                          </Link>
                          {project.job_count > 0 && (
                            <>
                              <span className="text-gray-300">|</span>
                              <div className="flex items-center gap-1 text-gray-500 text-sm">
                                <Briefcase size={14} />
                                <span>{project.job_count}</span>
                              </div>
                            </>
                          )}
                          {canDeleteProject && (
                            <>
                              <span className="text-gray-300">|</span>
                              <button
                                onClick={() => handleDelete(project.id)}
                                className="text-red-600 hover:text-red-700"
                                title="Delete project"
                              >
                                <Trash2 size={16} />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {data?.pagination && data.pagination.totalPages > 1 && (
        <div className="mt-6 flex items-center justify-between">
          <p className="text-sm text-gray-600">
            Page {data.pagination.page} of {data.pagination.totalPages}
          </p>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
            >
              Previous
            </Button>
            <Button
              variant="secondary"
              onClick={() => setPage(p => p + 1)}
              disabled={page >= data.pagination.totalPages}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      {/* Create Project Modal */}
      <Modal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false)
          resetForm()
        }}
        title="Create New Project"
        size="xl"
      >
        <form onSubmit={handleSubmit} className="space-y-8">
          {/* Basic Information */}
          <div className="space-y-4 pb-6 border-b border-gray-200">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-primary-100 text-primary-600 flex items-center justify-center font-semibold text-sm">1</div>
              <h3 className="text-lg font-semibold text-gray-900">Basic Information</h3>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input
                label="Project Title"
                required
                placeholder="e.g., Middle East Hypermarket Expansion"
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
              />
              <Input
                label="Client Name"
                required
                placeholder="Company name"
                value={formData.client_name}
                onChange={(e) => setFormData({ ...formData, client_name: e.target.value })}
              />
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Industry Type <span className="text-red-500">*</span>
                </label>
                <select
                  required
                  value={formData.industry_type}
                  onChange={(e) => setFormData({ ...formData, industry_type: e.target.value })}
                  className="input w-full"
                >
                  <option value="">Select industry</option>
                  {INDUSTRIES.map(industry => (
                    <option key={industry} value={industry}>{industry}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Priority</label>
                <select
                  value={formData.priority}
                  onChange={(e) => setFormData({ ...formData, priority: e.target.value })}
                  className="input w-full"
                >
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
              <textarea
                rows={3}
                placeholder="Project description..."
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                className="input w-full resize-none"
              />
            </div>
          </div>

          {/* Countries */}
          <div className="pb-6 border-b border-gray-200">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 rounded-full bg-primary-100 text-primary-600 flex items-center justify-center font-semibold text-sm">2</div>
              <label className="text-lg font-semibold text-gray-900">
                Target Countries <span className="text-red-500">*</span>
              </label>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {COUNTRIES.map(country => (
                <label key={country} className={clsx(
                  "flex items-center gap-2 p-3 border-2 rounded-lg cursor-pointer transition-all",
                  formData.countries.includes(country)
                    ? "border-primary-500 bg-primary-50 shadow-sm"
                    : "border-gray-200 hover:border-gray-300 hover:bg-gray-50"
                )}>
                  <input
                    type="checkbox"
                    checked={formData.countries.includes(country)}
                    onChange={() => handleCountryToggle(country)}
                    className="rounded text-primary-600 focus:ring-primary-500 w-4 h-4"
                  />
                  <span className="text-sm font-medium text-gray-700">{country}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Timeline */}
          <div className="space-y-4 pb-6 border-b border-gray-200">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-primary-100 text-primary-600 flex items-center justify-center font-semibold text-sm">3</div>
              <h3 className="text-lg font-semibold text-gray-900">Timeline</h3>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Input
                type="date"
                label="Start Date"
                value={formData.start_date}
                onChange={(e) => setFormData({ ...formData, start_date: e.target.value })}
              />
              <Input
                type="date"
                label="Interview Start Date"
                value={formData.interview_date}
                onChange={(e) => setFormData({ ...formData, interview_date: e.target.value })}
              />
               <Input
                type="date"
                label="Interview End Date"
                value={formData.interview_date}
                onChange={(e) => setFormData({ ...formData, interview_date: e.target.value })}
              />
              <Input
                type="date"
                label="End Date"
                value={formData.end_date}
                onChange={(e) => setFormData({ ...formData, end_date: e.target.value })}
              />
            </div>
          </div>

          {/* Positions & Benefits */}
          <div className="space-y-4 pb-6 border-b border-gray-200">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-primary-100 text-primary-600 flex items-center justify-center font-semibold text-sm">4</div>
              <h3 className="text-lg font-semibold text-gray-900">Positions & Benefits</h3>
            </div>
            <Input
              type="number"
              label="Total Positions"
              min="0"
              value={formData.total_positions}
              onChange={(e) => setFormData({ ...formData, total_positions: parseInt(e.target.value) || 0 })}
            />
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-3">Benefits Included</label>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                {['accommodation', 'transport', 'meals', 'visa', 'ticket'].map(benefit => (
                  <label key={benefit} className={clsx(
                    "flex items-center gap-2 p-3 border-2 rounded-lg cursor-pointer transition-all",
                    formData.benefits[benefit]
                      ? "border-primary-500 bg-primary-50"
                      : "border-gray-200 hover:border-gray-300 hover:bg-gray-50"
                  )}>
                    <input
                      type="checkbox"
                      checked={formData.benefits[benefit]}
                      onChange={(e) => setFormData({
                        ...formData,
                        benefits: { ...formData.benefits, [benefit]: e.target.checked }
                      })}
                      className="rounded text-primary-600 focus:ring-primary-500 w-4 h-4"
                    />
                    <span className="text-sm font-medium text-gray-700 capitalize">{benefit}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>

          {/* Salary Range */}
          <div className="space-y-4 pb-6 border-b border-gray-200">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-primary-100 text-primary-600 flex items-center justify-center font-semibold text-sm">5</div>
              <h3 className="text-lg font-semibold text-gray-900">Salary Information</h3>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Input
                type="number"
                label="Minimum Salary"
                placeholder="1500"
                value={formData.salary_info.min}
                onChange={(e) => setFormData({
                  ...formData,
                  salary_info: { ...formData.salary_info, min: e.target.value }
                })}
              />
              <Input
                type="number"
                label="Maximum Salary"
                placeholder="2000"
                value={formData.salary_info.max}
                onChange={(e) => setFormData({
                  ...formData,
                  salary_info: { ...formData.salary_info, max: e.target.value }
                })}
              />
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Currency</label>
                <select
                  value={formData.salary_info.currency}
                  onChange={(e) => setFormData({
                    ...formData,
                    salary_info: { ...formData.salary_info, currency: e.target.value }
                  })}
                  className="input w-full"
                >
                  <option value="AED">AED</option>
                  <option value="QAR">QAR</option>
                  <option value="OMR">OMR</option>
                  <option value="BHD">BHD</option>
                  <option value="SAR">SAR</option>
                  <option value="KWD">KWD</option>
                  <option value="USD">USD</option>
                </select>
              </div>
            </div>
          </div>

          {/* Contact Information */}
          <div className="space-y-4 pb-6">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-primary-100 text-primary-600 flex items-center justify-center font-semibold text-sm">6</div>
              <h3 className="text-lg font-semibold text-gray-900">Contact Information</h3>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input
                label="WhatsApp Number"
                placeholder="077 402 2956"
                value={formData.contact_info.whatsapp}
                onChange={(e) => setFormData({
                  ...formData,
                  contact_info: { ...formData.contact_info, whatsapp: e.target.value }
                })}
              />
              <Input
                type="email"
                label="Email"
                placeholder="hypermarket.dewan@gmail.com"
                value={formData.contact_info.email}
                onChange={(e) => setFormData({
                  ...formData,
                  contact_info: { ...formData.contact_info, email: e.target.value }
                })}
              />
            </div>
            <Input
              label="Address"
              placeholder="83/2, Chatham Street, Colombo 01"
              value={formData.contact_info.address}
              onChange={(e) => setFormData({
                ...formData,
                contact_info: { ...formData.contact_info, address: e.target.value }
              })}
            />
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-6 border-t-2 border-gray-200 bg-gray-50 -mx-6 -mb-6 px-6 py-4 rounded-b-xl sticky bottom-0">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setModalOpen(false)
                resetForm()
              }}
            >
              Cancel
            </Button>
            <Button type="submit" loading={createMutation.isLoading}>
              Create Project
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  )
}
~~~

Current code:
~~~
import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { getProjects, createProject, deleteProject } from '../api'
import { FolderKanban, Plus, Trash2, Users, Briefcase } from 'lucide-react'
import { Badge } from '../components/ui/Badge'
import { Button } from '../components/ui/Button'
import { Modal } from '../components/ui/Modal'
import { TableSkeleton } from '../components/ui/Skeleton'
import { Input } from '../components/ui/Input'
import { useAuthStore } from '../stores/authStore'
import toast from 'react-hot-toast'
import { format } from 'date-fns'
import { clsx } from 'clsx'
import CountrySelector from '../components/CountrySelector'
import { ALL_COUNTRIES } from '../constants/countries'

const INDUSTRIES = ['Hypermarket', 'Restaurant', 'Construction', 'Healthcare', 'Hospitality', 'Manufacturing', 'Retail', 'Logistics']
const CURRENCY_BY_COUNTRY = {
  UAE: 'AED',
  Qatar: 'QAR',
  Oman: 'OMR',
  Bahrain: 'BHD',
  'Saudi Arabia': 'SAR',
  Kuwait: 'KWD',
  'United Arab Emirates': 'AED'
}

function parseCountries(rawCountries) {
  if (!rawCountries) return []
  if (Array.isArray(rawCountries)) return rawCountries
  if (typeof rawCountries !== 'string') return []

  try {
    const parsed = JSON.parse(rawCountries)
    return Array.isArray(parsed) ? parsed : []
  } catch (_) {
    return []
  }
}

export default function Projects() {
  const { user } = useAuthStore()
  const queryClient = useQueryClient()
  const [page, setPage] = useState(1)
  const [statusFilter, setStatusFilter] = useState('')
  const [countryFilter, setCountryFilter] = useState('')
  const [industryFilter, setIndustryFilter] = useState('')
  const [priorityFilter, setPriorityFilter] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [modalOpen, setModalOpen] = useState(false)

  // Form state for new project
  const [formData, setFormData] = useState({
    title: '',
    client_name: '',
    industry_type: '',
    description: '',
    country_of_recruitment: [],
    targetCountries: [],
    priority: 'normal',
    total_positions: 0,
    start_date: '',
    interview_date: '',
    end_date: '',
    currency: 'AED',
    benefits: {
      accommodation: false,
      transport: false,
      meals: false,
      visa: false,
      ticket: false
    },
    salary_info: {
      min: '',
      max: '',
      currency: 'AED'
    },
    client_details: {
      mobile: '',
      email: '',
      address: '',
      special_details: ''
    },
    contact_info: {
      whatsapp: '',
      email: '',
      address: ''
    }
  })

  const { data, isLoading } = useQuery({
    queryKey: ['projects', { 
      page, 
      status: statusFilter || undefined,
      country: countryFilter || undefined,
      industry_type: industryFilter || undefined,
      priority: priorityFilter || undefined,
      search: debouncedSearch || undefined
    }],
    queryFn: () => getProjects({ 
      page, 
      status: statusFilter || undefined,
      country: countryFilter || undefined,
      industry_type: industryFilter || undefined,
      priority: priorityFilter || undefined,
      search: debouncedSearch || undefined
    })
  })

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 300)
    return () => clearTimeout(timer)
  }, [searchQuery])

  useEffect(() => {
    const primaryCountry = formData.country_of_recruitment?.[0]
    if (!primaryCountry) return

    const mappedCurrency = CURRENCY_BY_COUNTRY[primaryCountry]
    if (!mappedCurrency || mappedCurrency === formData.currency) return

    setFormData((prev) => ({
      ...prev,
      currency: mappedCurrency,
      salary_info: {
        ...prev.salary_info,
        currency: mappedCurrency,
      },
    }))
  }, [formData.country_of_recruitment, formData.currency])

  const createMutation = useMutation({
    mutationFn: createProject,
    onSuccess: () => {
      queryClient.invalidateQueries(['projects'])
      setModalOpen(false)
      resetForm()
      toast.success('Project created successfully')
    },
    onError: (error) => {
      toast.error(error.response?.data?.error || 'Failed to create project')
    }
  })

  const deleteMutation = useMutation({
    mutationFn: deleteProject,
    onSuccess: () => {
      queryClient.invalidateQueries(['projects'])
      toast.success('Project deleted successfully')
    },
    onError: (error) => {
      toast.error(error.response?.data?.error || 'Failed to delete project')
    }
  })

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!formData.title || !formData.client_name || !formData.industry_type || formData.country_of_recruitment.length === 0) {
      toast.error('Please fill in all required fields')
      return
    }

    const payload = {
      ...formData,
      countries: formData.country_of_recruitment,
      targetCountries: formData.country_of_recruitment,
      country_of_recruitment: formData.country_of_recruitment,
      currency: formData.currency || formData.salary_info.currency,
      salary_info: {
        ...formData.salary_info,
        currency: formData.currency || formData.salary_info.currency
      },
      contact_info: {
        ...formData.contact_info,
        whatsapp: formData.client_details.mobile,
        email: formData.client_details.email,
        address: formData.client_details.address
      },
      client_details: {
        ...formData.client_details
      }
    }

    createMutation.mutate(payload)
  }

  const handleDelete = (id) => {
    if (window.confirm('Are you sure you want to delete this project? All related jobs will be unlinked.')) {
      deleteMutation.mutate(id)
    }
  }

  const resetForm = () => {
    setFormData({
      title: '',
      client_name: '',
      industry_type: '',
      description: '',
      country_of_recruitment: [],
      targetCountries: [],
      priority: 'normal',
      total_positions: 0,
      start_date: '',
      interview_date: '',
      end_date: '',
      currency: 'AED',
      benefits: {
        accommodation: false,
        transport: false,
        meals: false,
        visa: false,
        ticket: false
      },
      salary_info: {
        min: '',
        max: '',
        currency: 'AED'
      },
      client_details: {
        mobile: '',
        email: '',
        address: '',
        special_details: ''
      },
      contact_info: {
        whatsapp: '',
        email: '',
        address: ''
      }
    })
  }

  const projectsList = data?.data || []
  const canCreateProject = user?.role === 'admin' || user?.role === 'supervisor'
  const canDeleteProject = user?.role === 'admin'

  return (
    <div className="p-6 lg:p-8 animate-fade-in">
      {/* Header */}
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Projects</h1>
          <p className="text-gray-600 mt-1">Manage multi-country recruitment projects</p>
        </div>
        {canCreateProject && (
          <Button onClick={() => setModalOpen(true)}>
            <Plus size={20} className="mr-2" />
            New Project
          </Button>
        )}
      </div>

      {/* Filters */}
      <div className="card mb-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Search</label>
            <input
              type="text"
              placeholder="Search projects..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="input w-full"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="input w-full"
            >
              <option value="">All Status</option>
              <option value="planning">Planning</option>
              <option value="active">Active</option>
              <option value="on_hold">On Hold</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Country</label>
            <select
              value={countryFilter}
              onChange={(e) => setCountryFilter(e.target.value)}
              className="input w-full"
            >
              <option value="">All Countries</option>
              {ALL_COUNTRIES.map(country => (
                <option key={country} value={country}>{country}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Industry</label>
            <select
              value={industryFilter}
              onChange={(e) => setIndustryFilter(e.target.value)}
              className="input w-full"
            >
              <option value="">All Industries</option>
              {INDUSTRIES.map(industry => (
                <option key={industry} value={industry}>{industry}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Priority</label>
            <select
              value={priorityFilter}
              onChange={(e) => setPriorityFilter(e.target.value)}
              className="input w-full"
            >
              <option value="">All Priority</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </div>
        </div>
      </div>

      {/* Projects Table */}
      <div className="card overflow-hidden">
        {isLoading ? (
          <TableSkeleton rows={6} cols={8} />
        ) : projectsList.length === 0 ? (
          <div className="py-12 text-center text-gray-500">
            <FolderKanban className="mx-auto h-12 w-12 text-gray-300 mb-2" />
            <p className="font-medium">No projects found</p>
            <p className="text-sm mt-1">Create your first project to get started.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Project</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Client</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Countries</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Industry</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Status</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Priority</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Positions</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Interview Date</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Team</th>
                  <th className="text-left py-3 px-4 text-sm font-medium text-gray-700">Actions</th>
                </tr>
              </thead>
              <tbody>
                {projectsList.map((project) => {
                  const rawCountries = project.country_of_recruitment || project.countries || []
                  const countries = parseCountries(rawCountries)
                  
                  return (
                    <tr key={project.id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                      <td className="py-3 px-4">
                        <Link to={`/projects/${project.id}`} className="font-medium text-gray-900 hover:text-primary-600">
                          {project.title}
                        </Link>
                      </td>
                      <td className="py-3 px-4 text-gray-600">{project.client_name}</td>
                      <td className="py-3 px-4">
                        <div className="flex flex-wrap gap-1">
                          {countries?.slice(0, 2).map((country) => (
                            <span key={country} className="text-xs px-2 py-1 bg-blue-50 text-blue-700 rounded-md">
                              {country}
                            </span>
                          ))}
                          {countries?.length > 2 && (
                            <span className="text-xs px-2 py-1 bg-gray-100 text-gray-600 rounded-md">
                              +{countries.length - 2}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-gray-600 text-sm">{project.industry_type}</td>
                      <td className="py-3 px-4">
                        <Badge status={project.status} />
                      </td>
                      <td className="py-3 px-4">
                        <Badge status={project.priority} />
                      </td>
                      <td className="py-3 px-4 text-gray-600">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{project.filled_positions || 0}</span>
                          <span className="text-gray-400">/</span>
                          <span>{project.total_positions || 0}</span>
                        </div>
                      </td>
                      <td className="py-3 px-4 text-gray-600 text-sm">
                        {project.interview_date ? format(new Date(project.interview_date), 'MMM dd, yyyy') : '-'}
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-1">
                          <Users size={16} className="text-gray-400" />
                          <span className="text-sm text-gray-600">{project.team_count || 0}</span>
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex gap-2 items-center">
                          <Link
                            to={`/projects/${project.id}`}
                            className="text-primary-600 hover:text-primary-700 font-medium text-sm"
                          >
                            View
                          </Link>
                          {project.job_count > 0 && (
                            <>
                              <span className="text-gray-300">|</span>
                              <div className="flex items-center gap-1 text-gray-500 text-sm">
                                <Briefcase size={14} />
                                <span>{project.job_count}</span>
                              </div>
                            </>
                          )}
                          {canDeleteProject && (
                            <>
                              <span className="text-gray-300">|</span>
                              <button
                                onClick={() => handleDelete(project.id)}
                                className="text-red-600 hover:text-red-700"
                                title="Delete project"
                              >
                                <Trash2 size={16} />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {data?.pagination && data.pagination.totalPages > 1 && (
        <div className="mt-6 flex items-center justify-between">
          <p className="text-sm text-gray-600">
            Page {data.pagination.page} of {data.pagination.totalPages}
          </p>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
            >
              Previous
            </Button>
            <Button
              variant="secondary"
              onClick={() => setPage(p => p + 1)}
              disabled={page >= data.pagination.totalPages}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      {/* Create Project Modal */}
      <Modal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false)
          resetForm()
        }}
        title="Create New Project"
        size="xl"
      >
        <form onSubmit={handleSubmit} className="space-y-8">
          {/* Basic Information */}
          <div className="space-y-4 pb-6 border-b border-gray-200">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-primary-100 text-primary-600 flex items-center justify-center font-semibold text-sm">1</div>
              <h3 className="text-lg font-semibold text-gray-900">Basic Information</h3>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input
                label="Project Title"
                required
                placeholder="e.g., Middle East Hypermarket Expansion"
                value={formData.title}
                onChange={(e) => setFormData({ ...formData, title: e.target.value })}
              />
              <Input
                label="Client Name"
                required
                placeholder="Company name"
                value={formData.client_name}
                onChange={(e) => setFormData({ ...formData, client_name: e.target.value })}
              />
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Industry Type <span className="text-red-500">*</span>
                </label>
                <select
                  required
                  value={formData.industry_type}
                  onChange={(e) => setFormData({ ...formData, industry_type: e.target.value })}
                  className="input w-full"
                >
                  <option value="">Select industry</option>
                  {INDUSTRIES.map(industry => (
                    <option key={industry} value={industry}>{industry}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Priority</label>
                <select
                  value={formData.priority}
                  onChange={(e) => setFormData({ ...formData, priority: e.target.value })}
                  className="input w-full"
                >
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
              <textarea
                rows={3}
                placeholder="Project description..."
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                className="input w-full resize-none"
              />
            </div>
          </div>

          {/* Countries */}
          <div className="pb-6 border-b border-gray-200">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 rounded-full bg-primary-100 text-primary-600 flex items-center justify-center font-semibold text-sm">2</div>
              <label className="text-lg font-semibold text-gray-900">
                Country Of Recruitment <span className="text-red-500">*</span>
              </label>
            </div>
            <CountrySelector
              value={formData.country_of_recruitment}
              onChange={(selected) => setFormData((prev) => ({
                ...prev,
                country_of_recruitment: selected,
                targetCountries: selected,
              }))}
            />
          </div>

          {/* Timeline */}
          <div className="space-y-4 pb-6 border-b border-gray-200">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-primary-100 text-primary-600 flex items-center justify-center font-semibold text-sm">3</div>
              <h3 className="text-lg font-semibold text-gray-900">Timeline</h3>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Input
                type="date"
                label="Start Date"
                value={formData.start_date}
                onChange={(e) => setFormData({ ...formData, start_date: e.target.value })}
              />
              <Input
                type="date"
                label="Interview Start Date"
                value={formData.interview_date}
                onChange={(e) => setFormData({ ...formData, interview_date: e.target.value })}
              />
              <Input
                type="date"
                label="End Date"
                value={formData.end_date}
                onChange={(e) => setFormData({ ...formData, end_date: e.target.value })}
              />
            </div>
          </div>

          {/* Positions & Benefits */}
          <div className="space-y-4 pb-6 border-b border-gray-200">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-primary-100 text-primary-600 flex items-center justify-center font-semibold text-sm">4</div>
              <h3 className="text-lg font-semibold text-gray-900">Positions & Benefits</h3>
            </div>
            <Input
              type="number"
              label="Total Positions"
              min="0"
              value={formData.total_positions}
              onChange={(e) => setFormData({ ...formData, total_positions: parseInt(e.target.value) || 0 })}
            />
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-3">Benefits Included</label>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                {['accommodation', 'transport', 'meals', 'visa', 'ticket'].map(benefit => (
                  <label key={benefit} className={clsx(
                    "flex items-center gap-2 p-3 border-2 rounded-lg cursor-pointer transition-all",
                    formData.benefits[benefit]
                      ? "border-primary-500 bg-primary-50"
                      : "border-gray-200 hover:border-gray-300 hover:bg-gray-50"
                  )}>
                    <input
                      type="checkbox"
                      checked={formData.benefits[benefit]}
                      onChange={(e) => setFormData({
                        ...formData,
                        benefits: { ...formData.benefits, [benefit]: e.target.checked }
                      })}
                      className="rounded text-primary-600 focus:ring-primary-500 w-4 h-4"
                    />
                    <span className="text-sm font-medium text-gray-700 capitalize">{benefit}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>

          {/* Salary Range */}
          <div className="space-y-4 pb-6 border-b border-gray-200">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-primary-100 text-primary-600 flex items-center justify-center font-semibold text-sm">5</div>
              <h3 className="text-lg font-semibold text-gray-900">Salary Information</h3>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Input
                type="number"
                label="Minimum Salary"
                placeholder="1500"
                value={formData.salary_info.min}
                onChange={(e) => setFormData({
                  ...formData,
                  salary_info: { ...formData.salary_info, min: e.target.value }
                })}
              />
              <Input
                type="number"
                label="Maximum Salary"
                placeholder="2000"
                value={formData.salary_info.max}
                onChange={(e) => setFormData({
                  ...formData,
                  salary_info: { ...formData.salary_info, max: e.target.value }
                })}
              />
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Currency</label>
                <select
                  value={formData.currency}
                  onChange={(e) => setFormData({
                    ...formData,
                    currency: e.target.value,
                    salary_info: { ...formData.salary_info, currency: e.target.value }
                  })}
                  className="input w-full"
                >
                  <option value="AED">AED</option>
                  <option value="QAR">QAR</option>
                  <option value="OMR">OMR</option>
                  <option value="BHD">BHD</option>
                  <option value="SAR">SAR</option>
                  <option value="KWD">KWD</option>
                  <option value="USD">USD</option>
                </select>
              </div>
            </div>
          </div>

          {/* Client Information */}
          <div className="space-y-4 pb-6">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-full bg-primary-100 text-primary-600 flex items-center justify-center font-semibold text-sm">6</div>
              <h3 className="text-lg font-semibold text-gray-900">Client Information</h3>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input
                label="Client Mobile Number"
                placeholder="077 402 2956"
                value={formData.client_details.mobile}
                onChange={(e) => setFormData({
                  ...formData,
                  client_details: { ...formData.client_details, mobile: e.target.value }
                })}
              />
              <Input
                type="email"
                label="Email"
                placeholder="hypermarket.dewan@gmail.com"
                value={formData.client_details.email}
                onChange={(e) => setFormData({
                  ...formData,
                  client_details: { ...formData.client_details, email: e.target.value }
                })}
              />
            </div>
            <Input
              label="Address"
              placeholder="83/2, Chatham Street, Colombo 01"
              value={formData.client_details.address}
              onChange={(e) => setFormData({
                ...formData,
                client_details: { ...formData.client_details, address: e.target.value }
              })}
            />
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Special Details</label>
              <textarea
                rows={3}
                className="input w-full resize-none"
                placeholder="Special details for handlers..."
                value={formData.client_details.special_details}
                onChange={(e) => setFormData({
                  ...formData,
                  client_details: { ...formData.client_details, special_details: e.target.value }
                })}
              />
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3 pt-6 border-t-2 border-gray-200 bg-gray-50 -mx-6 -mb-6 px-6 py-4 rounded-b-xl sticky bottom-0">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setModalOpen(false)
                resetForm()
              }}
            >
              Cancel
            </Button>
            <Button type="submit" loading={createMutation.isLoading}>
              Create Project
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  )
}

~~~

## recruitment-system/frontend/src/styles/applications.css

Previous code:
~~~
(File did not exist at baseline commit)
~~~

Current code:
~~~
.applications-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(290px, 1fr));
  gap: 1rem;
}

.application-card {
  border: 1px solid #e5e7eb;
  border-radius: 1rem;
  background: linear-gradient(145deg, #ffffff, #f8fbff);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}

.application-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08);
}

.application-card-compact {
  padding: 0.75rem;
}

.application-card-expanded {
  padding: 1rem;
}

~~~
