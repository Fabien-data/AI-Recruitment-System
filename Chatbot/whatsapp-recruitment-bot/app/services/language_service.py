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
        if locked_language:
            return locked_language
        detected = detect_language(user_text or "")
        return detected or "en"


language_service = LanguageService()
