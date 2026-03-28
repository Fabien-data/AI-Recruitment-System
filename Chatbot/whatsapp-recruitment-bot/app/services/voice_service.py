"""
Voice Message Service
=====================
Transcribes WhatsApp voice messages using OpenAI Whisper API.
Supports Sinhala (si) and Tamil (ta) — the two native scripts where
phone keyboard input is difficult, making voice a preferred input method.
"""

import io
import logging
from typing import Optional, Dict, Any

from app.config import settings

logger = logging.getLogger(__name__)

try:
    from openai import AsyncOpenAI
    OPENAI_AVAILABLE = True
except ImportError:
    OPENAI_AVAILABLE = False
    logger.warning("OpenAI not available — voice transcription disabled")


class VoiceService:
    """Transcribe audio bytes via OpenAI Whisper API."""

    # Whisper-supported language codes for Sri Lankan languages
    _WHISPER_LANG_MAP = {
        "si": "si",       # Sinhala
        "ta": "ta",       # Tamil
        "en": "en",       # English
        "singlish": "si", # Romanized Sinhala — hint Whisper to Sinhala
        "tanglish": "ta", # Romanized Tamil — hint Whisper to Tamil
    }

    _WHISPER_LOCALIZED_PROMPT = (
        "This is a WhatsApp voice note from a Sri Lankan user talking about jobs, CV, passport, "
        "Dubai, Qatar, driver, mason, cleaning. They might speak in Sinhala, Tamil, Singlish, or Tanglish."
    )

    def __init__(self):
        self._client: Optional[AsyncOpenAI] = None
        if OPENAI_AVAILABLE and settings.openai_api_key:
            self._client = AsyncOpenAI(api_key=settings.openai_api_key)
            logger.info("VoiceService: Whisper client initialized")

    @property
    def available(self) -> bool:
        return self._client is not None

    async def transcribe(
        self,
        audio_bytes: bytes,
        language_hint: str = "en",
        filename: str = "voice.ogg",
    ) -> Dict[str, Any]:
        """
        Transcribe audio bytes to text via Whisper API.

        Args:
            audio_bytes: raw audio file content (ogg/opus from WhatsApp)
            language_hint: candidate's current language preference
            filename: original filename (used by Whisper for format detection)

        Returns:
            Dict with the shape {"is_voice": True, "raw_text": "<transcribed_text>"}.
        """
        is_audio_like = str(filename or "").lower().endswith(".ogg") or str(filename or "").lower().endswith(".mp3") or str(filename or "").lower().endswith(".m4a") or str(filename or "").lower().endswith(".aac")
        if not is_audio_like:
            return {"is_voice": True, "raw_text": "AUDIO_UNREADABLE_FALLBACK"}

        if not self._client:
            logger.warning("VoiceService: Whisper not available, cannot transcribe")
            return {"is_voice": True, "raw_text": "AUDIO_UNREADABLE_FALLBACK"}

        whisper_lang = self._WHISPER_LANG_MAP.get(language_hint, "en")

        try:
            audio_file = io.BytesIO(audio_bytes)
            audio_file.name = filename

            response = await self._client.audio.transcriptions.create(
                model="whisper-1",
                file=audio_file,
                language=whisper_lang,
                prompt=self._WHISPER_LOCALIZED_PROMPT,
            )
            text = response.text.strip()
            logger.info(
                f"VoiceService: Transcribed {len(audio_bytes)} bytes "
                f"(lang_hint={whisper_lang}) → {len(text)} chars"
            )
            if len(text.split()) < 2:
                return {"is_voice": True, "raw_text": "AUDIO_UNREADABLE_FALLBACK"}
            return {"is_voice": True, "raw_text": text}

        except Exception as e:
            logger.error(f"VoiceService: Whisper transcription failed: {e}", exc_info=True)
            return {"is_voice": True, "raw_text": "AUDIO_UNREADABLE_FALLBACK"}

    async def transcribe_audio(
        self,
        audio_bytes: bytes,
        language_hint: str = "en",
        filename: str = "voice.ogg",
    ) -> Dict[str, Any]:
        return await self.transcribe(
            audio_bytes=audio_bytes,
            language_hint=language_hint,
            filename=filename,
        )


# Singleton
voice_service = VoiceService()
