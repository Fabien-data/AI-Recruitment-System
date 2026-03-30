"""Language lock and switching logic for controlled multilingual flows."""

from __future__ import annotations

from typing import Optional

from app.nlp.language_detector import detect_language, detect_language_switch_request


class LanguageService:
    """Detects and locks language unless user explicitly asks for a switch."""

    def resolve_language(self, user_text: str, locked_language: Optional[str]) -> str:
        switch = detect_language_switch_request(user_text or "")
        if switch:
            return switch
        detected, confidence = detect_language(user_text or "")
        if not locked_language:
            return detected or "en"

        # Keep register stable unless we have a confident new signal.
        # This avoids hard language-lock loops while still honoring user preference.
        if detected and detected != locked_language and confidence >= 0.35:
            return detected

        return locked_language


language_service = LanguageService()
