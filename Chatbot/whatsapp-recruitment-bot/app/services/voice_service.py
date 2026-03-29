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

    _WHISPER_BASE_PROMPT = (
        "This is a WhatsApp voice note from a Sri Lankan user talking about jobs, CV, passport, "
        "Dubai, Qatar, Kuwait, Saudi Arabia, Oman, Malaysia, driver, mason, cleaning, security guard, "
        "nurse, cook, welder, electrician, plumber. They might speak in Sinhala, Tamil, Singlish, or Tanglish."
    )

    # Extra context per conversation state to improve Whisper accuracy
    _STATE_WHISPER_HINTS: Dict[str, str] = {
        "awaiting_job_interest":      "Job roles: security guard, driver, nurse, cook, welder, factory worker, mason, plumber, electrician, cleaner, waiter.",
        "awaiting_destination_country": "Countries: UAE, Dubai, Qatar, Saudi Arabia, Kuwait, Oman, Malaysia, Maldives, Jordan.",
        "awaiting_experience":        "Experience in years: one year, two years, five years, no experience, fresh, new.",
        "collecting_info":            "Personal info: name, age, address, phone number, Colombo, Kandy, Galle, Jaffna, Batticaloa.",
        "awaiting_cv":                "CV, resume, document, PDF, photo of certificate.",
        "collecting_job_requirements": "Job preferences: salary, shift, accommodation, food, visa, contract period.",
    }

    def __init__(self):
        self._client: Optional[AsyncOpenAI] = None
        if OPENAI_AVAILABLE and settings.openai_api_key:
            self._client = AsyncOpenAI(api_key=settings.openai_api_key)
            logger.info("VoiceService: Whisper client initialized")

    @property
    def available(self) -> bool:
        return self._client is not None

    # "Couldn't hear you" messages in all 5 languages
    AUDIO_FALLBACK_MESSAGES: Dict[str, str] = {
        "en":       "I couldn't hear that clearly 🎤 Could you send the voice note again, or type your reply?",
        "si":       "හරිකට ඇහුණේ නෑ 🎤 නැවත voice note එකක් දෙන්න, නැත්නම් type කරන්න.",
        "ta":       "சரியாக கேட்கவில்லை 🎤 மீண்டும் voice note அனுப்புங்கள், அல்லது type செய்யுங்கள்.",
        "singlish": "Sando kiyala aruna naa 🎤 Awith voice note ekak denna, nethnam type karanna.",
        "tanglish": "Sariyaa ketkaala 🎤 Thirumba voice note anuppu, illa type pannunga.",
    }

    async def transcribe(
        self,
        audio_bytes: bytes,
        language_hint: str = "en",
        filename: str = "voice.ogg",
        conversation_state: str = "",
    ) -> Dict[str, Any]:
        """
        Transcribe audio bytes to text via Whisper API.

        Args:
            audio_bytes: raw audio file content (ogg/opus from WhatsApp)
            language_hint: candidate's current language preference
            filename: original filename (used by Whisper for format detection)
            conversation_state: current chatbot state (for context hints)

        Returns:
            Dict with the shape {"is_voice": True, "raw_text": "<transcribed_text>"}.
        """
        audio_ext = str(filename or "").lower().rsplit(".", 1)[-1]
        is_audio_like = audio_ext in ("ogg", "mp3", "m4a", "aac", "opus", "wav", "flac")
        if not is_audio_like:
            return {"is_voice": True, "raw_text": "AUDIO_UNREADABLE_FALLBACK"}

        if not self._client:
            logger.warning("VoiceService: Whisper not available, cannot transcribe")
            return {"is_voice": True, "raw_text": "AUDIO_UNREADABLE_FALLBACK"}

        whisper_lang = self._WHISPER_LANG_MAP.get(language_hint, "en")

        # Build state-aware prompt for better accuracy
        state_hint = self._STATE_WHISPER_HINTS.get(conversation_state, "")
        whisper_prompt = self._WHISPER_BASE_PROMPT
        if state_hint:
            whisper_prompt = f"{state_hint} {whisper_prompt}"

        try:
            audio_file = io.BytesIO(audio_bytes)
            audio_file.name = filename

            response = await self._client.audio.transcriptions.create(
                model="whisper-1",
                file=audio_file,
                language=whisper_lang,
                prompt=whisper_prompt,
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
        conversation_state: str = "",
    ) -> Dict[str, Any]:
        return await self.transcribe(
            audio_bytes=audio_bytes,
            language_hint=language_hint,
            filename=filename,
            conversation_state=conversation_state,
        )


# Singleton
voice_service = VoiceService()
