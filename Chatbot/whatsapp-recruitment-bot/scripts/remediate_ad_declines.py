#!/usr/bin/env python3
"""
Remediation: apologise to candidates wrongly told "no Security Officer position"
and restart their onboarding.

Background
----------
The live root cause (fixed separately in conversation_agent._ACTIVE_JOBS_PROMPT_CAP
+ orchestrator never-dead-end routing) was that the ACTIVE_JOBS prompt cap (10,
newest-first) truncated the two *older* "Security Officer - Dubai" roles out of
the brain's view, so the bot truthfully but wrongly told ad clickers we had no
such role while still offering the newer Cook job.

This one-off script re-engages the affected cohort: it resets each candidate's
ad-flow state so the next language tap restarts deterministic onboarding, then
sends an apology + the trilingual language selector.

SAFETY
------
  * --dry-run is the DEFAULT. Nothing is sent or written unless --send is given.
  * Only messages candidates whose last inbound is inside the 24h WhatsApp
    session window (free-form text is allowed by Meta). Out-of-window candidates
    are listed and SKIPPED — they need an approved template
    (settings.apology_restart_template), left for a follow-up pass.
  * Idempotent: skips candidates already carrying agent_state.apology_sent_at.
  * Excludes handoff / general-pool candidates.
  * Atomic per candidate: state is committed only after both sends succeed.
  * Uses RAW SQL for candidate reads/writes (not the ORM model) so it is immune
    to model-vs-prod column drift (prod lacks the follow-up columns).

Run locally against prod (cloud-sql-proxy on 127.0.0.1:5433 for chatbot_db, and
Meta creds from the deployed service). Example:
    python scripts/remediate_ad_declines.py --minutes 60            # dry run
    python scripts/remediate_ad_declines.py --minutes 60 --send     # send for real
    python scripts/remediate_ad_declines.py --minutes 60 --limit 5 --send
"""
import argparse
import asyncio
import json
import os
import sys
from datetime import datetime, timezone, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from sqlalchemy import text  # noqa: E402

from app.database import SessionLocal  # noqa: E402
from app.utils.meta_client import meta_client  # noqa: E402
from app.core.orchestrator import IntakeOrchestrator  # noqa: E402

_orch = IntakeOrchestrator()  # reuse the ad-intent role/country parser
WINDOW_HOURS = 24


# Distinct candidates who received a BOT "no security job" decline in the window,
# excluding handoff / general-pool. message_type enum in prod is USER / BOT.
DECLINE_SQL = text(
    """
    SELECT DISTINCT c.id
    FROM conversations conv
    JOIN candidates c ON c.id = conv.candidate_id
    WHERE conv.message_type = 'BOT'
      AND conv.timestamp >= now() - make_interval(mins => :mins)
      AND conv.message_text ILIKE '%security%'
      AND ( conv.message_text ILIKE '%don''t have%'
         OR conv.message_text ILIKE '%do not have%'
         OR conv.message_text ILIKE '%no Security%'
         OR conv.message_text ILIKE '%unfortunately%'
         OR conv.message_text ILIKE '%don''t currently%'
         OR conv.message_text ILIKE '%not available%'
         OR conv.message_text ILIKE '%don''t see%'
         OR conv.message_text ILIKE '%there are no%' )
      AND COALESCE(c.handoff_flag, false) = false
      AND COALESCE(c.is_general_pool, false) = false
    ORDER BY c.id
    """
)

# Read only the columns that exist on prod (avoid follow-up columns the model
# adds but prod lacks).
CAND_SQL = text(
    "SELECT id, phone_number, name, agent_state, extracted_data, "
    "language_preference FROM candidates WHERE id = :cid"
)

UPDATE_SQL = text(
    "UPDATE candidates SET agent_state = CAST(:state AS jsonb), "
    "extracted_data = CAST(:extracted AS jsonb) WHERE id = :cid"
)

LAST_INBOUND_SQL = text(
    "SELECT max(timestamp) FROM conversations "
    "WHERE candidate_id = :cid AND message_type = 'USER'"
)

LAST_AD_INTENT_SQL = text(
    """
    SELECT message_text FROM conversations
    WHERE candidate_id = :cid AND message_type = 'USER'
      AND ( message_text ILIKE '%apply%' OR message_text ILIKE '%position%'
         OR message_text ILIKE '%security%' OR message_text ILIKE '%interested%' )
    ORDER BY timestamp DESC LIMIT 1
    """
)

APOLOGY = {
    "en": (
        "Sorry about the earlier mix-up 🙏 We'd love to help you apply. "
        "Tap your language below and we'll take your details and CV to match "
        "you to the right role — including the one you asked about."
    ),
    "si": (
        "කලින් වුණු වැරැද්දට සමාවෙන්න 🙏 අපි ඔබට අයදුම් කිරීමට උදව් කරන්න කැමතියි. "
        "පහළින් ඔබේ භාෂාව තෝරන්න — ඔබේ විස්තර සහ CV එක අරගෙන, ඔබ ඇහූ රැකියාව ඇතුළුව "
        "හරියටම ගැලපෙන රැකියාවකට ඔබව සම්බන්ධ කරන්නම්."
    ),
    "ta": (
        "முந்தைய குழப்பத்திற்கு மன்னிக்கவும் 🙏 உங்களுக்கு விண்ணப்பிக்க உதவ விரும்புகிறோம். "
        "கீழே உங்கள் மொழியைத் தேர்ந்தெடுங்கள் — உங்கள் விவரங்களையும் CV-ஐயும் பெற்று, "
        "நீங்கள் கேட்ட வேலை உட்பட சரியான வேலைக்கு உங்களைப் பொருத்துவோம்."
    ),
}


def _resolve_lang(agent_state, language_preference) -> str:
    st = agent_state if isinstance(agent_state, dict) else {}
    cand = (st.get("locked_language") or st.get("reply_register") or "").lower()
    if cand in ("en", "si", "ta", "singlish", "tanglish"):
        return cand
    lp = str(language_preference or "").lower()
    if "sinha" in lp or lp == "si":
        return "si"
    if "tamil" in lp or lp == "ta":
        return "ta"
    return "en"


def _apology_for(lang: str) -> str:
    return APOLOGY.get(lang, APOLOGY["en"])  # singlish/tanglish/unknown → English


def _build_restart_state(agent_state, extracted_data, role, country):
    """Return (new_state, new_extracted) JSON-serialisable dicts that reset the
    candidate into awaiting_language with a synthetic ad context, so the next
    language tap restarts the branded deterministic onboarding + pool capture."""
    state = dict(agent_state) if isinstance(agent_state, dict) else {}
    state["ad_processed"] = False
    state["ad_flow_step"] = "awaiting_language"
    state["step"] = "ad_landed"
    state["pending_job_welcome"] = {"job_title": role or "", "country": country or ""}
    state["ad_context"] = {
        "job_id": None,
        "job_title": role or "",
        "countries": [country] if country else [],
        "synthetic": True,
        "source": "remediation_restart",
    }
    collected = state.get("collected_data") if isinstance(state.get("collected_data"), dict) else {}
    if role and not collected.get("job_role"):
        collected["job_role"] = role
    if country and not collected.get("country"):
        collected["country"] = country
        collected.setdefault("countries", [country])
    state["collected_data"] = collected
    state["apology_sent_at"] = datetime.now(timezone.utc).isoformat()

    extracted = dict(extracted_data) if isinstance(extracted_data, dict) else {}
    extracted["agent_state"] = dict(state)
    return state, extracted


def _aware(dt: datetime) -> datetime:
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


async def main() -> None:
    ap = argparse.ArgumentParser(description="Remediate ad-decline candidates")
    ap.add_argument("--minutes", type=int, default=60,
                    help="look-back window for the decline cohort (default 60)")
    ap.add_argument("--limit", type=int, default=0, help="cap the number processed")
    ap.add_argument("--send", action="store_true",
                    help="actually send (default is a dry run that writes nothing)")
    args = ap.parse_args()
    dry = not args.send

    db = SessionLocal()
    try:
        ids = [r[0] for r in db.execute(DECLINE_SQL, {"mins": args.minutes}).fetchall()]
        mode = "DRY-RUN" if dry else "SEND"
        print(f"cohort (last {args.minutes} min): {len(ids)} candidates  | mode={mode}")
        if args.limit:
            ids = ids[: args.limit]
            print(f"limited to {len(ids)}")

        now = datetime.now(timezone.utc)
        sent = skipped_done = skipped_window = errors = 0

        for cid in ids:
            row = db.execute(CAND_SQL, {"cid": cid}).fetchone()
            if not row:
                continue
            _id, phone, name, agent_state, extracted_data, lang_pref = row
            if isinstance(agent_state, dict) and agent_state.get("apology_sent_at"):
                skipped_done += 1
                continue

            last_in = db.execute(LAST_INBOUND_SQL, {"cid": cid}).scalar()
            in_window = bool(last_in) and (now - _aware(last_in)) < timedelta(hours=WINDOW_HOURS)

            intent_row = db.execute(LAST_AD_INTENT_SQL, {"cid": cid}).fetchone()
            role, country = _orch._extract_ad_prefill_entities(intent_row[0] if intent_row else "")
            lang = _resolve_lang(agent_state, lang_pref)
            tag = (f"id={cid} phone={phone} lang={lang} "
                   f"role={role!r} country={country!r} in_window={in_window}")

            if not in_window:
                print(f"  SKIP(out-of-window, needs template) {tag}")
                skipped_window += 1
                continue

            if dry:
                print(f"  DRY  {tag}")
                continue

            new_state, new_extracted = _build_restart_state(
                agent_state, extracted_data, role, country
            )
            try:
                r1 = await meta_client.send_text(phone, _apology_for(lang))
                r2 = await meta_client.send_language_selector(phone)
                err = (isinstance(r1, dict) and r1.get("error")) or \
                      (isinstance(r2, dict) and r2.get("error"))
                if err:
                    errors += 1
                    print(f"  SEND-FAIL {tag} :: {err}")
                else:
                    db.execute(UPDATE_SQL, {
                        "cid": cid,
                        "state": json.dumps(new_state, ensure_ascii=False),
                        "extracted": json.dumps(new_extracted, ensure_ascii=False),
                    })
                    db.commit()
                    sent += 1
                    print(f"  SENT {tag}")
            except Exception as exc:  # noqa: BLE001
                db.rollback()
                errors += 1
                print(f"  ERROR {tag} :: {exc!r}")

        print(
            f"\nDONE: sent={sent} skipped_already_done={skipped_done} "
            f"skipped_out_of_window={skipped_window} errors={errors}"
        )
        if skipped_window:
            print("NOTE: out-of-window candidates need an approved Meta template "
                  "(settings.apology_restart_template) — run a template pass once approved.")
    finally:
        db.close()


if __name__ == "__main__":
    asyncio.run(main())
