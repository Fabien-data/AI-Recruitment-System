"""
Render two markdown fragments from qa_results.json:
  - appendix_a_transcripts.md  — per-scenario inputs + bot replies
  - appendix_b_matrix.md       — pass/fail validation matrix

The fragments are concatenated into CHATBOT_FINAL_QA_REPORT.md (manually or
by the writer that calls this script).
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
RESULTS = Path(__file__).parent / "qa_results.json"
APP_A = Path(__file__).parent / "appendix_a_transcripts.md"
APP_B = Path(__file__).parent / "appendix_b_matrix.md"


def lang_register_ok(scenario: dict) -> str:
    lang = scenario["lang"]
    ag = (scenario["candidate_state"].get("extracted_data") or {}).get("agent_state", {})
    locked = ag.get("locked_language", "?")
    # Code-switching personas legitimately drift — accept the related register
    pairs = {"en": {"en", "singlish", "tanglish"}, "si": {"si", "singlish"}, "ta": {"ta", "tanglish"}}
    allowed = {lang}
    if scenario["persona"] == "codeswitch":
        allowed |= pairs.get(lang, set())
    elif lang in pairs:
        allowed |= {lang}  # exact
    return "✅" if locked in allowed else f"❌ locked={locked}"


def crm_ok(scenario: dict) -> str:
    has_name = bool(scenario["candidate_state"].get("name"))
    ag = (scenario["candidate_state"].get("extracted_data") or {}).get("agent_state", {})
    synced = ag.get("cv_synced", False)
    persona = scenario["persona"]
    if persona in ("skeptical", "offtopic"):
        # Not expected to sync (no name given), unless the user *did* give one
        return "N/A" if not has_name else ("✅" if synced else "❌")
    return "✅" if synced else "❌"


def main():
    data = json.loads(RESULTS.read_text(encoding="utf-8"))

    # ----- Appendix A: transcripts ---------------------------------------
    a_lines = ["## Appendix A — Conversation transcripts (post-fix run, rev 111)", ""]
    a_lines.append("Each scenario was driven by simulated Meta webhook payloads against the live Cloud Run instance. "
                   "Bot replies were pulled from Cloud Run logs (`Sending reply to <phone>:` lines), with the full reply text "
                   "logged after the truncation fix shipped in rev 111. Sinhala/Tamil characters render correctly here "
                   "even though they appear as `?` in older Cloud Run logs — see §4.1 of the report for why.")
    a_lines.append("")
    for s in data:
        a_lines.append(f"### {s['lang']} / {s['persona']} (phone `{s['phone']}`)")
        cs = s.get("candidate_state", {})
        ag = (cs.get("extracted_data") or {}).get("agent_state", {})
        a_lines.append(
            f"**Final state:** name=`{cs.get('name') or '-'}` "
            f"job_role=`{(ag.get('collected_data') or {}).get('job_role') or '-'}` "
            f"country=`{(ag.get('collected_data') or {}).get('country') or '-'}` "
            f"exp=`{cs.get('experience_years')}` "
            f"locked_lang=`{ag.get('locked_language')}` "
            f"cv_synced=`{ag.get('cv_synced')}`"
        )
        a_lines.append("")
        a_lines.append("| # | who | message |")
        a_lines.append("|---|-----|---------|")
        ins = [m for m in s["transcript"] if m["type"] == "incoming"]
        outs = [m for m in s["transcript"] if m["type"] == "outgoing"]
        rows = max(len(ins), len(outs))
        for i in range(rows):
            if i < len(ins):
                u = ins[i].get("text", "").replace("|", "\\|")
                a_lines.append(f"| {i+1} | 👤 user | `{u}` |")
            if i < len(outs):
                b = (outs[i].get("text", "") or "").replace("|", "\\|").replace("\n", " ⏎ ")
                a_lines.append(f"| {i+1} | 🤖 bot | {b} |")
        a_lines.append("")
    APP_A.write_text("\n".join(a_lines), encoding="utf-8")

    # ----- Appendix B: matrix --------------------------------------------
    b_lines = ["## Appendix B — Validation matrix (post-fix run, rev 111)", ""]
    b_lines.append("| Lang | Persona | Responded | Language lock | Name | Job role | Exp | CRM synced | Notes |")
    b_lines.append("|------|---------|-----------|---------------|------|----------|-----|------------|-------|")
    for s in data:
        cs = s.get("candidate_state", {})
        ag = (cs.get("extracted_data") or {}).get("agent_state", {})
        collected = ag.get("collected_data") or {}
        outs = [m for m in s["transcript"] if m["type"] == "outgoing"]
        responded = "✅" if outs else "❌"
        name_ok = "✅" if cs.get("name") else ("—" if s["persona"] in ("skeptical","offtopic") else "❌")
        job_ok = "✅" if collected.get("job_role") else ("—" if s["persona"] in ("skeptical","offtopic") else "❌")
        exp_ok = "✅" if cs.get("experience_years") else ("—" if s["persona"] in ("skeptical","offtopic","novice") else "❌")
        notes = ""
        if s["lang"] in ("singlish", "tanglish") and ag.get("locked_language") == "en":
            notes = "short opener mis-detected as English"
        elif s["persona"] == "offtopic" and cs.get("conversation_state") == "human_handoff":
            notes = "escalated to human handoff (correct)"
        b_lines.append(
            f"| {s['lang']} | {s['persona']} | {responded} | "
            f"{lang_register_ok(s)} | {name_ok} | {job_ok} | {exp_ok} | "
            f"{crm_ok(s)} | {notes} |"
        )
    APP_B.write_text("\n".join(b_lines), encoding="utf-8")

    print(f"wrote {APP_A.name} and {APP_B.name}")


if __name__ == "__main__":
    main()
