"""
Meta WhatsApp Business API Client
==================================
Handles all communication with Meta's WhatsApp Business API.
Includes webhook verification, message sending, and media download.
Optimized for high-concurrency traffic using httpx.
"""

import httpx
import hashlib
import hmac
import logging
import json
from typing import Optional, Dict, Any
import os

from app.config import settings

logger = logging.getLogger(__name__)


def _meta_reason_from_code(code, subcode=None) -> str:
    """Map a Meta WhatsApp Cloud API error code to a coarse, actionable reason.

    Reasons consumed downstream (recruitment backend → unreachable flag / CSV):
      • no_whatsapp    — number is not a reachable WhatsApp user (flag + manual call)
      • out_of_window  — >24h since the candidate last messaged; only a template can reach them
      • token_expired  — META_ACCESS_TOKEN invalid/expired (rotate + redeploy)
      • rate_limited   — Meta throttling; safe to retry later
      • other          — anything else
    """
    try:
        code = int(code) if code is not None else None
    except (ValueError, TypeError):
        code = None
    if code == 190:
        return "token_expired"
    # 131047 "Re-engagement message", 470 legacy 24h-expiry, 131051 unsupported-after-window
    if code in (131047, 470):
        return "out_of_window"
    # 131026 "Message undeliverable" (recipient not on WhatsApp / can't receive), 131030 not-in-allowed-list
    if code in (131026, 131030):
        return "no_whatsapp"
    # 4 app-rate-limit, 80007 biz-rate-limit, 130429 cloud-api-rate-limit, 131056 pair-rate-limit
    if code in (4, 80007, 130429, 131056):
        return "rate_limited"
    return "other"


def _classify_meta_error(exc) -> Dict[str, Any]:
    """Extract Meta error code/subcode from an httpx error (status error carries the
    JSON body; a bare network error doesn't) and map to a coarse reason. Always
    returns a dict containing an "error" key so existing `"error" in result` checks
    keep working, plus structured code/subcode/reason for the new flagging path."""
    code = subcode = fbtrace = None
    message = str(exc)
    resp = getattr(exc, "response", None)
    if resp is not None:
        try:
            err = (resp.json() or {}).get("error", {}) or {}
            code = err.get("code")
            subcode = err.get("error_subcode")
            message = err.get("message", message) or message
            fbtrace = err.get("fbtrace_id")
        except Exception:
            pass
    return {
        "error": message,
        "code": code,
        "subcode": subcode,
        "fbtrace_id": fbtrace,
        "reason": _meta_reason_from_code(code, subcode),
    }


class MetaWhatsAppClient:
    """
    Client for Meta WhatsApp Business API.
    Handles sending messages, downloading media, and webhook verification asynchronously.
    """
    
    def __init__(self):
        # We will dynamically create the client within async methods using `async with httpx.AsyncClient() as client:`
        # to ensure proper event loop management, but we could also instantiate one globally if managed well.
        pass

    @property
    def access_token(self):
        return settings.meta_access_token

    @property
    def phone_number_id(self):
        return settings.meta_phone_number_id

    @property
    def api_version(self):
        return settings.meta_api_version

    @property
    def whatsapp_business_account_id(self):
        return settings.meta_whatsapp_business_account_id

    @property
    def base_url(self):
        return f"https://graph.facebook.com/{self.api_version}"

    @property
    def app_secret(self):
        return settings.meta_app_secret

    @property
    def verify_token(self):
        return settings.meta_verify_token

    def _whatsapp_headers(self) -> Dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self.access_token}",
            "Content-Type": "application/json; charset=UTF-8",
        }
        assert "charset=UTF-8" in headers.get("Content-Type", "")
        return headers

    @staticmethod
    def _json_bytes(payload: Dict[str, Any]) -> bytes:
        return json.dumps(payload, ensure_ascii=False).encode("utf-8")
    
    def verify_webhook(self, payload: bytes, signature: str) -> bool:
        """
        Verify webhook signature from Meta. This is a CPU-bound sync operation.
        
        Args:
            payload: Raw request body bytes
            signature: X-Hub-Signature-256 header value
            
        Returns:
            True if signature is valid, False otherwise
        """
        # If no app_secret configured, skip verification (development mode)
        if not self.app_secret:
            logger.warning("META_APP_SECRET not set — skipping signature verification (dev mode)")
            return True

        if not signature:
            logger.warning("No signature provided for webhook verification")
            return False
        
        try:
            expected_signature = hmac.new(
                self.app_secret.encode('utf-8'),
                payload,
                hashlib.sha256
            ).hexdigest()
            
            is_valid = hmac.compare_digest(
                f"sha256={expected_signature}",
                signature
            )
            
            if not is_valid:
                logger.warning("Webhook signature verification failed")
            
            return is_valid
        except Exception as e:
            logger.error(f"Error verifying webhook signature: {e}")
            return False
    
    async def send_message(self, to_number: str, message: str) -> Dict[str, Any]:
        return await self.send_text(to_number=to_number, text=message)

    async def send_text(self, to_number: str, text: str) -> Dict[str, Any]:
        """
        Send a text message via WhatsApp API asynchronously with explicit UTF-8 payload encoding.
        
        Args:
            to_number: Recipient's phone number (with country code)
            text: Message text to send
            
        Returns:
            API response as dictionary
        """
        url = f"{self.base_url}/{self.phone_number_id}/messages"
        headers = self._whatsapp_headers()
        
        safe_text = str(text or "")
        payload = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": to_number,
            "type": "text",
            "text": {"body": safe_text}
        }
        binary_data = self._json_bytes(payload)
        
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    url,
                    data=binary_data,
                    headers=headers,
                    timeout=12.0,
                )
                response.raise_for_status()
                
                result = response.json()
                logger.info(f"Message sent to {to_number}: {result.get('messages', [{}])[0].get('id', 'unknown')}")
                return result
            
        except httpx.HTTPError as e:
            err = _classify_meta_error(e)
            logger.error(
                f"Failed to send message to {to_number}: code={err.get('code')} "
                f"reason={err.get('reason')} msg={err.get('error')!r} | text_sample={safe_text[:60]!r}"
            )
            return err
    
    async def send_media_by_link(
        self,
        to_number: str,
        media_type: str,
        link: str,
        caption: Optional[str] = None,
        filename: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Send a media message (image/document/audio/video) by public link.

        Used by the agent-message path so an agent's media reply goes out on the
        chatbot's WhatsApp identity (the working token), not the backend's.
        Returns the Meta API response, or a classified error dict on failure.
        """
        url = f"{self.base_url}/{self.phone_number_id}/messages"
        headers = self._whatsapp_headers()

        mtype = (media_type or "document").lower()
        if mtype not in ("image", "document", "audio", "video"):
            mtype = "document"
        media_obj = {"link": link}
        # Caption is supported on image/video/document; audio takes none.
        if caption and mtype in ("image", "video", "document"):
            media_obj["caption"] = str(caption)
        if mtype == "document" and filename:
            media_obj["filename"] = filename

        payload = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": to_number,
            "type": mtype,
            mtype: media_obj,
        }
        binary_data = self._json_bytes(payload)
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(url, data=binary_data, headers=headers, timeout=20.0)
                response.raise_for_status()
                result = response.json()
                logger.info(f"Media ({mtype}) sent to {to_number}: {result.get('messages', [{}])[0].get('id', 'unknown')}")
                return result
        except httpx.HTTPError as e:
            err = _classify_meta_error(e)
            logger.error(f"Failed to send media to {to_number}: code={err.get('code')} reason={err.get('reason')}")
            return err

    async def send_template_message(
        self,
        to_number: str,
        template_name: str,
        language_code: str = "en",
        components: Optional[list] = None,
        _allow_lang_fallback: bool = True,
    ) -> Dict[str, Any]:
        """
        Send a template message via WhatsApp API asynchronously.
        Useful for initiating conversations or sending notifications.

        Args:
            to_number: Recipient's phone number
            template_name: Approved template name
            language_code: Template language code
            components: Template components (header, body parameters)
            _allow_lang_fallback: on Meta error 132001 (template not approved in
                this language) retry once in English, so an approved en variant
                still reaches Sinhala/Tamil candidates until their localized
                variant is approved. The si/ta variant takes over automatically
                once Meta approves it — no code change needed.

        Returns:
            API response as dictionary
        """
        url = f"{self.base_url}/{self.phone_number_id}/messages"

        headers = self._whatsapp_headers()

        template = {
            "name": template_name,
            "language": {"code": language_code}
        }

        if components:
            template["components"] = components

        payload = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": to_number,
            "type": "template",
            "template": template
        }

        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    url,
                    data=self._json_bytes(payload),
                    headers=headers,
                    timeout=30.0,
                )
                response.raise_for_status()

                result = response.json()
                logger.info(f"Template message sent to {to_number}")
                return result

        except httpx.HTTPError as e:
            err = _classify_meta_error(e)
            # 132001 = template name/language pair doesn't exist or isn't approved.
            # If we asked for a non-English variant, retry in English (which is the
            # one we register/approve first).
            if (
                _allow_lang_fallback
                and language_code != "en"
                and str(err.get("code")) == "132001"
            ):
                logger.warning(
                    f"Template {template_name} not available in '{language_code}' for "
                    f"{to_number} — retrying in English"
                )
                return await self.send_template_message(
                    to_number, template_name, language_code="en",
                    components=components, _allow_lang_fallback=False,
                )
            logger.error(
                f"Failed to send template message to {to_number}: code={err.get('code')} "
                f"reason={err.get('reason')} msg={err.get('error')!r}"
            )
            return err

    async def list_message_templates(self) -> Dict[str, Any]:
        """List this WABA's message templates (for the campaign template picker).
        Returns the raw Graph response {"data": [...]} or a classified error dict.
        Each template carries name/status/category/language/components — the BODY
        component's {{n}} count is the variable count."""
        waba = self.whatsapp_business_account_id
        if not waba:
            return {"error": "META_WHATSAPP_BUSINESS_ACCOUNT_ID not set", "data": []}
        url = f"{self.base_url}/{waba}/message_templates"
        params = {"fields": "name,status,category,language,components", "limit": 200}
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(
                    url, headers=self._whatsapp_headers(), params=params, timeout=30.0
                )
                response.raise_for_status()
                return response.json()
        except httpx.HTTPError as e:
            err = _classify_meta_error(e)
            logger.error(f"Failed to list templates: code={err.get('code')} reason={err.get('reason')}")
            return {**err, "data": []}

    async def download_media(self, media_id: str) -> Optional[bytes]:
        """
        Download media file from Meta asynchronously.
        
        Args:
            media_id: Media ID from the incoming message
            
        Returns:
            Media file content as bytes, or None if failed
        """
        if not media_id:
            logger.error("Cannot download media: missing media_id")
            return None

        url = f"{self.base_url}/{media_id}"
        headers_resolve = {"Authorization": f"Bearer {self.access_token}"}
        headers_download = {"Authorization": f"Bearer {self.access_token}"}

        try:
            async with httpx.AsyncClient() as client:
                # Step 1: Resolve the signed media URL from Meta Graph API.
                url_response = await client.get(url, headers=headers_resolve, timeout=30.0)
                url_response.raise_for_status()

                media_data = url_response.json()
                media_url = media_data.get("url")
                if not media_url:
                    logger.error(f"Meta API did not return a media URL for media_id={media_id}")
                    return None

                # Step 2: Download the binary using the same Bearer token.
                media_response = await client.get(media_url, headers=headers_download, timeout=60.0)
                media_response.raise_for_status()

                content = media_response.content
                if not content:
                    logger.error(f"Meta media download returned empty content for media_id={media_id}")
                    return None

                logger.info(f"Downloaded media {media_id}: {len(content)} bytes")
                return content

        except httpx.HTTPStatusError as e:
            status = e.response.status_code if e.response is not None else "unknown"
            # Surface the Meta error body — an expired/invalid access token returns
            # code 190 ("Cannot parse access token"). Without this the CV silently
            # fails to download and never appears in the dashboard (bugs B001–B003).
            meta_detail = ""
            try:
                err = (e.response.json() or {}).get("error", {})
                if err:
                    meta_detail = (
                        f" code={err.get('code')} message=\"{err.get('message')}\""
                        f" fbtrace_id={err.get('fbtrace_id')}"
                    )
                    if err.get("code") == 190:
                        meta_detail += (
                            " — META_ACCESS_TOKEN is invalid/expired; rotate it and redeploy."
                        )
            except Exception:
                pass
            logger.error(f"Failed to download media {media_id}: HTTP {status}{meta_detail}")
            return None
        except httpx.HTTPError as e:
            logger.error(f"Failed to download media {media_id}: {e}")
            return None
        except Exception as e:
            logger.error(f"Unexpected error downloading media {media_id}: {e}", exc_info=True)
            return None
    
    async def get_media_url(self, media_id: str) -> Optional[str]:
        """
        Get the download URL for a media file asynchronously.
        
        Args:
            media_id: Media ID from the incoming message
            
        Returns:
            Download URL or None if failed
        """
        url = f"{self.base_url}/{media_id}"
        headers = {"Authorization": f"Bearer {self.access_token}"}
        
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(url, headers=headers, timeout=30.0)
                response.raise_for_status()
                
                media_data = response.json()
                return media_data.get('url')
            
        except httpx.HTTPError as e:
            logger.error(f"Failed to get media URL for {media_id}: {e}")
            return None
    
    async def mark_as_read(self, message_id: str) -> bool:
        """
        Mark a message as read asynchronously.
        
        Args:
            message_id: Message ID to mark as read
            
        Returns:
            True if successful, False otherwise
        """
        url = f"{self.base_url}/{self.phone_number_id}/messages"
        
        headers = self._whatsapp_headers()
        
        payload = {
            "messaging_product": "whatsapp",
            "status": "read",
            "message_id": message_id
        }
        
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    url,
                    data=self._json_bytes(payload),
                    headers=headers,
                    timeout=30.0,
                )
                response.raise_for_status()
                return True
            
        except httpx.HTTPError as e:
            logger.error(f"Failed to mark message {message_id} as read: {e}")
            return False
    
    async def send_reaction(self, message_id: str, to_number: str, emoji: str) -> Dict[str, Any]:
        """
        Send a reaction to a message asynchronously.
        
        Args:
            message_id: Message ID to react to
            to_number: Recipient's phone number
            emoji: Emoji to react with
            
        Returns:
            API response as dictionary
        """
        url = f"{self.base_url}/{self.phone_number_id}/messages"
        
        headers = self._whatsapp_headers()
        
        payload = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": to_number,
            "type": "reaction",
            "reaction": {
                "message_id": message_id,
                "emoji": emoji
            }
        }
        
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    url,
                    data=self._json_bytes(payload),
                    headers=headers,
                    timeout=30.0,
                )
                response.raise_for_status()
                return response.json()
            
        except httpx.HTTPError as e:
            logger.error(f"Failed to send reaction: {e}")
            return {"error": str(e)}


    # ─────────────────────────────────────────────────────────────────────
    # Interactive Messages — Buttons & List Picker
    # ─────────────────────────────────────────────────────────────────────

    async def send_interactive_buttons(
        self,
        to_number: str,
        text: str = "",
        buttons: Optional[list] = None,
        header_text: Optional[str] = None,
        footer_text: Optional[str] = None,
        allow_text_fallback: bool = True,
        body_text: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Send a WhatsApp interactive button message (max 3 buttons).

        Args:
            to_number:   Recipient phone number.
            text:        Main message body.
            buttons:     List of dicts: [{'id': 'btn_1', 'title': 'English'}]
                         — max 3 items, title max 20 chars.
            header_text: Optional header string (plain text only).
            footer_text: Optional footer string.
        """
        url = f"{self.base_url}/{self.phone_number_id}/messages"
        headers = self._whatsapp_headers()

        body_text_value = (body_text or text or "").strip()
        if not body_text_value:
            return {"error": "Interactive button text cannot be empty"}

        if not isinstance(buttons, list) or not buttons:
            return {"error": "Interactive buttons payload requires a non-empty list"}

        # Build button reply objects
        action_buttons = []
        for i, b in enumerate(buttons[:3]):
            if isinstance(b, dict):
                button_id = str(b.get("id", i))
                title = str(b.get("title", "")).strip()
            else:
                button_id = f"btn_{i+1}"
                title = str(b).strip()
            if not title:
                continue
            action_buttons.append(
                {
                    "type": "reply",
                    "reply": {
                        "id": button_id,
                        "title": title[:20],
                    },
                }
            )

        if not action_buttons:
            return {"error": "Interactive buttons payload does not contain valid button titles"}

        interactive: Dict[str, Any] = {
            "type": "button",
            "body": {"text": body_text_value},
            "action": {"buttons": action_buttons},
        }
        if header_text:
            interactive["header"] = {"type": "text", "text": header_text[:60]}
        if footer_text:
            interactive["footer"] = {"text": footer_text[:60]}

        payload = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": to_number,
            "type": "interactive",
            "interactive": interactive,
        }

        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    url, data=self._json_bytes(payload), headers=headers, timeout=8.0
                )
                response.raise_for_status()
                result = response.json()
                logger.info(f"Interactive buttons sent to {to_number}")
                return result
        except httpx.HTTPError as e:
            err = _classify_meta_error(e)
            logger.error(
                f"Failed to send interactive buttons to {to_number}: code={err.get('code')} "
                f"reason={err.get('reason')} msg={err.get('error')!r}"
            )
            if not allow_text_fallback:
                return err
            # Fallback: send as plain text (also returns a classified error if it fails)
            def _btn_title(btn: Any) -> str:
                if isinstance(btn, dict):
                    return str(btn.get("title", ""))
                return str(btn)
            fallback = body_text_value + "\n\n" + "\n".join(
                f"{i+1}. {_btn_title(b)}" for i, b in enumerate(buttons)
            )
            return await self.send_message(to_number, fallback)

    async def send_interactive_list(
        self,
        to_number: str,
        text: str,
        button_text: str,
        sections: list,
        header_text: Optional[str] = None,
        footer_text: Optional[str] = None,
        allow_text_fallback: bool = True,
    ) -> Dict[str, Any]:
        """
        Send a WhatsApp interactive list message.

        Args:
            to_number:   Recipient phone number.
            text:        Main body text.
            button_text: Label shown on the list-open button (max 20 chars).
            sections:    List of section dicts with rows.
        """
        url = f"{self.base_url}/{self.phone_number_id}/messages"
        headers = self._whatsapp_headers()

        body_text = (text or "").strip()
        if not body_text:
            return {"error": "Interactive list text cannot be empty"}
        if not isinstance(sections, list) or not sections:
            return {"error": "Interactive list sections must be a non-empty list"}

        capped_sections = []
        for sec in sections[:10]:
            rows = [
                {
                    "id": str(r.get("id", ""))[:200],
                    "title": str(r.get("title", "")).strip()[:24],
                    **({"description": str(r["description"])[:72]} if r.get("description") else {}),
                }
                for r in sec.get("rows", [])[:10]
                if str(r.get("title", "")).strip()
            ]
            if rows:
                capped_sections.append(
                    {"title": str(sec.get("title", "Options"))[:24], "rows": rows}
                )

        if not capped_sections:
            return {"error": "Interactive list has no valid rows"}

        interactive: Dict[str, Any] = {
            "type": "list",
            "body": {"text": body_text},
            "action": {
                "button": (button_text or "Options")[:20],
                "sections": capped_sections,
            },
        }
        if header_text:
            interactive["header"] = {"type": "text", "text": header_text[:60]}
        if footer_text:
            interactive["footer"] = {"text": footer_text[:60]}

        payload = {
            "messaging_product": "whatsapp",
            "recipient_type": "individual",
            "to": to_number,
            "type": "interactive",
            "interactive": interactive,
        }

        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    url, data=self._json_bytes(payload), headers=headers, timeout=30.0
                )
                response.raise_for_status()
                result = response.json()
                logger.info(f"Interactive list sent to {to_number}")
                return result
        except httpx.HTTPError as e:
            logger.error(f"Failed to send interactive list to {to_number}: {e}")
            if not allow_text_fallback:
                return {"error": str(e)}
            lines = [body_text]
            for sec in sections:
                for r in sec.get("rows", []):
                    lines.append(f"• {r.get('title', '')}")
            return await self.send_message(to_number, "\n".join(lines))

    async def send_list_message(
        self,
        to_number: str,
        body_text: str,
        button_label: str,
        sections: list,
        header_text: Optional[str] = None,
        footer_text: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Send a WhatsApp interactive list message.

        Args:
            to_number:    Recipient phone number.
            body_text:    Main message body.
            button_label: Label shown on the list-open button (max 20 chars).
            sections:     List of section dicts:
                          [{'title': 'Section', 'rows': [{'id': 'r1', 'title': 'Row title', 'description': 'optional'}]}]
            header_text:  Optional header string.
            footer_text:  Optional footer string.
        """
        return await self.send_interactive_list(
            to_number=to_number,
            text=body_text,
            button_text=button_label,
            sections=sections,
            header_text=header_text,
            footer_text=footer_text,
        )

    async def send_language_selector(
        self, to_number: str
    ) -> Dict[str, Any]:
        """
        Send the standard trilingual language selection interactive button message.
        Falls back gracefully to plain text if interactive fails.
        """
        body = (
            "Welcome! Please choose your preferred language.\n"
            "ඔබට කැමති භාෂාව තෝරන්න.\n"
            "உங்கள் மொழியை தேர்ந்தெடுக்கவும்."
        )
        # Button IDs match the ad-flow's `lang_ad_*` handler in orchestrator
        # so language taps from the greeting fast-path route through the same
        # code path as the ad-flow's own selector. The handler falls back to
        # the generic intake flow when there's no ad context in state.
        buttons = [
            {"id": "lang_ad_en", "title": "🇬🇧 English"},
            {"id": "lang_ad_si", "title": "🇱🇰 සිංහල"},
            {"id": "lang_ad_ta", "title": "🇱🇰 தமிழ்"},
        ]
        return await self.send_interactive_buttons(
            to_number=to_number,
            text=body,
            buttons=buttons,
            header_text="Dewan Consultants",
            allow_text_fallback=False,
        )

    async def send_next_step_buttons(
        self,
        to_number: str,
        body_text: str,
        language: str = "en",
    ) -> Dict[str, Any]:
        """
        Send 'Apply for a job / View vacancies / Ask a question' quick-reply buttons
        in the specified language.
        """
        buttons_by_lang = {
            'en': [
                {"id": "action_apply", "title": "Apply for a Job"},
                {"id": "action_vacancies", "title": "View Vacancies"},
                {"id": "action_question", "title": "Ask a Question"},
            ],
            'si': [
                {"id": "action_apply", "title": "රැකියාවකට ඉල්ලා"},
                {"id": "action_vacancies", "title": "රැකියා බලන්න"},
                {"id": "action_question", "title": "ප්‍රශ්නයක් අසන්න"},
            ],
            'ta': [
                {"id": "action_apply", "title": "விண்ணப்பிக்க"},
                {"id": "action_vacancies", "title": "வாய்ப்புகள் பார்க்க"},
                {"id": "action_question", "title": "கேள்வி கேட்க"},
            ],
        }
        buttons = buttons_by_lang.get(language, buttons_by_lang['en'])
        return await self.send_interactive_buttons(
            to_number=to_number,
            body_text=body_text,
            buttons=buttons,
        )


# Singleton instance
meta_client = MetaWhatsAppClient()

