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
        # Once a language is locked (by a prior explicit switch request), keep it
        # stable regardless of what detection thinks — single-word English answers
        # like "Dubai" or "28" would otherwise flip the lock back to "en".
        if locked_language:
            return locked_language
        detected, _ = detect_language(user_text or "")
        return detected or "en"


language_service = LanguageService()
