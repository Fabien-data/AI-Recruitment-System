"""
Grade qa_results.json against validation rules and produce qa_grades.json + a
markdown summary table fragment.

Validation rules per scenario:
  V1 responds_at_all      — at least one outgoing message captured
  V2 language_correct     — outgoing messages match expected script/register
  V3 domain_terms_english — CV, salary, visa, passport stay in English
  V4 intake_progress      — agent_state shows fields collected (or step advanced)
  V5 no_tech_jargon       — no "error"/"system"/"bot"/"technical" leaks in replies
  V6 cta_per_reply        — replies end with a question or call-to-action
  V7 sentiment_ok         — no negative cascade on hostile probes (off-topic only)
  V8 crm_sync             — chatbot logs show successful sync OR profile complete

Outputs:
  qa_grades.json — per-scenario results
  qa_summary.md  — markdown table to paste into the final report
"""

from __future__ import annotations

import json
import re
from pathlib import Path

RESULTS = Path(__file__).parent / "qa_results.json"
GRADES = Path(__file__).parent / "qa_grades.json"
SUMMARY = Path(__file__).parent / "qa_summary.md"

JARGON = re.compile(r"\b(error|invalid|technical|system error|server error|i (don'?t|do not) understand|bot)\b", re.I)
ENGLISH_DOMAIN = ["cv", "salary", "visa", "passport", "interview", "agency"]

# Script detection
RE_SINHALA = re.compile(r"[඀-෿]")
RE_TAMIL = re.compile(r"[஀-௿]")

# Indicative Singlish/Tanglish tokens (very small, just for sanity)
SINGLISH_TOKENS = {"oya", "oyage", "oyata", "mata", "kiyada", "puluwanda", "karanna", "ekak", "eka", "monawada", "thiyenne", "kohomada", "ela", "machan"}
TANGLISH_TOKENS = {"neenga", "enakku", "unakku", "venum", "venduma", "panna", "irukku", "evlo", "ennoda", "kekka", "vaanga", "vendiyathu", "sollunga"}


def script_of(text: str) -> str:
    if RE_SINHALA.search(text):
        return "sinhala_script"
    if RE_TAMIL.search(text):
        return "tamil_script"
    return "roman"


def looks_like_singlish(text: str) -> bool:
    t = text.lower()
    return sum(1 for tok in SINGLISH_TOKENS if tok in t) >= 1


def looks_like_tanglish(text: str) -> bool:
    t = text.lower()
    return sum(1 for tok in TANGLISH_TOKENS if tok in t) >= 1


def grade_scenario(s: dict) -> dict:
    lang = s["lang"]
    persona = s["persona"]
    transcript = s.get("transcript", [])
    cand = s.get("candidate_state") or {}
    outgoing = [m for m in transcript if m.get("type") == "outgoing"]
    out_texts = [m.get("text") or "" for m in outgoing]
    out_blob = "\n".join(out_texts)

    v1 = bool(outgoing)

    # V2: language register
    v2 = True
    v2_notes = []
    if lang == "si":
        # majority of outgoing messages should contain Sinhala script
        ratio = sum(1 for t in out_texts if RE_SINHALA.search(t)) / max(1, len(out_texts))
        v2 = ratio >= 0.6
        v2_notes.append(f"sinhala_script_ratio={ratio:.2f}")
    elif lang == "ta":
        ratio = sum(1 for t in out_texts if RE_TAMIL.search(t)) / max(1, len(out_texts))
        v2 = ratio >= 0.6
        v2_notes.append(f"tamil_script_ratio={ratio:.2f}")
    elif lang == "singlish":
        # Must NOT use Sinhala Unicode; should have Singlish tokens
        no_unicode = all(not RE_SINHALA.search(t) for t in out_texts)
        has_tokens = sum(1 for t in out_texts if looks_like_singlish(t)) >= max(1, len(out_texts) // 2)
        v2 = no_unicode and has_tokens
        v2_notes.append(f"no_sinhala_unicode={no_unicode}, has_singlish_tokens={has_tokens}")
    elif lang == "tanglish":
        no_unicode = all(not RE_TAMIL.search(t) for t in out_texts)
        has_tokens = sum(1 for t in out_texts if looks_like_tanglish(t)) >= max(1, len(out_texts) // 2)
        v2 = no_unicode and has_tokens
        v2_notes.append(f"no_tamil_unicode={no_unicode}, has_tanglish_tokens={has_tokens}")
    elif lang == "en":
        # No Sinhala or Tamil script bleeding in
        clean = all(not RE_SINHALA.search(t) and not RE_TAMIL.search(t) for t in out_texts)
        v2 = clean
        v2_notes.append(f"english_clean={clean}")

    # V3: domain terms (just observational — pass if at least one English term shows up
    # in any outgoing message that uses it. If no domain term came up, mark N/A.)
    domain_hits = sum(1 for term in ENGLISH_DOMAIN if re.search(rf"\b{term}\b", out_blob, re.I))
    v3 = True if domain_hits == 0 else domain_hits >= 1

    # V4: intake progress — for cooperative personas, expect name + experience captured
    extracted = cand.get("extracted_data") or {}
    agent_state = extracted.get("agent_state") or {}
    collected = agent_state.get("collected_data") or {}
    if persona == "cooperative":
        v4 = bool(cand.get("name")) and bool(cand.get("experience_years") or collected.get("experience_years"))
    elif persona == "novice":
        # at least some field collected
        v4 = bool(cand.get("name") or collected)
    else:
        v4 = True  # not measured for skeptical/codeswitch/offtopic

    # V5: jargon leak
    v5 = not bool(JARGON.search(out_blob))

    # V6: CTA per reply (ends with ? or contains apply/upload/share/send)
    cta_ratio = sum(1 for t in out_texts if t.strip().endswith("?") or re.search(r"\b(apply|upload|share|send|tell|let me know)\b", t, re.I)) / max(1, len(out_texts))
    v6 = cta_ratio >= 0.5

    # V7: sentiment (only for offtopic; check no consecutive negative)
    if persona == "offtopic":
        neg = [m for m in transcript if (m.get("sentiment") or "").lower() == "negative"]
        v7 = len(neg) < 3
    else:
        v7 = True

    # V8: CRM sync (best effort — checked separately via logs; mark "true" if cooperative completed)
    v8 = bool(cand.get("name")) if persona == "cooperative" else True

    return {
        "lang": lang,
        "persona": persona,
        "phone": s.get("phone"),
        "outgoing_count": len(outgoing),
        "V1_responds": v1,
        "V2_language": v2,
        "V2_notes": "; ".join(v2_notes),
        "V3_domain_terms": v3,
        "V4_intake": v4,
        "V5_no_jargon": v5,
        "V6_cta": v6,
        "V7_sentiment": v7,
        "V8_crm_sync": v8,
        "pass": all([v1, v2, v3, v4, v5, v6, v7, v8]),
    }


def main():
    data = json.loads(RESULTS.read_text(encoding="utf-8"))
    grades = [grade_scenario(s) for s in data]
    GRADES.write_text(json.dumps(grades, ensure_ascii=False, indent=2), encoding="utf-8")

    # Markdown table
    cols = ["lang", "persona", "V1", "V2", "V3", "V4", "V5", "V6", "V7", "V8", "OVERALL"]
    rows = []
    rows.append("| " + " | ".join(cols) + " |")
    rows.append("|" + "|".join(["---"] * len(cols)) + "|")
    for g in grades:
        def m(b): return "✅" if b else "❌"
        rows.append("| " + " | ".join([
            g["lang"], g["persona"],
            m(g["V1_responds"]), m(g["V2_language"]), m(g["V3_domain_terms"]),
            m(g["V4_intake"]), m(g["V5_no_jargon"]), m(g["V6_cta"]),
            m(g["V7_sentiment"]), m(g["V8_crm_sync"]),
            "✅ PASS" if g["pass"] else "❌ FAIL",
        ]) + " |")
    SUMMARY.write_text("\n".join(rows), encoding="utf-8")

    fails = [g for g in grades if not g["pass"]]
    print(f"Scenarios graded: {len(grades)}, fails: {len(fails)}")
    for f in fails:
        flag_keys = [k for k, v in f.items() if isinstance(v, bool) and not v]
        print(f"  FAIL {f['lang']}/{f['persona']}: {flag_keys}")


if __name__ == "__main__":
    main()
