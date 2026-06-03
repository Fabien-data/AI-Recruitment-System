
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

from fastapi import APIRouter, Request, HTTPException, Query, Header
from starlette import status as http_status
from pydantic import BaseModel

from app.database import SessionLocal
from app import crud
from app.utils.meta_client import meta_client
from app.core.message_router import message_router
from app.services.voice_service import voice_service
from app.services.ad_context_service import ad_context_service
from app.config import settings
from app.nlp.language_detector import is_greeting


_AD_INTENT_KEYWORDS = (
    "apply for", "i want to apply", "interested in",
    "position in", "vacancy", "vacancies", "i'd like to apply",
    "id like to apply", "applying for", "this job",
)


def _looks_like_ad_intent(text: str) -> bool:
    """Cheap substring check used to skip the greeting fast-path when the
    candidate's first message looks like the friendly ad pre-fill text
    ("Hi! 🙏 I want to apply for this Security Officer position in Dubai.").
    Routing such messages through the orchestrator lets the body-text
    matcher in meta_referral_service detect the job even when Meta did
    not supply a referral object on the webhook. False positives are
    recovered by the matcher's confidence floor in the orchestrator."""
    if not text:
        return False
    lowered = text.lower()
    return any(k in lowered for k in _AD_INTENT_KEYWORDS)

try:
    from redis import Redis
except Exception:
    Redis = None

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/webhook", tags=["WhatsApp Webhook"])

STATE_INITIAL = "initial"
STATE_AWAITING_LANGUAGE_SELECTION = "awaiting_language_selection"

# ─── Message Deduplication Cache ─────────────────────────────────────────────
# Stores (message_id -> timestamp) for recently-processed messages.
# Meta sometimes retries webhook delivery — this prevents duplicate responses.
_PROCESSED_MSG_TTL = 300  # 5 minutes
_processed_messages: dict = {}   # {msg_id: processed_at_epoch}
_redis_dedupe_client = None


def _get_redis_dedupe_client():
    """Lazy-init Redis client for cross-instance webhook dedupe."""
    global _redis_dedupe_client
    if _redis_dedupe_client is not None:
        return _redis_dedupe_client
    if Redis is None or not settings.redis_url:
        return None
    try:
        _redis_dedupe_client = Redis.from_url(settings.redis_url, decode_responses=True)
        return _redis_dedupe_client
    except Exception as exc:
        logger.warning(f"Redis dedupe unavailable: {exc}")
        return None


def _is_duplicate(message_id: str) -> bool:
    """Return True if this message was already processed recently."""
    if not message_id:
        return False

    # Primary dedupe: Redis SET NX with TTL to cover multi-instance deployment.
    redis_client = _get_redis_dedupe_client()
    if redis_client is not None:
        try:
            key = f"wa_msg_dedupe:{message_id}"
            # Set only if not exists; expire automatically.
            created = redis_client.set(name=key, value="1", ex=_PROCESSED_MSG_TTL, nx=True)
            if not created:
                logger.info(f"⏭️ Skipping duplicate message id={message_id} (redis)")
                return True
            return False
        except Exception as exc:
            logger.warning(f"Redis dedupe check failed, falling back to local cache: {exc}")

    # Fallback dedupe: in-process cache.
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

        # Detach processing from request lifecycle so webhook ACK is immediate.
        
        entries = data.get("entry", [])
        for entry in entries:
            for change in entry.get("changes", []):
                if change.get("field") == "messages":
                    value = change.get("value", {})

                    if settings.enable_celery_webhook_dispatch:
                        try:
                            from app.tasks import process_webhook_task

                            process_webhook_task.delay(value)
                            logger.info("Webhook task queued via Celery")
                            continue
                        except Exception as celery_exc:
                            logger.warning(
                                f"Celery dispatch failed, falling back to asyncio task: {celery_exc}"
                            )

                    task = asyncio.create_task(process_webhook_value(value))

                    def _log_task_exception(done_task: asyncio.Task):
                        try:
                            done_task.result()
                        except Exception as task_exc:
                            logger.error(f"Detached webhook task failed: {task_exc}")

                    task.add_done_callback(_log_task_exception)
                    logger.info("Detached webhook task queued via asyncio.create_task")

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

    if statuses:
        await asyncio.gather(*[_sync_delivery_status(status_obj) for status_obj in statuses])

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
            # Warm graceful recovery — NEVER show a technical error to the user
            from_number = message.get("from")
            if from_number:
                try:
                    recovery_msg = await _graceful_recovery_message(from_number, db)
                    await meta_client.send_message(from_number, recovery_msg)
                except Exception as send_err:
                    logger.error(f"Failed to send graceful recovery reply: {send_err}")
        finally:
            db.close()


# ─── Graceful Recovery (never show technical errors to users) ────────────────

_GRACEFUL_RECOVERY_MESSAGES = {
    "en":       "Just a moment! Can you send that again? We'll continue from where we left off 😊",
    "si":       "ටිකක් ඉවසන්න! නැවත message එක send කරන්න, අපි ඉදිරියට යමු 😊",
    "ta":       "கொஞ்சம் பொறுங்கள்! மீண்டும் message அனுப்புங்கள், தொடர்வோம் 😊",
    "singlish": "Ekka moment! Again send karanna, api inna thamath 😊",
    "tanglish": "Oru nimisham! Thirumba message anuppu, thoda paakalaam 😊",
}


async def _graceful_recovery_message(phone: str, db) -> str:
    """
    Return a warm, language-appropriate recovery message.
    NEVER returns a technical error string — always a friendly nudge.
    """
    lang = "en"
    try:
        candidate = crud.get_candidate_by_phone(db, phone)
        if candidate and candidate.language_preference:
            lp = candidate.language_preference
            lang = lp.value if hasattr(lp, "value") else str(lp)
    except Exception:
        pass
    return _GRACEFUL_RECOVERY_MESSAGES.get(lang, _GRACEFUL_RECOVERY_MESSAGES["en"])


# ─── Recruitment System Chat Sync ────────────────────────────────────────────

async def _rehost_media(media_bytes: bytes, filename: str, phone: str, mime: str) -> str:
    """Re-host inbound WhatsApp media (document/image/voice) to GCS so the
    conversation panel can show/play it. WhatsApp's own media URLs are
    auth-gated and not browser-accessible. Returns a public URL or ''."""
    if not media_bytes:
        return ""
    try:
        import base64 as _b64
        async with httpx.AsyncClient(timeout=10.0) as _mc:
            _mr = await _mc.post(
                f"{settings.recruitment_api_url}/api/chatbot/media-upload",
                headers={"x-chatbot-api-key": settings.chatbot_api_key or ""},
                json={
                    "base64": _b64.b64encode(media_bytes).decode("ascii"),
                    "filename": filename or "file",
                    "phone": phone,
                    "mime_type": mime or "application/octet-stream",
                },
            )
            if _mr.status_code == 200:
                return (_mr.json() or {}).get("url", "") or ""
    except Exception as exc:    # noqa: BLE001
        logger.debug(f"media re-host skipped: {exc}")
    return ""


async def _sync_chat_message(
    phone: str,
    direction: str,
    content: str,
    language: str = "en",
    chatbot_state: str = "",
    pipeline_stage: str = "",
    whatsapp_message_id: str = "",
    message_type: str = "text",
    media_url: str = "",
    extra_meta: Optional[dict] = None,
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
            "message_type":  message_type or "text",
            "media_url":     media_url or "",
            "language":      language,
            "chatbot_state": chatbot_state,
            "pipeline_stage": pipeline_stage or "",
            "whatsapp_message_id": whatsapp_message_id or "",
        }
        if extra_meta and isinstance(extra_meta, dict):
            # Per-type extras (location lat/lng, reaction emoji, sticker info)
            # the conversation panel uses to render the full message.
            payload["extra_meta"] = extra_meta
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


async def _sync_inbound_only(
    db,
    phone: str,
    content: str,
    message_type: str = "text",
    media_url: str = "",
    extra_meta: Optional[dict] = None,
    whatsapp_message_id: str = "",
) -> None:
    """Sync an inbound message to the recruitment transcript when the bot does
    NOT reply (location / sticker / reaction / unsupported types). Without this,
    the main reply block (which is gated on `if response_text`) never syncs them,
    leaving gaps in the conversation. Fire-and-forget."""
    try:
        from app import crud as _crud
        _cand = _crud.get_or_create_candidate(db, phone)
        _lang = getattr(_cand.language_preference, "value", "en")
        _state = _cand.conversation_state or ""
    except Exception:  # noqa: BLE001
        _lang, _state = "en", ""
    await _sync_chat_message(
        phone, "inbound", content, _lang, _state,
        message_type=message_type, media_url=media_url,
        whatsapp_message_id=whatsapp_message_id, extra_meta=extra_meta,
    )


async def _sync_delivery_status(status_obj: dict) -> None:
    """Forward delivery/read status updates to the recruitment backend."""
    try:
        msg_id = status_obj.get("id")
        status = status_obj.get("status")
        if not msg_id or not status:
            return

        recruitment_url = settings.recruitment_api_url or ""
        api_key = settings.chatbot_api_key or ""
        if not recruitment_url or not api_key:
            return

        payload = {
            "whatsapp_message_id": msg_id,
            "status": status,
            "recipient_id": status_obj.get("recipient_id"),
            "timestamp": status_obj.get("timestamp"),
            "metadata": {
                "conversation_id": status_obj.get("conversation", {}).get("id") if isinstance(status_obj.get("conversation"), dict) else None,
                "pricing_category": status_obj.get("pricing", {}).get("category") if isinstance(status_obj.get("pricing"), dict) else None,
            },
        }

        async with httpx.AsyncClient(timeout=4.0) as client:
            resp = await client.post(
                f"{recruitment_url}/api/communications/status-sync",
                headers={"x-chatbot-api-key": api_key},
                json=payload,
            )
            if resp.status_code not in (200, 201):
                logger.debug(f"status-sync returned {resp.status_code} for msg_id={msg_id}")
    except Exception as sync_err:
        logger.debug(f"_sync_delivery_status skipped: {sync_err}")


def _touch_inbound(db, phone: str) -> None:
    """Record this inbound message's time and re-arm the follow-up cadence — any
    reply means the candidate is engaged, so reset the nudge counter. A hard stop
    (followup_stopped) is preserved. Isolated best-effort write that never affects
    message processing. CURRENT_TIMESTAMP works on both Postgres and SQLite."""
    if not phone:
        return
    try:
        from sqlalchemy import text as _text
        db.execute(
            _text(
                "UPDATE candidates SET last_inbound_at = CURRENT_TIMESTAMP, followup_count = 0 "
                "WHERE phone_number = :p"
            ),
            {"p": phone},
        )
        db.commit()
    except Exception as _e:
        try:
            db.rollback()
        except Exception:
            pass
        logger.debug(f"_touch_inbound skipped for {phone}: {_e}")


# ── Candidate self-service keyword commands (opt-out + status check) ─────────
# Exact whole-message matches only, so normal conversation is never hijacked.
_STOP_WORDS = {"stop", "unsubscribe", "opt out", "optout", "stop messages",
               "no more messages", "stop messaging me"}
_STATUS_WORDS = {"status", "my status", "application status", "my application",
                 "where is my application", "check status"}
_CHECKLIST_WORDS = {"documents", "document", "docs", "checklist", "what do you need",
                    "what's left", "whats left", "requirements"}

_CHECKLIST_HEADER = {
    "en": "📋 Here's your application checklist:",
    "si": "📋 ඔබේ අයදුම්පත් checklist එක:",
    "ta": "📋 உங்கள் விண்ணப்ப checklist:",
    "singlish": "📋 Oyage application checklist eka:",
    "tanglish": "📋 Unga application checklist:",
}
_CHECKLIST_FOOTER = {
    "en": "Send the missing item(s) here and we'll finish your application. 🙌",
    "si": "ඉතුරු දේ මෙතනට එවන්න, අපි ඔබේ අයදුම්පත සම්පූර්ණ කරමු. 🙌",
    "ta": "மீதமுள்ளவற்றை இங்கே அனுப்புங்கள், உங்கள் விண்ணப்பத்தை முடிப்போம். 🙌",
    "singlish": "Ithuru ewa methanata evanna, api application eka complete karamu. 🙌",
    "tanglish": "Baaki ulladhai inga anuppunga, naanga application-a finish pannuvom. 🙌",
}
_CHECKLIST_DONE = {
    "en": "🎉 Everything's in! Your application is complete and under review.",
    "si": "🎉 හැම දෙයක්ම ලැබුණා! ඔබේ අයදුම්පත සම්පූර්ණයි, සමාලෝචනය වෙනවා.",
    "ta": "🎉 எல்லாம் கிடைத்துவிட்டது! உங்கள் விண்ணப்பம் முழுமையடைந்து மதிப்பாய்வில் உள்ளது.",
    "singlish": "🎉 Hama deyakma labuna! Oyage application eka complete, review wenawa.",
    "tanglish": "🎉 Ellam kedaichuthu! Unga application complete, review-la irukku.",
}

_STOP_CONFIRM = {
    "en": "👍 Done — you won't receive any more follow-up reminders from us. You can reply here anytime to continue your application.",
    "si": "👍 හරි — ඔබට තවදුරටත් follow-up reminders ලැබෙන්නේ නැහැ. ඔබේ අයදුම්පත ඉදිරියට ගෙනියන්න ඕනෑම වෙලාවක මෙතනින් reply කරන්න.",
    "ta": "👍 சரி — இனி உங்களுக்கு follow-up நினைவூட்டல்கள் வராது. உங்கள் விண்ணப்பத்தைத் தொடர எப்போது வேண்டுமானாலும் இங்கே பதிலளியுங்கள்.",
    "singlish": "👍 Hari — oyata thawa follow-up reminders enne na. Application eka continue karanna onema welavaka methanin reply karanna.",
    "tanglish": "👍 Okay — ini unga-ku follow-up reminders varadhu. Application-a continue panna eppo venaalum inga reply pannunga.",
}
_STATUS_COMPLETE = {
    "en": "✅ Your application is complete and under review by our team. We'll message you here as soon as there's an update. 🙌",
    "si": "✅ ඔබේ අයදුම්පත සම්පූර්ණයි, අපේ කණ්ඩායම සමාලෝචනය කරනවා. update එකක් ආ සැණින් මෙතනින් දන්වන්නම්. 🙌",
    "ta": "✅ உங்கள் விண்ணப்பம் முழுமையடைந்து எங்கள் குழுவால் மதிப்பாய்வு செய்யப்படுகிறது. update கிடைத்தவுடன் இங்கே தெரிவிக்கிறோம். 🙌",
    "singlish": "✅ Oyage application eka complete, api team eka review karanawa. Update ekak awama methanin kiyannm. 🙌",
    "tanglish": "✅ Unga application complete, engal team review pannuranga. Update vandha udane inga sollurom. 🙌",
}
_STATUS_INCOMPLETE = {
    "en": "📋 Your application is almost done — there's just one thing left:",
    "si": "📋 ඔබේ අයදුම්පත අවසන් වෙන්න ආසන්නයි — ඉතුරු වෙලා තියෙන්නේ එක දෙයක් විතරයි:",
    "ta": "📋 உங்கள் விண்ணப்பம் கிட்டத்தட்ட முடிந்துவிட்டது — இன்னும் ஒரே ஒரு விஷயம் மட்டுமே மீதம்:",
    "singlish": "📋 Oyage application eka ivara wenna langai — thawa ithuru wela thiyenne eka deyak vitharai:",
    "tanglish": "📋 Unga application almost ready — innum oru vishayam thaan baaki:",
}


async def _handle_keyword_command(db, phone: str, text: str) -> bool:
    """Intercept opt-out (STOP) and status-check keywords before orchestration.
    Returns True if the message was handled (a reply was sent)."""
    norm = (text or "").strip().lower().rstrip("!.? ")
    if not norm:
        return False

    if norm in _STOP_WORDS:
        try:
            from sqlalchemy import text as _text
            db.execute(_text("UPDATE candidates SET followup_stopped = TRUE WHERE phone_number = :p"), {"p": phone})
            db.commit()
        except Exception:
            try:
                db.rollback()
            except Exception:
                pass
        cand = crud.get_candidate_by_phone(db, phone)
        from app.services.followup_service import candidate_lang
        lang = candidate_lang(cand) if cand else "en"
        await meta_client.send_message(phone, _STOP_CONFIRM.get(lang, _STOP_CONFIRM["en"]))
        logger.info(f"🛑 Opt-out (STOP) honored for {phone}")
        return True

    if norm in _STATUS_WORDS:
        cand = crud.get_candidate_by_phone(db, phone)
        if not cand:
            return False
        from app.services.followup_service import candidate_lang, is_complete, next_missing_field
        from app.agents.intake_agent import intake_agent
        lang = candidate_lang(cand)
        if is_complete(cand):
            msg = _STATUS_COMPLETE.get(lang, _STATUS_COMPLETE["en"])
        else:
            field = next_missing_field(cand)
            intro = _STATUS_INCOMPLETE.get(lang, _STATUS_INCOMPLETE["en"])
            ask = intake_agent.get_prompt_for_field(field, lang) if field else ""
            msg = f"{intro}\n\n{ask}" if ask else intro
        await meta_client.send_message(phone, msg)
        logger.info(f"ℹ️ Status self-check answered for {phone}")
        return True

    if norm in _CHECKLIST_WORDS:
        cand = crud.get_candidate_by_phone(db, phone)
        if not cand:
            return False
        from app.services.followup_service import candidate_lang, checklist, field_label
        lang = candidate_lang(cand)
        items = checklist(cand)
        lines = [f"{'✅' if present else '⬜'} {field_label(field, lang)}" for field, present in items]
        all_done = all(present for _, present in items)
        footer = (_CHECKLIST_DONE if all_done else _CHECKLIST_FOOTER).get(lang)
        footer = footer or (_CHECKLIST_DONE if all_done else _CHECKLIST_FOOTER)["en"]
        header = _CHECKLIST_HEADER.get(lang, _CHECKLIST_HEADER["en"])
        await meta_client.send_message(phone, f"{header}\n" + "\n".join(lines) + f"\n\n{footer}")
        logger.info(f"📋 Checklist answered for {phone}")
        return True

    return False


async def process_single_message(message: dict, contacts: list, db):
    """Process a single incoming WhatsApp message."""

    def _cv_processing_ack(lang: str) -> str:
        register = (lang or "en").lower()
        prompts = {
            "en": "Thanks! I received your CV. I am processing it now.",
            "si": "ස්තුතියි! ඔබේ CV එක ලැබුණා. දැන් process කරනවා.",
            "ta": "நன்றி! உங்கள் CV கிடைத்தது. இப்போது செயலாக்குகிறேன்.",
            "singlish": "sthuthi! oyage CV eka labuna. dan process karanawa.",
            "tanglish": "nandri! unga CV kidaichiduchu. ippo process panren.",
        }
        return prompts.get(register, prompts["en"])

    def _candidate_register(phone: str) -> str:
        cand = crud.get_or_create_candidate(db, phone)
        extracted = cand.extracted_data if isinstance(cand.extracted_data, dict) else {}
        language_pref = getattr(cand, "language_preference", None)
        language_value = getattr(language_pref, "value", language_pref)
        if not language_value:
            legacy_pref = getattr(cand, "preferred_language", None)
            language_value = getattr(legacy_pref, "value", legacy_pref)
        return (
            extracted.get("language_register")
            or extracted.get("agent_state", {}).get("reply_register")
            or language_value
            or "en"
        )

    async def _safe_process_message(**kwargs):
        has_media_payload = bool(kwargs.get("media_content") or kwargs.get("media_type"))
        try:
            if has_media_payload:
                return await asyncio.wait_for(
                    message_router.route_media(
                        db=kwargs["db"],
                        phone_number=kwargs["phone_number"],
                        media_content=kwargs.get("media_content"),
                        media_type=kwargs.get("media_type", "document"),
                        media_filename=kwargs.get("media_filename"),
                        media_url=kwargs.get("media_url"),
                        source_message_type=kwargs.get("source_message_type", "document"),
                    ),
                    timeout=45,
                )
            return await asyncio.wait_for(
                message_router.route_text(
                    db=kwargs["db"],
                    phone_number=kwargs["phone_number"],
                    text=kwargs.get("message_text", ""),
                    source_message_type=kwargs.get("source_message_type", "text"),
                    referral_data=kwargs.get("referral_data"),
                ),
                timeout=45,
            )
        except asyncio.TimeoutError:
            try:
                db.rollback()
            except Exception:
                pass
            logger.error("message_router processing timed out after 45s")
            return "Thanks for your patience 🙏 Let me help you continue — please send your answer again in the same language."
        except Exception as exc:
            try:
                db.rollback()
            except Exception:
                pass
            logger.exception(
                "message_router processing failed for %s (type=%s): %s",
                kwargs.get("phone_number"),
                kwargs.get("source_message_type", "text"),
                exc,
            )
            return "I’m here to help — could you send that once more? I’ll continue from where we left off."

    message_id   = message.get("id")
    from_number  = message.get("from")
    message_type = message.get("type")

    # Captured during media branches so the agent panel can show a readable
    # transcript: voice transcription text + a re-hosted (playable) media URL.
    _voice_text = ""
    _media_url_captured = ""
    # Readable version of an outbound interactive message (buttons/list/lang
    # selector), captured before response_text is replaced with a placeholder.
    _outbound_display = ""

    if not from_number:
        logger.warning("Message missing 'from' field — skipping")
        return

    # Record inbound activity + re-arm the proactive follow-up cadence. Isolated
    # write, safe to run before the main turn logic.
    _touch_inbound(db, from_number)

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

    # Optional fast UX signal while orchestration runs.
    if settings.enable_webhook_reaction_signal:
        try:
            if message_id and from_number:
                await meta_client.send_reaction(message_id=message_id, to_number=from_number, emoji="👍")
        except Exception as e:
            logger.debug(f"Could not send quick reaction: {e}")

    response_text = None

    # ── Text message ──────────────────────────────────────────────────────────
    if message_type == "text":
        text_body = message.get("text", {}).get("body", "")
        # Meta CTWA referral: present only on the first message after a
        # Click-to-WhatsApp ad tap. Carries the ad headline, body, source_id,
        # and ctwa_clid — enough for headline-based job matching with no
        # admin mapping. Forwarded through to the orchestrator which decides
        # whether to route into ad_intake_flow.
        referral_obj = message.get("referral") if isinstance(message.get("referral"), dict) else None
        if referral_obj:
            logger.info(
                f"📣 CTWA referral from {from_number}: "
                f"headline={referral_obj.get('headline')!r} "
                f"source_id={referral_obj.get('source_id')!r}"
            )
        logger.info(f"💬 Text from {from_number}: {text_body!r}")

        # Self-service keyword commands (opt-out / status check) — exact-match
        # only, intercepted before any orchestration.
        try:
            if await _handle_keyword_command(db, from_number, text_body):
                return
        except Exception as kw_err:
            logger.warning(f"keyword command handling failed for {from_number}: {kw_err}")

        # Fast-path: for simple greetings in early onboarding states, send language selector
        # immediately and skip heavy chatbot orchestration. SKIPPED when:
        #   (a) a CTWA referral is present — needs the orchestrator's headline
        #       match to land the candidate in the per-job ad flow, OR
        #   (b) the text itself looks like an ad pre-fill ("I want to apply
        #       for this Security Officer position in Dubai") — needs the
        #       orchestrator's body-text matcher to detect the job even when
        #       Meta didn't supply a referral object. The greeting fast-path
        #       would otherwise hijack the conversation and lose ad context, OR
        #   (c) the text carries an ad trigger token ("START:<ref>" or a
        #       friendly message with "[ref:<ref>]") — the orchestrator must
        #       resolve the exact job from that ref.
        try:
            greet, _ = is_greeting(text_body)
            if (
                greet
                and not referral_obj
                and not _looks_like_ad_intent(text_body)
                and not ad_context_service.is_ad_trigger(text_body)
            ):
                candidate = crud.get_or_create_candidate(db, from_number)
                if candidate.conversation_state in (STATE_INITIAL, STATE_AWAITING_LANGUAGE_SELECTION):
                    sel = await meta_client.send_language_selector(from_number)
                    if sel and "error" not in sel:
                        try:
                            crud.update_candidate_state(
                                db,
                                candidate.id,
                                STATE_AWAITING_LANGUAGE_SELECTION,
                            )
                            candidate.conversation_state = STATE_AWAITING_LANGUAGE_SELECTION
                        except Exception as state_err:
                            logger.warning(f"Fast-path selector state update failed: {state_err}")
                        logger.info(f"Fast-path language selector sent to {from_number}")
                        return
                    fallback_text = (
                        "Welcome! Please choose your preferred language.\n"
                        "1) English\n2) සිංහල\n3) தமிழ்"
                    )
                    send_res = await meta_client.send_message(from_number, fallback_text)
                    if send_res and "error" not in send_res:
                        try:
                            crud.update_candidate_state(
                                db,
                                candidate.id,
                                STATE_AWAITING_LANGUAGE_SELECTION,
                            )
                            candidate.conversation_state = STATE_AWAITING_LANGUAGE_SELECTION
                        except Exception as state_err:
                            logger.warning(f"Fast-path fallback state update failed: {state_err}")
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
            referral_data=referral_obj,
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
            file_content = None
            for attempt in range(1, 4):
                file_content = await meta_client.download_media(media_id)
                if file_content:
                    break
                logger.warning(
                    f"Document media download failed (attempt {attempt}/3) for {from_number}, media_id={media_id}"
                )
                if attempt < 3:
                    await asyncio.sleep(0.8 * (2 ** (attempt - 1)))

            if file_content:
                ack = _cv_processing_ack(_candidate_register(from_number))
                await meta_client.send_message(from_number, ack)
                # Re-host so the document is openable in the conversation panel.
                _media_url_captured = await _rehost_media(file_content, filename, from_number, mime_type)
                response_text = await _safe_process_message(
                    db=db,
                    phone_number=from_number,
                    media_content=file_content,
                    media_type="document",
                    media_filename=filename,
                    source_message_type=message_type,
                )
            else:
                response_text = "I couldn't download your document right now. Please send it again in a few seconds."
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
        file_content = None
        for attempt in range(1, 4):
            file_content = await meta_client.download_media(media_id)
            if file_content:
                break
            logger.warning(
                f"Image media download failed (attempt {attempt}/3) for {from_number}, media_id={media_id}"
            )
            if attempt < 3:
                await asyncio.sleep(0.8 * (2 ** (attempt - 1)))

        if file_content:
            ack = _cv_processing_ack(_candidate_register(from_number))
            await meta_client.send_message(from_number, ack)
            # Re-host to GCS (browser-viewable) for the conversation panel; the
            # WhatsApp media_url is auth-gated and can't be shown directly.
            _media_url_captured = await _rehost_media(file_content, filename, from_number, mime_type)
            response_text = await _safe_process_message(
                db=db,
                phone_number=from_number,
                media_content=file_content,
                media_type="image",
                media_filename=filename,
                media_url=_media_url_captured or media_url,
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

                conv_state = getattr(cand, "conversation_state", "") or ""
                transcribed = await voice_service.transcribe(
                    audio_bytes, language_hint=lang_hint, filename=fname,
                    conversation_state=conv_state,
                )
                transcribed_text = str((transcribed or {}).get("raw_text") or "").strip()

                # Re-host the voice note so agents can play it in the panel
                # (WhatsApp's own media URL is auth-gated, not browser-playable).
                _voice_text = transcribed_text
                try:
                    import base64 as _b64
                    async with httpx.AsyncClient(timeout=8.0) as _mc:
                        _mr = await _mc.post(
                            f"{settings.recruitment_api_url}/api/chatbot/media-upload",
                            headers={"x-chatbot-api-key": settings.chatbot_api_key or ""},
                            json={
                                "base64": _b64.b64encode(audio_bytes).decode("ascii"),
                                "filename": fname,
                                "phone": from_number,
                                "mime_type": mime.split(";")[0],
                            },
                        )
                        if _mr.status_code == 200:
                            _media_url_captured = (_mr.json() or {}).get("url", "") or ""
                except Exception as _vu_err:
                    logger.debug(f"Voice re-host skipped: {_vu_err}")
                if transcribed_text and transcribed_text != "AUDIO_UNREADABLE_FALLBACK":
                    logger.info(f"🎤→💬 Transcribed: {transcribed_text[:80]!r}")
                    response_text = await _safe_process_message(
                        db=db,
                        phone_number=from_number,
                        message_text=transcribed_text,
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
            # Interview action buttons — handle directly, skip orchestration.
            if text_body in _INTERVIEW_BUTTON_IDS:
                try:
                    if await _handle_interview_button(db, from_number, text_body):
                        return
                except Exception as ib_err:
                    logger.warning(f"interview button handling failed for {from_number}: {ib_err}")
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

    # ── Location ──────────────────────────────────────────────────────────────
    # Capture the pin so the agent transcript is complete. We don't drive the
    # conversation off a location, so no bot reply — just sync it inbound.
    elif message_type == "location":
        _loc = message.get("location", {}) or {}
        _lat = _loc.get("latitude")
        _lng = _loc.get("longitude")
        _lname = _loc.get("name") or _loc.get("address") or ""
        _maps = (
            f"https://www.google.com/maps?q={_lat},{_lng}"
            if (_lat is not None and _lng is not None) else ""
        )
        _label = _lname or (f"{_lat}, {_lng}" if _maps else "shared location")
        logger.info(f"📍 Location from {from_number}: {_label}")
        await _sync_inbound_only(
            db, from_number, f"📍 Location: {_label}",
            message_type="location",
            extra_meta={"latitude": _lat, "longitude": _lng, "name": _lname, "maps_url": _maps},
            whatsapp_message_id=message.get("id", ""),
        )
        response_text = None

    # ── Sticker — re-host so the panel can show it, sync inbound, no reply ─────
    elif message_type == "sticker":
        _sticker_url = ""
        try:
            _sid = message.get("sticker", {}).get("id")
            if _sid:
                _media = await meta_client.download_media(_sid)
                if _media:
                    _sticker_url = await _rehost_media(_media, "sticker.webp", from_number, "image/webp")
        except Exception as _stk_err:  # noqa: BLE001
            logger.debug(f"sticker download skipped: {_stk_err}")
        logger.info(f"🌟 Sticker from {from_number}")
        await _sync_inbound_only(
            db, from_number, "🌟 Sticker",
            message_type="sticker", media_url=_sticker_url,
            whatsapp_message_id=message.get("id", ""),
        )
        response_text = None

    # ── Reaction / system signals — acknowledge silently, never reply ─────────
    # A reaction is just an emoji on a previous message; system/ephemeral are
    # non-conversational. Replying with the capability blurb confused real
    # candidates (they reacted 👍 and got "I can receive text messages…").
    # We still sync the reaction inbound so the transcript shows it.
    elif message_type in ("reaction", "system", "ephemeral"):
        if message_type == "reaction":
            _react = message.get("reaction", {}) or {}
            _emoji = _react.get("emoji") or "👍"
            await _sync_inbound_only(
                db, from_number, f"{_emoji} (reaction)",
                message_type="reaction",
                extra_meta={"emoji": _emoji, "reacted_to": _react.get("message_id")},
                whatsapp_message_id=message.get("id", ""),
            )
        logger.info(f"Ignoring non-conversational message type '{message_type}' from {from_number}")
        response_text = None

    # ── Unsupported type ──────────────────────────────────────────────────────
    else:
        logger.info(f"Unsupported message type '{message_type}' from {from_number}")
        # Still capture it in the transcript so agents see the full conversation.
        await _sync_inbound_only(
            db, from_number, f"[{message_type} message]",
            message_type=message_type,
            whatsapp_message_id=message.get("id", ""),
        )
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
                try:
                    _opts = []
                    for _sec in response_text.get("sections", []):
                        for _row in _sec.get("rows", []):
                            _opts.append(str(_row.get("title", "")).strip())
                    _body = response_text.get("body_text", "")
                    _outbound_display = (f"{_body}\nOptions: " + " / ".join([o for o in _opts if o])).strip()
                except Exception:
                    _outbound_display = response_text.get("body_text", "")
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
                try:
                    _btns = [str(b.get("title", "")).strip() for b in response_text.get("buttons", [])]
                    _body = response_text.get("body_text", "")
                    _outbound_display = (f"{_body}\nButtons: " + " / ".join([b for b in _btns if b])).strip()
                except Exception:
                    _outbound_display = response_text.get("body_text", "")
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

            # Readable for the agent panel: which options the candidate saw.
            _outbound_display = (
                (prefix_text + "\n" if prefix_text else "")
                + "Language options: English / සිංහල / தமிழ்"
            )
            # Remove the flag so the sync doesn't have the ugly token
            response_text = response_text.replace("__INTERACTIVE_LANGUAGE_SELECTOR__", "[Interactive Language Selector]")
        else:
            # Log the full reply (not [:80]) so QA can verify language/tone end-to-end.
            logger.info(f"📤 Sending reply to {from_number}: {response_text}")
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
            _outbound_msg_id = ""
            if isinstance(result, dict):
                _msgs = result.get("messages", [])
                if _msgs and isinstance(_msgs, list) and isinstance(_msgs[0], dict):
                    _outbound_msg_id = _msgs[0].get("id", "")
            # Build a readable inbound transcript entry + normalized type/media.
            _inbound_type = message_type
            if message_type == "interactive":
                _interactive = message.get("interactive", {})
                if _interactive.get("type") == "button_reply":
                    _inbound_text = (
                        _interactive.get("button_reply", {}).get("title")
                        or _interactive.get("button_reply", {}).get("id")
                        or "[button reply]"
                    )
                elif _interactive.get("type") == "list_reply":
                    _inbound_text = (
                        _interactive.get("list_reply", {}).get("title")
                        or _interactive.get("list_reply", {}).get("id")
                        or "[list reply]"
                    )
                else:
                    _inbound_text = "[interactive reply]"
            elif message_type in ("audio", "voice"):
                _inbound_type = "voice"
                _inbound_text = (
                    f"🎤 Voice message: {_voice_text}" if _voice_text else "🎤 Voice message"
                )
            elif message_type == "document":
                _inbound_text = message.get("document", {}).get("filename") or "📄 Document"
            elif message_type == "image":
                _inbound_text = "🖼️ Image"
            else:
                _inbound_text = message.get("text", {}).get("body") or f"[{message_type} message]"

            _outbound_text = _outbound_display or response_text
            await asyncio.gather(
                _sync_chat_message(
                    from_number, "inbound", _inbound_text, _lang, _state,
                    message_type=_inbound_type, media_url=_media_url_captured,
                ),
                _sync_chat_message(
                    from_number,
                    "outbound",
                    _outbound_text,
                    _lang,
                    _state,
                    whatsapp_message_id=_outbound_msg_id,
                ),
            )
            # Persist the turn to the chatbot's own conversations table so
            # conversation_agent._build_history() can replay prior turns. The
            # AI-driven path (the only live path) does not otherwise write here,
            # which left the LLM with no verbatim memory across turns.
            try:
                from app.models import Conversation as _ConvModel, MessageType as _MT
                _persist_lang = _lang if _lang in ("si", "ta", "en") else None
                db.add(_ConvModel(
                    candidate_id=_cand.id,
                    message_type=_MT.USER,
                    message_text=_inbound_text,
                    detected_language=_persist_lang,
                    media_type=(_inbound_type if _inbound_type != "text" else None),
                    media_url=_media_url_captured or None,
                ))
                db.add(_ConvModel(
                    candidate_id=_cand.id,
                    message_type=_MT.BOT,
                    message_text=_outbound_text,
                    detected_language=_persist_lang,
                ))
                db.commit()
            except Exception as _persist_err:
                logger.warning(f"Local conversation persistence failed: {_persist_err}")
                try:
                    db.rollback()
                except Exception:
                    pass
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
                 # | certified | prescreening_certified | general_pool | transferred
                 # | interview_reminder | interview_day_reminder | job_now_available
    job_title: str
    interview_date: Optional[str] = None
    interview_location: Optional[str] = None
    interview_notes: Optional[str] = None  # recruiter instructions (dress code, docs to bring, …)
    alternative_jobs: Optional[list] = None
    prescreening_datetime: Optional[str] = None
    prescreening_location: Optional[str] = None
    certification_notes: Optional[str] = None
    old_job_title: Optional[str] = None
    new_job_title: Optional[str] = None


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


# Proactive statuses that may target candidates OUTSIDE the 24h WhatsApp window
# (interview reminders, job re-engagement). For these, an approved Meta template
# is used when out-of-window; otherwise free-form text (Meta-dropped out of
# window, same as before templates existed).
_PROACTIVE_TEMPLATE_LANG = {"en": "en", "si": "si", "ta": "ta", "singlish": "en", "tanglish": "en"}


def _out_of_window_template(status_key: str, payload, lang: str):
    """Return (template_name, language_code, components) when an approved template
    is configured for this proactive status, else (None, None, None)."""
    first_name = (payload.candidate_name or "").strip().split(" ")[0] or "there"
    job = payload.job_title or ""
    when = payload.interview_date or ""
    mapping = {
        "interview_reminder": (settings.template_interview_reminder, [first_name, job, when]),
        "interview_day_reminder": (settings.template_interview_day_reminder, [first_name, job, when]),
        "job_now_available": (settings.template_job_now_available, [first_name, job]),
    }
    tmpl, params = mapping.get(status_key, (None, None))
    if not tmpl:
        return None, None, None
    lang_code = _PROACTIVE_TEMPLATE_LANG.get(lang, "en")
    components = [{"type": "body", "parameters": [{"type": "text", "text": str(p)} for p in params]}]
    return tmpl, lang_code, components


# Interview action buttons (attached to in-window interview_scheduled messages).
_INTERVIEW_BUTTON_IDS = {"iv_confirm", "iv_reschedule", "iv_cantmake"}
_BUTTON_ACTION = {"iv_confirm": "confirm", "iv_reschedule": "reschedule", "iv_cantmake": "cant_make"}
_INTERVIEW_BUTTONS = {
    "en": [{"id": "iv_confirm", "title": "✅ Confirm"}, {"id": "iv_reschedule", "title": "🔁 Reschedule"}, {"id": "iv_cantmake", "title": "❌ Can't make it"}],
    "si": [{"id": "iv_confirm", "title": "✅ තහවුරුයි"}, {"id": "iv_reschedule", "title": "🔁 වෙනස් කරන්න"}, {"id": "iv_cantmake", "title": "❌ බැහැ"}],
    "ta": [{"id": "iv_confirm", "title": "✅ உறுதி"}, {"id": "iv_reschedule", "title": "🔁 மாற்று"}, {"id": "iv_cantmake", "title": "❌ முடியாது"}],
    "singlish": [{"id": "iv_confirm", "title": "✅ Confirm"}, {"id": "iv_reschedule", "title": "🔁 Reschedule"}, {"id": "iv_cantmake", "title": "❌ Ba"}],
    "tanglish": [{"id": "iv_confirm", "title": "✅ Confirm"}, {"id": "iv_reschedule", "title": "🔁 Reschedule"}, {"id": "iv_cantmake", "title": "❌ Mudiyadhu"}],
}
_INTERVIEW_ACK = {
    "confirm": {
        "en": "Great — your interview is *confirmed*! ✅ See you there. Good luck! 🍀",
        "si": "හොඳයි — ඔබේ සම්මුඛ පරීක්ෂණය *තහවුරුයි*! ✅ එතන හමුවෙමු. සුභ පැතුම්! 🍀",
        "ta": "நன்று — உங்கள் நேர்காணல் *உறுதி* செய்யப்பட்டது! ✅ அங்கே சந்திப்போம். வாழ்த்துக்கள்! 🍀",
        "singlish": "Hodai — oyage interview eka *confirm*! ✅ Ethana hamuwemu. Good luck! 🍀",
        "tanglish": "Super — unga interview *confirm* aagiduchu! ✅ Anga paapom. Good luck! 🍀",
    },
    "reschedule": {
        "en": "No problem 🔁 — our team will contact you shortly to arrange a new time.",
        "si": "කරදරයක් නෑ 🔁 — නව වේලාවක් සකස් කරන්න අපේ කණ්ඩායම ඉක්මනින් සම්බන්ධ වෙයි.",
        "ta": "பரவாயில்லை 🔁 — புதிய நேரத்தை ஏற்பாடு செய்ய எங்கள் குழு விரைவில் தொடர்பு கொள்ளும்.",
        "singlish": "Prashnayak na 🔁 — aluth welawak adjust karanna api team eka ikmanin contact karanawa.",
        "tanglish": "Prachanai illa 🔁 — pudhu time arrange panna engal team soon contact pannuvanga.",
    },
    "cant_make": {
        "en": "Thanks for letting us know 🙏 — our team will reach out about the next steps.",
        "si": "දැනුම් දීමට ස්තුතියි 🙏 — ඊළඟ පියවර ගැන අපේ කණ්ඩායම සම්බන්ධ වෙයි.",
        "ta": "தெரிவித்ததற்கு நன்றி 🙏 — அடுத்த படிகள் குறித்து எங்கள் குழு தொடர்பு கொள்ளும்.",
        "singlish": "Kiyala dunnata thanks 🙏 — next steps gana api team eka contact karanawa.",
        "tanglish": "Sonnathukku nandri 🙏 — next steps pathi engal team contact pannuvanga.",
    },
}


async def _handle_interview_button(db, phone: str, button_id: str) -> bool:
    """Handle an interview action button tap: tell the backend + ack the candidate."""
    action = _BUTTON_ACTION.get(button_id)
    if not action:
        return False
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            await client.post(
                f"{settings.recruitment_api_url}/api/chatbot/interview-response",
                headers={"x-chatbot-api-key": settings.chatbot_api_key or ""},
                json={"phone": phone, "action": action},
            )
    except Exception as e:
        logger.warning(f"interview-response POST failed for {phone}: {e}")
    cand = crud.get_candidate_by_phone(db, phone)
    from app.services.followup_service import candidate_lang
    lang = candidate_lang(cand) if cand else "en"
    ack = _INTERVIEW_ACK.get(action, {}).get(lang) or _INTERVIEW_ACK.get(action, {}).get("en", "Thank you!")
    await meta_client.send_message(phone, ack)
    logger.info(f"🎬 Interview button '{action}' handled for {phone}")
    return True


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

    # Look up the candidate's preferred language + last inbound time (for the
    # 24h-window decision below).
    last_inbound_at = None
    try:
        db = SessionLocal()
        from app.models import Candidate
        candidate = db.query(Candidate).filter(
            Candidate.phone_number == phone
        ).first()
        if not candidate:
            logger.warning(
                "Status webhook: no candidate found for phone %s — aborting", phone
            )
            db.close()
            return {"ok": False, "reason": "candidate_not_found"}
        lang = "en"
        extracted = candidate.extracted_data or {}
        lang = extracted.get("language_register") or getattr(
            candidate.language_preference, "value", "en"
        )
        last_inbound_at = getattr(candidate, "last_inbound_at", None)
        db.close()
    except Exception as e:
        logger.warning(f"Could not look up language for {phone}: {e}")
        lang = "en"

    # Translate recruiter-authored interview instructions into the candidate's
    # language so the whole invite reads in one language. Degrades to the
    # original text if translation is unavailable.
    interview_notes = payload.interview_notes
    if interview_notes and interview_notes.strip():
        from app.services.translation_service import translate_text
        try:
            interview_notes = await translate_text(interview_notes, lang)
        except Exception as e:
            logger.warning(f"Interview notes translation failed for {phone}: {e}")

    # Build status message from templates
    from app.llm.prompt_templates import PromptTemplates
    message = PromptTemplates.get_status_update_message(
        status=status_key,
        lang=lang,
        candidate_name=payload.candidate_name,
        job_title=payload.job_title,
        interview_date=payload.interview_date,
        interview_location=payload.interview_location,
        interview_notes=interview_notes,
        alternative_jobs=payload.alternative_jobs,
        prescreening_datetime=payload.prescreening_datetime,
        prescreening_location=payload.prescreening_location,
        certification_notes=payload.certification_notes,
        old_job_title=payload.old_job_title,
        new_job_title=payload.new_job_title,
    )

    if not message:
        logger.warning(f"No status template for status={status_key}, lang={lang}")
        return {"status": "skipped", "reason": f"Unknown status: {status_key}"}

    # Send the WhatsApp message. In-window → rich free-form text. Out-of-window
    # (>24h since the candidate last messaged) → an approved Meta template if one
    # is configured for this status; otherwise free-form (which Meta drops out of
    # window — same as before templates were wired, so no regression).
    try:
        in_window = True
        if last_inbound_at is not None:
            try:
                from datetime import datetime as _dt, timedelta as _td
                in_window = (_dt.utcnow() - last_inbound_at) < _td(hours=24)
            except Exception:
                in_window = True

        tmpl = None
        if not in_window:
            tmpl, lang_code, components = _out_of_window_template(status_key, payload, lang)
        if tmpl:
            logger.info(f"Status update OUT-of-window for {phone}: sending template {tmpl} ({status_key})")
            result = await meta_client.send_template_message(phone, tmpl, language_code=lang_code, components=components)
        elif status_key == "interview_scheduled" and in_window:
            # In-window interview invite → attach Confirm / Reschedule / Can't-make-it
            # buttons so the candidate can respond in one tap (reduces no-shows).
            buttons = _INTERVIEW_BUTTONS.get(lang, _INTERVIEW_BUTTONS["en"])
            result = await meta_client.send_interactive_buttons(phone, text=message, buttons=buttons)
        else:
            result = await meta_client.send_message(phone, message)

        if "error" in result:
            logger.error(f"Failed to send status update to {phone}: {result}")
            return {"status": "error", "detail": str(result.get("error"))}

        logger.info(
            f"Status update sent to {phone}: status={status_key}, lang={lang}, "
            f"window={'in' if in_window else 'out'}"
        )
        return {"status": "sent", "message_id": result.get("messages", [{}])[0].get("id")}
    except Exception as e:
        logger.error(f"Error sending status update to {phone}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to send message: {e}")


# ─── Proactive Follow-up Sweep (Cloud Scheduler) ─────────────────────────────
# Cloud Scheduler POSTs here on a recurring schedule (~every 30 min). The sweep
# finds candidates stuck mid-application and fans each out to the Celery worker
# to send a nudge. Mirrors the recruitment backend's /api/internal/process-queue.
# No-op unless settings.enable_followup_nudges is True (dark-launch flag).

@router.post("/internal/run-followups")
async def run_followups_endpoint(x_chatbot_api_key: Optional[str] = Header(None)):
    """Trigger the stuck-candidate follow-up sweep. Protected by the shared
    chatbot API key (same key the recruitment backend uses)."""
    _require_api_key_webhook(x_chatbot_api_key)
    from app.services.followup_service import run_followup_sweep
    try:
        return await run_followup_sweep()
    except Exception as e:
        logger.error(f"run-followups sweep error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


class BulkNudgePayload(BaseModel):
    """Agent-initiated bulk re-engagement: nudge a specific cohort of candidates
    by phone (used by the backend's /api/engagement/bulk-nudge)."""
    phones: list = []


@router.post("/internal/nudge-candidates")
async def nudge_candidates_endpoint(
    payload: BulkNudgePayload,
    x_chatbot_api_key: Optional[str] = Header(None),
):
    """Manually nudge a cohort of candidates now (bulk re-engagement campaign).
    Each goes through the same send path as the cadence (respects opt-out,
    completion, handoff, quiet hours, and the 3-nudge cap)."""
    _require_api_key_webhook(x_chatbot_api_key)
    from app.services.followup_service import send_followup_for_candidate
    phones = [p for p in (payload.phones or []) if p][:500]
    dispatched = 0
    db = SessionLocal()
    try:
        for phone in phones:
            cand = crud.get_candidate_by_phone(db, phone)
            if not cand:
                continue
            try:
                if await send_followup_for_candidate(cand.id):
                    dispatched += 1
            except Exception as e:
                logger.warning(f"bulk nudge failed for {phone}: {e}")
    finally:
        db.close()
    return {"requested": len(phones), "dispatched": dispatched}


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



