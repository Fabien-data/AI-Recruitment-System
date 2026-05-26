"""
Drive the full QA matrix against the deployed chatbot and persist results.

Output: scripts/qa_results.json — list of:
    {lang, persona, phone, candidate_state, transcript: [{type, text, language, ts}, ...]}
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import qa_harness as h  # noqa: E402
import qa_scenarios as s  # noqa: E402


OUT = Path(__file__).parent / "qa_results.json"
WAIT = 6.0  # per-message wait so bot can process + reply


def run_scenario(lang: str, persona: str, suffix: str, messages: list[str]) -> dict:
    phone = s.phone_for(suffix)
    label = f"{lang}/{persona}"
    print(f"\n{'#'*70}\n# {label}  phone={phone}\n{'#'*70}")

    print(f"  -> reset")
    try:
        h.reset(phone)
    except Exception as e:
        print(f"  reset error (ok if new number): {e}")
    time.sleep(1.5)

    for i, m in enumerate(messages, 1):
        print(f"  USER[{i:>2}]: {m}")
        try:
            h.send_message(phone, m, wait=WAIT)
        except Exception as e:
            print(f"  !! send error: {e}")
            time.sleep(2)

    info = h.candidate_info(phone)
    conv = h.conversation(phone, limit=80)
    msgs = conv.get("messages", []) if isinstance(conv, dict) else []

    # Real source of truth for replies: Cloud Run logs (intake flow doesn't write to Conversation table)
    print(f"  -> pulling bot replies from logs (Cloud Run)")
    log_replies = h.replies_from_logs(phone, freshness_min=15, limit=120)
    log_syncs = h.sync_calls_from_logs(phone, freshness_min=15)

    # Build a unified transcript: interleave inputs (in send order) with log replies (sorted by time)
    unified = []
    for i, m in enumerate(messages):
        unified.append({"type": "incoming", "text": m, "seq": i})
    for r in log_replies:
        unified.append({"type": "outgoing", "text": r.get("text"), "language": None,
                         "sentiment": None, "timestamp": r.get("timestamp")})

    print(f"  -> candidate state: {info.get('conversation_state')}, "
          f"name={info.get('name')}, lang={info.get('language')}, "
          f"exp={info.get('experience_years')}")
    print(f"  -> {len(log_replies)} bot replies captured from logs, "
          f"{len(log_syncs)} CRM-sync log lines")

    return {
        "lang": lang,
        "persona": persona,
        "phone": phone,
        "input_messages": messages,
        "candidate_state": info,
        "transcript": unified,
        "conversation_table_rows": msgs,
        "log_sync_calls": log_syncs,
    }


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None
    results = []
    if OUT.exists():
        try:
            results = json.loads(OUT.read_text(encoding="utf-8"))
        except Exception:
            results = []

    done_keys = {(x.get("lang"), x.get("persona")) for x in results}
    for lang, persona, suffix, messages in s.SCENARIOS:
        if only and only != f"{lang}/{persona}":
            continue
        if (lang, persona) in done_keys and not only:
            print(f"[skip] {lang}/{persona} already in results.json")
            continue
        r = run_scenario(lang, persona, suffix, messages)
        # replace any existing entry for this lang/persona
        results = [x for x in results if not (x.get("lang") == lang and x.get("persona") == persona)]
        results.append(r)
        OUT.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"  -> saved to {OUT.name} (total {len(results)} scenarios)")

    print(f"\nDONE. All results -> {OUT}")


if __name__ == "__main__":
    main()
