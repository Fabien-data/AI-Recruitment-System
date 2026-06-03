"""
Standalone verification for the proactive follow-up engine (Feature 1).
Runs against a throwaway SQLite DB with meta_client mocked — no network, no prod.

    python scripts/verify_followup_engine.py
"""
import os
import sys
import asyncio
import tempfile
from datetime import datetime, timedelta

# Ensure the project root (parent of scripts/) is importable as `app`.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Point at a throwaway SQLite DB BEFORE importing app modules (env overrides .env).
_DB = os.path.join(tempfile.gettempdir(), "followup_verify.db")
if os.path.exists(_DB):
    os.remove(_DB)
os.environ["DATABASE_URL"] = f"sqlite:///{_DB}"
os.environ["ENABLE_FOLLOWUP_NUDGES"] = "true"
os.environ["FOLLOWUP_SMART_SEND_TIME"] = "false"  # test cadence, not send-time gating
os.environ["DEBUG"] = "false"  # silence SQLAlchemy echo
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from app.database import SessionLocal, init_db  # noqa: E402
from app.models import Candidate  # noqa: E402
import app.services.followup_service as fs  # noqa: E402

init_db()

# ── Mock all outbound WhatsApp sends ──────────────────────────────────────────
SENT = []


async def _fake_text(to, text):
    SENT.append(("text", to, text))
    return {"messages": [{"id": "wamid.test"}]}


async def _fake_template(to, name, language_code="en", components=None):
    SENT.append(("template", to, name, language_code))
    return {"messages": [{"id": "wamid.tmpl"}]}


fs.meta_client.send_text = _fake_text
fs.meta_client.send_template_message = _fake_template

NOW = datetime.utcnow()
PASS, FAIL = 0, 0


def check(label, cond):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  PASS  {label}")
    else:
        FAIL += 1
        print(f"  FAIL  {label}")


def mk(phone, **kw):
    db = SessionLocal()
    c = Candidate(phone_number=phone, **kw)
    db.add(c)
    db.commit()
    cid = c.id
    db.close()
    return cid


STUCK_STATE = {
    "collected_data": {"name": "Ahmed", "job_role": "Security", "country": "UAE", "experience_years": 2},
    "cv_uploaded": False,
}

# ── A. Due detection ──────────────────────────────────────────────────────────
print("A. find_due_candidates")
c_due = mk("94100", name="Ahmed", agent_state=dict(STUCK_STATE), last_inbound_at=NOW - timedelta(hours=25), followup_count=0)
c_fresh = mk("94101", name="Sara", agent_state=dict(STUCK_STATE), last_inbound_at=NOW - timedelta(hours=10), followup_count=0)
c_capped = mk("94102", name="Capped", agent_state=dict(STUCK_STATE), last_inbound_at=NOW - timedelta(hours=200), followup_count=3)
c_handoff = mk("94103", name="Handed", agent_state=dict(STUCK_STATE), last_inbound_at=NOW - timedelta(hours=25), followup_count=0, handoff_flag=True)

db = SessionLocal()
due_ids = {c.id for c in fs.find_due_candidates(db, now=NOW)}
db.close()
check("25h-silent incomplete candidate is due", c_due in due_ids)
check("10h-silent candidate is NOT due (< 24h)", c_fresh not in due_ids)
check("count=3 candidate is NOT due (capped)", c_capped not in due_ids)
check("human-handoff candidate is NOT due", c_handoff not in due_ids)

# ── B. Out-of-window send (25h → template), counts the attempt ────────────────
print("B. send out-of-window → template + count")
SENT.clear()
ok = asyncio.run(fs.send_followup_for_candidate(c_due))
check("send returned True", ok is True)
check("used template (out of 24h window)", len(SENT) == 1 and SENT[0][0] == "template")
db = SessionLocal()
cc = db.query(Candidate).get(c_due)
check("followup_count incremented to 1", cc.followup_count == 1)
db.close()

# ── C. Cool-off: immediate second send is a no-op ─────────────────────────────
print("C. cool-off blocks immediate re-send")
SENT.clear()
ok2 = asyncio.run(fs.send_followup_for_candidate(c_due))
check("second send within cool-off returns False", ok2 is False)
check("no message sent during cool-off", len(SENT) == 0)

# ── D. In-window send (free-form text) ────────────────────────────────────────
print("D. send in-window → free-form text")
SENT.clear()
c_in = mk("94110", name="Nimal", agent_state=dict(STUCK_STATE), last_inbound_at=NOW - timedelta(hours=2), followup_count=0)
ok3 = asyncio.run(fs.send_followup_for_candidate(c_in))
check("send returned True", ok3 is True)
check("used free-form text (within 24h window)", len(SENT) == 1 and SENT[0][0] == "text")
check("nudge text mentions the missing field (age)", "age" in SENT[0][2].lower() or "වයස" in SENT[0][2] or "வயது" in SENT[0][2])

# ── E. Complete candidate → auto-stop, no send ────────────────────────────────
print("E. complete candidate auto-stops")
SENT.clear()
done_state = {"collected_data": {"name": "Done", "job_role": "Cook", "country": "Qatar", "experience_years": 3, "age": 30, "email": "d@x.com"}, "cv_uploaded": True, "cv_synced": True}
c_done = mk("94120", name="Done", agent_state=done_state, last_inbound_at=NOW - timedelta(hours=30), followup_count=0)
ok4 = asyncio.run(fs.send_followup_for_candidate(c_done))
check("complete candidate send returns False", ok4 is False)
check("no message sent to complete candidate", len(SENT) == 0)
db = SessionLocal()
cd = db.query(Candidate).get(c_done)
check("complete candidate marked followup_stopped", cd.followup_stopped is True)
db.close()

# ── F. Cap at 3 attempts ──────────────────────────────────────────────────────
print("F. caps at 3 attempts")
c_cap = mk("94130", name="Persist", agent_state=dict(STUCK_STATE), last_inbound_at=NOW - timedelta(hours=300), followup_count=2)
# force past cool-off by clearing last_followup_at
db = SessionLocal()
cp = db.query(Candidate).get(c_cap)
cp.last_followup_at = None
db.commit()
db.close()
SENT.clear()
ok5 = asyncio.run(fs.send_followup_for_candidate(c_cap))
check("3rd attempt sends", ok5 is True)
db = SessionLocal()
cp = db.query(Candidate).get(c_cap)
db.close()
check("count now 3", cp.followup_count == 3)
db = SessionLocal()
still_due = {c.id for c in fs.find_due_candidates(db, now=NOW)}
db.close()
check("count=3 no longer appears as due", c_cap not in still_due)

print(f"\n=== {PASS} passed, {FAIL} failed ===")
sys.exit(1 if FAIL else 0)
