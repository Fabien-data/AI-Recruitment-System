"""
Unit Test — generate_agentic_response()
======================================
Validates LLM-powered agentic handoff responses for out-of-bounds onboarding replies.

Usage:
    cd c:\\Users\\Tiran's PC\\Documents\\GitHub\\AI-Recruitment-System\\Chatbot\\whatsapp-recruitment-bot
    python scripts/test_agentic_handoff.py
"""

import asyncio
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.llm.rag_engine import rag_engine
from app.llm.prompt_templates import PromptTemplates


TEST_CASES = [
    # job-role goal
    ("I like to go someplace amazing", "Find out their job role", "en"),
    ("aney mokada karanne mama", "Find out their job role", "singlish"),
    ("enna pandrathu theriyala da", "Find out their job role", "tanglish"),
    ("I need good life", "Find out their job role", "en"),
    ("mama hariyata danne ne", "Find out their job role", "singlish"),

    # country goal
    ("I lost my passport yesterday", "Find out their destination country", "en"),
    ("mage amma ledai", "Find out their destination country", "singlish"),
    ("veetla problem da", "Find out their destination country", "tanglish"),
    ("I am scared to travel", "Find out their destination country", "en"),
    ("nanba confusion ah irukken", "Find out their destination country", "tanglish"),

    # experience goal
    ("My wife is angry at me", "Find out years of experience", "en"),
    ("gedara awul tika thiyenawa", "Find out years of experience", "singlish"),
    ("office la stress adhigam", "Find out years of experience", "tanglish"),
    ("I just need money fast", "Find out years of experience", "en"),
    ("mama game gahanawa", "Find out years of experience", "singlish"),
    ("ennaku bayama irukku", "Find out years of experience", "tanglish"),
]


BAD_OPENERS = (
    "invalid",
    "error",
)


def _normalize(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip().lower())


def _static_templates(language: str):
    templates = set()

    # Gibberish static fallback
    templates.add(_normalize(PromptTemplates.get_gibberish_fallback(language)))

    # Robotic exact intake questions to avoid direct repetition
    for field in ("job_interest", "destination_country", "experience_years"):
        templates.add(_normalize(PromptTemplates.get_intake_question(field, language)))

    return templates


async def run_tests():
    passed = 0
    failed = 0
    errors = 0

    print("\n" + "=" * 74)
    print("  generate_agentic_response() — Agentic Handoff Test Suite")
    print("=" * 74)

    for i, (user_msg, goal, language) in enumerate(TEST_CASES, 1):
        try:
            resp = await rag_engine.generate_agentic_response(
                user_message=user_msg,
                current_goal=goal,
                language=language,
            )

            normalized = _normalize(resp)
            static_set = _static_templates(language)

            checks = {
                "non_empty": bool((resp or "").strip()),
                "short_enough": len(resp or "") <= 200,
                "not_static_template": normalized not in static_set,
                "no_bad_opener": not any(normalized.startswith(x) for x in BAD_OPENERS),
                "not_robotic_repeat": all(
                    _normalize(PromptTemplates.get_intake_question(field, language)) != normalized
                    for field in ("job_interest", "destination_country", "experience_years")
                ),
            }

            ok = all(checks.values())
            status = "✅ PASS" if ok else "❌ FAIL"
            if ok:
                passed += 1
            else:
                failed += 1

            print(f"\n[{i:02d}] {status} | lang={language} | len={len(resp or '')}")
            print(f"     User:  \"{user_msg}\"")
            print(f"     Goal:  {goal}")
            print(f"     Bot:   \"{resp}\"")
            if not ok:
                print(f"     Checks: {checks}")

        except Exception as exc:
            errors += 1
            print(f"\n[{i:02d}] 💥 ERROR | lang={language}")
            print(f"     User:  \"{user_msg}\"")
            print(f"     Error: {exc}")

    total = len(TEST_CASES)
    score_pct = round((passed / total) * 100, 1) if total else 0.0

    print("\n" + "=" * 74)
    print(f"  Results: {passed}/{total} passed, {failed} failed, {errors} errors")
    print(f"  Score:   {score_pct}%")
    print("=" * 74 + "\n")

    return passed, failed, errors


if __name__ == "__main__":
    asyncio.run(run_tests())
