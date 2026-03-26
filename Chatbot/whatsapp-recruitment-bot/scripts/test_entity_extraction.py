"""
Unit Test — extract_entities_multilingual()
==========================================
Verifies the new CRM-aware multilingual entity extractor correctly maps
Singlish, Tanglish, abbreviations, and colloquial country spellings.

Usage:
    cd c:\\Users\\Tiran's PC\\Documents\\GitHub\\AI-Recruitment-System\\Chatbot\\whatsapp-recruitment-bot
    python scripts/test_entity_extraction.py
"""

import asyncio
import sys
import os

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

MOCK_ACTIVE_COUNTRIES = [
    "United Arab Emirates", "Saudi Arabia", "Kuwait", "Qatar",
    "Oman", "Malaysia", "Bahrain", "Singapore", "Jordan",
]
MOCK_ACTIVE_JOBS = [
    "Driver", "Security Guard", "Factory Worker", "Cook", "Cleaner",
    "Nurse", "Welder", "Electrician", "Mason", "Plumber", "Housemaid",
]

# (input_text, language, expected_country, expected_job_role)
TEST_CASES = [
    ("mata kuwait yanna one",               "singlish", "Kuwait",              None),
    ("ennaku oman ra job irukuza",           "tanglish", "Oman",                None),
    ("sowdi driver job",                    "singlish", "Saudi Arabia",        "driver"),
    ("dubei wala security kenek wenna",     "singlish", "United Arab Emirates","security guard"),
    ("maleshiya factory",                   "singlish", "Malaysia",            "factory worker"),
    ("kuwet la wadeema karanna",            "singlish", "Kuwait",              None),
    ("dubai driver",                        "en",       "United Arab Emirates","driver"),
    ("oman nurse job",                      "en",       "Oman",                "nurse"),
    ("qatar la security job ekak",          "singlish", "Qatar",               "security guard"),
    ("malesia factory worker",              "en",       "Malaysia",            "factory worker"),
    ("dubayi cook job wanna",               "singlish", "United Arab Emirates","cook"),
    ("saudi la welder job ona",             "singlish", "Saudi Arabia",        "welder"),
    ("bahrain la electrician",              "singlish", "Bahrain",             "electrician"),
    ("singapore mason",                     "en",       "Singapore",           "mason"),
    ("owdi wela job karanna",               "singlish", "Saudi Arabia",        None),  # "owdi" variant
    ("oman poganum cook",                   "tanglish", "Oman",                "cook"),
    ("qatar driver job pannalaam",          "tanglish", "Qatar",               "driver"),
    ("aniq malaysia factory vela",          "tanglish", "Malaysia",            "factory worker"),
    ("uae security guard",                  "en",       "United Arab Emirates","security guard"),
    ("ennaku sowdiyil nurse job venum",     "tanglish", "Saudi Arabia",        "nurse"),
]

PASS_MARK = 0.60   # country confidence threshold for passing


async def run_tests():
    from app.llm.rag_engine import rag_engine

    passed = 0
    failed = 0
    errors = 0

    print("\n" + "=" * 70)
    print("  extract_entities_multilingual() — Unit Test Suite")
    print("=" * 70)

    for i, (text, lang, exp_country, exp_job) in enumerate(TEST_CASES, 1):
        try:
            result = await rag_engine.extract_entities_multilingual(
                text=text,
                language=lang,
                active_countries=MOCK_ACTIVE_COUNTRIES,
                active_jobs=MOCK_ACTIVE_JOBS,
            )

            extracted_country = result.get("matched_crm_country") or result.get("country") or ""
            extracted_job    = result.get("matched_crm_job")     or result.get("job_role")  or ""
            confidence       = result.get("confidence", 0.0)

            # Country check: case-insensitive partial match
            country_ok = (
                exp_country is None
                or exp_country.lower() in (extracted_country or "").lower()
                or (extracted_country or "").lower() in exp_country.lower()
            )
            # Job check: case-insensitive partial match
            job_ok = (
                exp_job is None
                or exp_job.lower() in (extracted_job or "").lower()
                or (extracted_job or "").lower() in (exp_job or "").lower()
            )

            status = "✅ PASS" if (country_ok and job_ok) else "❌ FAIL"
            if country_ok and job_ok:
                passed += 1
            else:
                failed += 1

            print(
                f"\n[{i:02d}] {status} (conf={confidence:.2f})\n"
                f"     Input:    \"{text}\"\n"
                f"     Expected: country={exp_country!r}  job={exp_job!r}\n"
                f"     Got:      country={extracted_country!r}  job={extracted_job!r}"
            )

        except Exception as e:
            errors += 1
            print(f"\n[{i:02d}] 💥 ERROR\n     Input: \"{text}\"\n     Error: {e}")

    total = len(TEST_CASES)
    print("\n" + "=" * 70)
    print(f"  Results: {passed}/{total} passed, {failed} failed, {errors} errors")
    score_pct = round(passed / total * 100, 1)
    print(f"  Score:   {score_pct}%")
    if score_pct >= 70:
        print("  🎉 Overall: ACCEPTABLE (≥70%)")
    else:
        print("  ⚠️  Overall: NEEDS IMPROVEMENT (<70%)")
    print("=" * 70 + "\n")

    return passed, failed, errors


if __name__ == "__main__":
    asyncio.run(run_tests())
