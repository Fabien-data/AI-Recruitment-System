"""Deterministic intake agent for field progression prompts."""

from __future__ import annotations

from typing import Dict, Optional


class IntakeAgent:
    """Provides deterministic prompts and next-step selection for intake."""

    def next_missing_field(self, state: Dict[str, object]) -> Optional[str]:
        collected = state.get("collected_data") if isinstance(state.get("collected_data"), dict) else {}
        if not collected.get("job_role"):
            return "job_role"
        if not collected.get("country"):
            return "country"
        if not collected.get("experience_years"):
            return "experience_years"
        return None

    def job_role_prompt(self, lang: str) -> str:
        prompts = {
            "en": "Great. What job role are you looking for?",
            "si": "hari. oyata ona job role eka mokakda?",
            "ta": "sari. neenga thedura job role enna?",
            "singlish": "hari. oyata ona job role eka mokakda?",
            "tanglish": "sari. ungalukku venum job role enna?",
        }
        return prompts.get(lang, prompts["en"])

    def country_prompt(self, lang: str) -> str:
        prompts = {
            "en": "Which country do you prefer for work?",
            "si": "oya job ekata kemathi ratak mokakda?",
            "ta": "neenga velai-ku virumbura naadu enna?",
            "singlish": "oya job ekata kemathi rata mokakda?",
            "tanglish": "neenga velai-ku virumbura naadu enna?",
        }
        return prompts.get(lang, prompts["en"])

    def experience_prompt(self, lang: str) -> str:
        prompts = {
            "en": "How many years of experience do you have?",
            "si": "oyata kochchara awurudu experience thiyenawada?",
            "ta": "ungalukku evalo varusham experience irukku?",
            "singlish": "oyata kochchara avurudu experience thiyenawada?",
            "tanglish": "ungalukku evalo varusham experience irukku?",
        }
        return prompts.get(lang, prompts["en"])

    def cv_prompt(self, lang: str) -> str:
        prompts = {
            "en": "Great. Please upload your CV now and I will continue with the missing details.",
            "si": "hari. den oyage CV eka upload karanna, missing details api complete karamu.",
            "ta": "sari. ippove unga CV upload pannunga, meedhiya details naan complete pannuren.",
            "singlish": "hari. dan oyage CV eka upload karanna. ithuru details api complete karamu.",
            "tanglish": "sari. ippove unga CV upload pannunga. meedhiya details naan complete pannuren.",
        }
        return prompts.get(lang, prompts["en"])


intake_agent = IntakeAgent()
