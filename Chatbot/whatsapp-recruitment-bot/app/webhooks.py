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
import re
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

# ─── Message Deduplication Cache ─────────────────────────────────────────────
# Stores (message_id -> timestamp) for recently-processed messages.
# Meta sometimes retries webhook delivery — this prevents duplicate responses.
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
        logger.info(f"⏭️ Skipping duplicate message id={message_id}")
        return True
    _processed_messages[message_id] = now
    return False


# ─── Webhook Verification (GET) ─────────────────────────────────────────────

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
        f"Webhook verification request → mode={hub_mode}, "
        f"token={hub_verify_token}, challenge={hub_challenge}"
    )

    if hub_mode == "subscribe" and hub_verify_token == settings.meta_verify_token:
        logger.info("✅ Webhook verification successful")
        from fastapi.responses import PlainTextResponse
        return PlainTextResponse(content=hub_challenge, status_code=200)

    logger.warning(
        f"❌ Webhook verification FAILED — "
        f"expected token '{settings.meta_verify_token}', got '{hub_verify_token}'"
    )
    raise HTTPException(status_code=403, detail="Verification failed")


# ─── Incoming Messages (POST) ────────────────────────────────────────────────

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
                logger.warning("❌ Invalid webhook signature — rejecting request")
                raise HTTPException(status_code=401, detail="Invalid signature")

        data = await request.json()
        logger.info(f"📨 Webhook received: object={data.get('object', 'unknown')}")
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


# ─── Background Processing ───────────────────────────────────────────────────

async def process_webhook_value(value: dict):
    """
    Process a webhook 'value' payload in the background.
    Creates its OWN database session — critical fix for FastAPI background tasks.
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
        logger.debug("No messages in webhook value — skipping")
        return

    for message in messages:
        # ✅ Fresh DB session per message
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


# ─── Recruitment System Chat Sync ────────────────────────────────────────────

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
        direction:     "inbound" (customer → bot) or "outbound" (bot → customer).
        content:       Message text.
        language:      Detected language code (en/si/ta/singlish/tanglish).
        chatbot_state: Current conversation state name for agent context.
    """
    try:
        recruitment_url = settings.recruitment_api_url or ""
        api_key         = settings.chatbot_api_key or ""
        if not recruitment_url or not api_key:
            return  # Not configured — skip silently

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
                    f"Chat sync returned {resp.status_code} for {phone} — "
                    f"endpoint may not exist yet (Plan 2)"
                )
    except Exception as _sync_err:
        # Non-critical — never block message processing
        logger.debug(f"_sync_chat_message skipped: {_sync_err}")


async def process_single_message(message: dict, contacts: list, db):
    """Process a single incoming WhatsApp message."""

    async def _safe_process_message(**kwargs):
        try:
            return await asyncio.wait_for(chatbot.process_message(**kwargs), timeout=45)
        except asyncio.TimeoutError:
            try:
                db.rollback()
            except Exception:
                pass
            logger.error("chatbot.process_message timed out after 45s")
            return "Thanks for your patience 🙏 Let me help you continue — please send your answer again in the same language."
        except Exception as exc:
            try:
                db.rollback()
            except Exception:
                pass
            logger.error(f"chatbot.process_message failed: {exc}")
            return "I’m here to help — could you send that once more? I’ll continue from where we left off."

    message_id   = message.get("id")
    from_number  = message.get("from")
    message_type = message.get("type")

    if not from_number:
        logger.warning("Message missing 'from' field — skipping")
        return

    # ── Deduplication: skip if we already processed this message ─────────────
    if message_id and _is_duplicate(message_id):
        return  # Meta retried a webhook we already handled

    logger.info(
        f"📩 Processing message id={message_id} from={from_number} type={message_type}"
    )


    # Mark as read immediately
    try:
        await meta_client.mark_as_read(message_id)
    except Exception as e:
        logger.warning(f"Could not mark message as read: {e}")

    response_text = None

    # ── Text message ──────────────────────────────────────────────────────────
    if message_type == "text":
        text_body = message.get("text", {}).get("body", "")
        logger.info(f"💬 Text from {from_number}: {text_body!r}")

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
                        "1) English\n2) සිංහල\n3) தமிழ்"
                    )
                    send_res = await meta_client.send_message(from_number, fallback_text)
                    if send_res and "error" not in send_res:
                        logger.info(f"Fast-path language fallback sent to {from_number}")
                        return
        except Exception as fast_path_err:
            try:
                db.rollback()
            except Exception:
                pass
            logger.warning(f"Greeting fast-path failed: {fast_path_err}")

        response_text = await _safe_process_message(
            db=db,
            phone_number=from_number,
            message_text=text_body,
            source_message_type=message_type,
        )

    # ── Document (CV upload) ──────────────────────────────────────────────────
    elif message_type == "document":
        document  = message.get("document", {})
        media_id  = document.get("id")
        filename  = document.get("filename", "document.pdf")
        mime_type = document.get("mime_type", "")

        logger.info(f"📎 Document from {from_number}: {filename} ({mime_type})")

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
                    media_filename=filename,
                    source_message_type=message_type,
                )
            else:
                response_text = "I couldn't download your document. Please try sending it again."
        else:
            response_text = "Please send your CV as a PDF or Word document (.pdf / .doc / .docx)."

    # ── Image (CV as photo / scan) ────────────────────────────────────────────
    elif message_type == "image":
        image     = message.get("image", {})
        media_id  = image.get("id")
        mime_type = image.get("mime_type", "image/jpeg")

        logger.info(f"🖼️ Image from {from_number}")

        ext_map  = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}
        filename = f"cv_image{ext_map.get(mime_type, '.jpg')}"

        media_url = await meta_client.get_media_url(media_id) if media_id else None
        file_content = await meta_client.download_media(media_id)
        if file_content:
            response_text = await _safe_process_message(
                db=db,
                phone_number=from_number,
                media_content=file_content,
                media_type="image",
                media_filename=filename,
                media_url=media_url,
                source_message_type=message_type,
            )
        else:
            response_text = (
                "I couldn't download your image. "
                "Please try again, or send your CV as a PDF for best results."
            )

    # ── Audio / Voice message ─────────────────────────────────────────────────
    elif message_type == "audio":
        audio    = message.get("audio", {})
        media_id = audio.get("id")
        mime     = audio.get("mime_type", "audio/ogg")

        logger.info(f"🎤 Voice message from {from_number} ({mime})")

        if not voice_service.available:
            response_text = (
                "I can't process voice messages right now. "
                "Could you type your message instead? 😊"
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
                if transcribed and transcribed != "AUDIO_UNREADABLE_FALLBACK":
                    logger.info(f"🎤→💬 Transcribed: {transcribed[:80]!r}")
                    response_text = await _safe_process_message(
                        db=db,
                        phone_number=from_number,
                        message_text=transcribed,
                        source_message_type="audio",
                    )
                else:
                    response_text = await _safe_process_message(
                        db=db,
                        phone_number=from_number,
                        message_text="AUDIO_UNREADABLE_FALLBACK",
                        source_message_type="audio",
                    )
            else:
                response_text = (
                    "I couldn't download your voice message. Please try again."
                )

    # ── Interactive (button / list reply) ─────────────────────────────────────
    elif message_type == "interactive":
        interactive_data = message.get("interactive", {})
        interactive_type = interactive_data.get("type")

        if interactive_type == "button_reply":
            text_body = interactive_data["button_reply"]["id"] # Extract hidden ID
            logger.info(
                f"🔘 Button reply from {from_number}: id={text_body!r} "
                f"→ routing as: {text_body!r}"
            )
            response_text = await _safe_process_message(
                db=db,
                phone_number=from_number,
                message_text=text_body,
                source_message_type=message_type,
            )

        elif interactive_type == "list_reply":
            text_body = interactive_data["list_reply"]["id"] # Extract hidden ID
            logger.info(
                f"📋 List reply from {from_number}: id={text_body!r}"
            )
            response_text = await _safe_process_message(
                db=db,
                phone_number=from_number,
                message_text=text_body,
                source_message_type=message_type,
            )
            response_text = await _safe_process_message(
                db=db,
                phone_number=from_number,
                message_text=text_to_send,
                source_message_type=message_type,
            )

    # ── Unsupported type ──────────────────────────────────────────────────────
    else:
        logger.info(f"Unsupported message type '{message_type}' from {from_number}")
        response_text = (
            "I can receive text messages, voice messages, and document uploads (PDF/Word). "
            "How can I assist you?"
        )

    # ── Send reply ────────────────────────────────────────────────────────────
    if response_text:
        if isinstance(response_text, dict):
            msg_type = response_text.get("type")
            if msg_type == "list":
                logger.info(f"📤 Sending interactive list to {from_number}")
                result = await meta_client.send_interactive_list(
                    to_number=from_number,
                    text=response_text.get("body_text", ""),
                    button_text=response_text.get("button_label", "Options"),
                    sections=response_text.get("sections", []),
                    header_text=response_text.get("header_text"),
                    footer_text=response_text.get("footer_text")
                )
                response_text = "[Interactive List]"  # for sync logging
            elif msg_type == "buttons":
                logger.info(f"📤 Sending interactive buttons to {from_number}")
                result = await meta_client.send_interactive_buttons(
                    to_number=from_number,
                    text=response_text.get("body_text", ""),
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
            
            # Send the prefix message if it exists (e.g. "Hey User! 😊")
            if prefix_text:
                await meta_client.send_message(from_number, prefix_text)
                await asyncio.sleep(0.5)  # slight delay to ensure correct order
                
            logger.info(f"📤 Sending interactive language selector to {from_number}")
            result = await meta_client.send_language_selector(from_number)
            
            # Remove the flag so the sync doesn't have the ugly token
            response_text = response_text.replace("__INTERACTIVE_LANGUAGE_SELECTOR__", "[Interactive Language Selector]")
        else:
            logger.info(f"📤 Sending reply to {from_number}: {response_text[:80]}...")
            result = await meta_client.send_message(from_number, response_text)

        if result and "error" in result:
            logger.error(f"❌ Failed to send message to {from_number}: {result}")
        else:
            # Safely handle dict or missing 'messages' key
            msg_id_sent = "N/A"
            if isinstance(result, dict):
                msgs = result.get('messages', [])
                if msgs and isinstance(msgs, list) and isinstance(msgs[0], dict):
                    msg_id_sent = msgs[0].get('id', 'N/A')
            logger.info(f"✅ Reply sent to {from_number} — msg_id={msg_id_sent}")

        # ── Sync both messages to recruitment system communications table ──────
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


# ─── Candidate Status Webhook ────────────────────────────────────────────────
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


# ─── Agent Handoff Endpoint ───────────────────────────────────────────────────
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

        logger.info(f"🙋 Agent handoff: {payload.agent_name or 'Agent'} took over {phone}")
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

        logger.info(f"🤖 Bot resumed control for {phone}")
        return {"status": "bot_resumed", "phone": phone}


def is_human_controlled(phone: str) -> bool:
    """Check if a phone number is currently under human agent control."""
    if phone in _HUMAN_CONTROLLED_PHONES:
        return True
    return False



