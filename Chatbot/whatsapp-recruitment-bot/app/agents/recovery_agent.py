"""Recovery and escalation response agent."""

from __future__ import annotations


class RecoveryAgent:
    """Produces localized recovery and handoff prompts."""

    def recovery_prompt(self, lang: str) -> str:
        prompts = {
            "en": "I am with you. Do you want to apply for a job, view vacancies, or ask a question?",
            "si": "hari, mama oyata innawa. job ekak apply karannada, vacancies balannada, nathnam prasnayak ahannada?",
            "ta": "naan unga kooda irukken. velai-ku apply panna venduma, vacancies paaka venduma, illa oru kelvi kekka venduma?",
        }
        return prompts.get(lang, prompts["en"])

    def handoff_prompt(self, lang: str) -> str:
        prompts = {
            "en": "I am connecting you to a human recruitment agent now. Please wait a moment.",
            "si": "mama dan oyawa human recruitment agent kenek ekka connect karanawa. tikak inna.",
            "ta": "naan ippo unga human recruitment agent kitta connect pannuren. konjam wait pannunga.",
        }
        return prompts.get(lang, prompts["en"])


recovery_agent = RecoveryAgent()
