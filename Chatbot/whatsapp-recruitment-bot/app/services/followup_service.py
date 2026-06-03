"""
Proactive Follow-up Service — stuck-candidate re-engagement
===========================================================
Finds candidates who started but never finished their application (a required
field or CV still missing) and sends up to 3 contextual nudges, then stops.

Cadence is measured from the candidate's last inbound message (their silence):
    nudge 1 after 24h, nudge 2 after 3 days, nudge 3 after 7 days → then stop.
A reply re-arms the cadence (webhooks resets followup_count to 0 on inbound).

WhatsApp 24-hour window: inside 24h we send a rich free-form nudge; outside it
Meta only allows an approved template message (send_template_message). The whole
feature is dark-launched behind settings.enable_followup_nudges until the
templates are approved in WhatsApp Business Manager.

Scheduling: a Cloud Scheduler job POSTs /webhook/internal/run-followups every
~30 min; that endpoint calls run_followup_sweep(), which fans each due candidate
out to the existing Celery worker via send_stuck_followup_task.delay(id) (the
same pattern webhooks.py uses for process_webhook_task). We deliberately do NOT
use Celery Beat — the prod worker scales to 3 instances and Beat would triple-
fire; a single Cloud Scheduler trigger keeps it exactly-once.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from typing import List, Optional

from sqlalchemy import or_

from app.config import settings
from app.database import SessionLocal
from app.models import Candidate
from app.utils.meta_client import meta_client
from app.agents.intake_agent import intake_agent

logger = logging.getLogger(__name__)

# Cadence thresholds (hours of silence) for nudge 1, 2, 3.
THRESHOLD_HOURS = [24, 72, 168]
MAX_NUDGES = 3
# Per-candidate cool-off so two overlapping sweeps can't double-send.
CLAIM_COOLOFF_HOURS = 6
# WhatsApp customer-service window.
WINDOW_HOURS = 24

# Asia/Colombo is a fixed UTC+5:30 (no DST) — use an offset to avoid a tzdata
# dependency on Windows/minimal images.
_COLOMBO_OFFSET = timedelta(hours=5, minutes=30)

# Default mandatory-field order — mirrors orchestrator._mandatory_order default.
DEFAULT_MANDATORY_ORDER = ["name", "job_role", "country", "experience_years", "age", "email"]

# Internal language registers → Meta template language codes. singlish/tanglish
# have no Meta locale, so they fall back to the English-approved template.
LANG_TO_META_CODE = {"en": "en", "si": "si", "ta": "ta", "singlish": "en", "tanglish": "en"}

# Localized labels for the out-of-window template's {{2}} parameter and the
# free-form intro. Falls back to a humanized field name for anything unlisted.
FIELD_LABELS = {
    "name": {"en": "name", "si": "නම", "ta": "பெயர்", "singlish": "name", "tanglish": "peyar"},
    "job_role": {"en": "preferred job role", "si": "කැමති රැකියාව", "ta": "விரும்பும் வேலை", "singlish": "job role", "tanglish": "job role"},
    "country": {"en": "preferred country", "si": "කැමති රට", "ta": "விரும்பும் நாடு", "singlish": "country", "tanglish": "country"},
    "age": {"en": "age", "si": "වයස", "ta": "வயது", "singlish": "wayasa", "tanglish": "vayasu"},
    "email": {"en": "email address", "si": "email ලිපිනය", "ta": "email முகவரி", "singlish": "email", "tanglish": "email"},
    "experience_years": {"en": "years of experience", "si": "අත්දැකීම් වසර", "ta": "அனுபவ வருடங்கள்", "singlish": "experience", "tanglish": "experience"},
    "cv": {"en": "CV/resume", "si": "CV එක", "ta": "CV", "singlish": "CV eka", "tanglish": "CV"},
    "height": {"en": "height", "si": "උස", "ta": "உயரம்", "singlish": "usa", "tanglish": "uyaram"},
}


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _colombo_hour(now_utc: Optional[datetime] = None) -> int:
    return ((now_utc or datetime.utcnow()) + _COLOMBO_OFFSET).hour


def is_quiet_hours(now_utc: Optional[datetime] = None) -> bool:
    """True during the Asia/Colombo quiet window (default 21:00–08:00)."""
    h = _colombo_hour(now_utc)
    start = settings.followup_quiet_start_hour
    end = settings.followup_quiet_end_hour
    if start <= end:
        return start <= h < end
    return h >= start or h < end  # wraps past midnight (e.g. 21 → 8)


def _near_preferred_hour(c: Candidate, now_utc: datetime, window: int = 3) -> bool:
    """Smart send-time: candidates are most reachable around the hour they last
    messaged. Returns True if the current Colombo hour is within `window` hours
    of the candidate's last-inbound hour. Falls back to True when we have no
    signal, or when their preferred hour falls in quiet hours (so they aren't
    starved of nudges)."""
    if not c.last_inbound_at:
        return True
    pref = ((c.last_inbound_at + _COLOMBO_OFFSET).hour)
    # If their usual hour is inside quiet hours we can never honor it — don't gate.
    qs, qe = settings.followup_quiet_start_hour, settings.followup_quiet_end_hour
    in_quiet = (qs <= pref < qe) if qs <= qe else (pref >= qs or pref < qe)
    if in_quiet:
        return True
    cur = _colombo_hour(now_utc)
    diff = min((cur - pref) % 24, (pref - cur) % 24)
    return diff <= window


def _field_label(field: str, lang: str) -> str:
    labels = FIELD_LABELS.get(field)
    if labels:
        return labels.get(lang) or labels.get("en") or field
    return field.replace("_", " ")


def candidate_lang(c: Candidate) -> str:
    """Resolve the candidate's locked language register (en/si/ta/singlish/tanglish)."""
    extracted = c.extracted_data if isinstance(c.extracted_data, dict) else {}
    state = c.agent_state if isinstance(c.agent_state, dict) else {}
    lp = getattr(c, "language_preference", None)
    lp_val = getattr(lp, "value", lp)
    return (
        extracted.get("language_register")
        or state.get("locked_language")
        or state.get("reply_register")
        or lp_val
        or "en"
    )


def next_missing_field(c: Candidate) -> Optional[str]:
    """The next mandatory field (per-job order if set, else default) the
    candidate hasn't provided — or 'cv' if all fields are in but no CV — or None."""
    state = c.agent_state if isinstance(c.agent_state, dict) else {}
    collected = state.get("collected_data") if isinstance(state.get("collected_data"), dict) else {}
    order = state.get("mandatory_fields")
    if not (isinstance(order, list) and order):
        order = DEFAULT_MANDATORY_ORDER
    for f in order:
        if f in ("country", "countries"):
            if not (collected.get("country") or collected.get("countries")):
                return "country"
        elif not collected.get(f):
            return f
    cv_uploaded = bool(state.get("cv_uploaded")) or bool(c.resume_file_path)
    if not cv_uploaded:
        return "cv"
    return None


def checklist(c: Candidate):
    """Return the candidate's required-items checklist as [(field, present)].
    Mandatory fields (per-job order if set, else default) + CV."""
    state = c.agent_state if isinstance(c.agent_state, dict) else {}
    collected = state.get("collected_data") if isinstance(state.get("collected_data"), dict) else {}
    order = state.get("mandatory_fields")
    if not (isinstance(order, list) and order):
        order = DEFAULT_MANDATORY_ORDER
    items = []
    for f in order:
        if f in ("country", "countries"):
            items.append(("country", bool(collected.get("country") or collected.get("countries"))))
        else:
            items.append((f, bool(collected.get(f))))
    items.append(("cv", bool(state.get("cv_uploaded")) or bool(c.resume_file_path)))
    return items


def field_label(field: str, lang: str) -> str:
    """Public wrapper for the localized field label."""
    return _field_label(field, lang)


def is_complete(c: Candidate) -> bool:
    """A candidate is 'done' (no nudges) once their profile has synced to the CRM
    or every mandatory field + CV is present."""
    state = c.agent_state if isinstance(c.agent_state, dict) else {}
    if state.get("cv_synced") is True:
        return True
    if (c.cv_sync_status or "") == "synced":
        return True
    return next_missing_field(c) is None


# Two intro variants for lightweight A/B testing of nudge phrasing. Assignment
# is deterministic per candidate (id parity) so a candidate always gets the same
# variant; the chosen variant is tagged on the candidate for later analysis.
_INTRO_VARIANTS = {
    "A": {
        "en": "Hi {nm}! 👋 You're almost done with your Dewan application — just one more thing and we're finished 🙌",
        "si": "ආයුබෝවන් {nm}! 👋 ඔබේ Dewan අයදුම්පත අවසන් වෙන්න ආසන්නයි — තව එක දෙයක් විතරයි 🙌",
        "ta": "வணக்கம் {nm}! 👋 உங்கள் Dewan விண்ணப்பம் கிட்டத்தட்ட முடிந்துவிட்டது — இன்னும் ஒரே ஒரு விஷயம் தான் 🙌",
        "singlish": "Hi {nm}! 👋 Oyage Dewan application eka ivara wenna langai — thawa eka deyak vitharai 🙌",
        "tanglish": "Hi {nm}! 👋 Unga Dewan application almost ready — innum oru vishayam thaan 🙌",
    },
    "B": {
        "en": "Hi {nm}! 🌟 We'd hate for you to miss out on these Gulf jobs — let's finish your application! Just one quick thing:",
        "si": "ආයුබෝවන් {nm}! 🌟 මේ Gulf රැකියා ඔබට මඟ හැරෙන්න දෙන්න බෑ — අයදුම්පත සම්පූර්ණ කරමු! එක ඉක්මන් දෙයක්:",
        "ta": "வணக்கம் {nm}! 🌟 இந்த Gulf வேலைகளை நீங்கள் தவறவிடக்கூடாது — விண்ணப்பத்தை முடிப்போம்! ஒரே ஒரு விரைவான விஷயம்:",
        "singlish": "Hi {nm}! 🌟 Me Gulf jobs oyata miss wenna denna ba — application eka ivara karamu! Eka ikman deyak:",
        "tanglish": "Hi {nm}! 🌟 Indha Gulf jobs-a neenga miss panna koodathu — application-a finish pannuvom! Oru quick vishayam:",
    },
}


def variant_for_candidate(c: Candidate) -> str:
    """Stable A/B assignment by candidate id parity."""
    try:
        return "A" if (int(c.id) % 2 == 0) else "B"
    except Exception:
        return "A"


def _followup_intro(lang: str, name: str, variant: str = "A") -> str:
    nm = (name or "").strip().split(" ")[0] if (name or "").strip() else "there"
    table = _INTRO_VARIANTS.get(variant, _INTRO_VARIANTS["A"])
    return table.get(lang, table["en"]).format(nm=nm)


def build_nudge_text(c: Candidate, field: str, lang: str, variant: str = "A") -> str:
    """Compose the in-window free-form nudge: a warm follow-up intro (A/B variant)
    + the existing per-field intake question (reused from intake_agent)."""
    intro = _followup_intro(lang, c.name or "", variant)
    ask = intake_agent.get_prompt_for_field(field, lang)
    return f"{intro}\n\n{ask}"


# ─── Due detection ────────────────────────────────────────────────────────────

def find_due_candidates(db, now: Optional[datetime] = None) -> List[Candidate]:
    """Return candidates currently due for a nudge. Coarse SQL prefilter +
    per-row threshold/cool-off check (kept in Python so it's dialect-agnostic)."""
    now = now or datetime.utcnow()
    rows = (
        db.query(Candidate)
        .filter(
            Candidate.last_inbound_at.isnot(None),
            or_(Candidate.followup_stopped.is_(False), Candidate.followup_stopped.is_(None)),
            or_(Candidate.followup_count < MAX_NUDGES, Candidate.followup_count.is_(None)),
            or_(Candidate.handoff_flag.is_(False), Candidate.handoff_flag.is_(None)),
            or_(Candidate.is_general_pool.is_(False), Candidate.is_general_pool.is_(None)),
        )
        .limit(500)
        .all()
    )
    due: List[Candidate] = []
    for c in rows:
        count = c.followup_count or 0
        if count >= MAX_NUDGES or not c.last_inbound_at:
            continue
        if (now - c.last_inbound_at) < timedelta(hours=THRESHOLD_HOURS[count]):
            continue
        if c.last_followup_at and (now - c.last_followup_at) < timedelta(hours=CLAIM_COOLOFF_HOURS):
            continue
        due.append(c)
    return due


# ─── Sending ──────────────────────────────────────────────────────────────────

async def _send_template_nudge(c: Candidate, field: str, lang: str) -> dict:
    """Out-of-window send via an approved Meta template (params: name, field)."""
    name = ((c.name or "").strip().split(" ")[0]) or "there"
    components = [{
        "type": "body",
        "parameters": [
            {"type": "text", "text": name},
            {"type": "text", "text": _field_label(field, lang)},
        ],
    }]
    return await meta_client.send_template_message(
        c.phone_number,
        settings.followup_template_missing_info,
        language_code=LANG_TO_META_CODE.get(lang, "en"),
        components=components,
    )


async def send_followup_for_candidate(candidate_id: int) -> bool:
    """Send one nudge to a candidate if still due. Re-validates state, claims the
    attempt atomically (row lock + counts it, capped at 3), then sends in/out of
    the 24h window. Returns True if a nudge was sent."""
    db = SessionLocal()
    try:
        # Row-lock the candidate so two overlapping sweeps serialize on the claim.
        c = db.query(Candidate).filter(Candidate.id == candidate_id).with_for_update().first()
        if not c:
            return False
        if c.followup_stopped or (c.followup_count or 0) >= MAX_NUDGES:
            return False
        if getattr(c, "handoff_flag", False) or getattr(c, "is_general_pool", False):
            return False
        extracted = c.extracted_data if isinstance(c.extracted_data, dict) else {}
        if extracted.get("is_human_handoff"):
            return False

        if is_complete(c):
            c.followup_stopped = True       # nothing to chase — stop re-scanning
            db.commit()
            return False

        field = next_missing_field(c)
        if not field:
            c.followup_stopped = True
            db.commit()
            return False

        now = datetime.utcnow()
        if is_quiet_hours(now):
            return False  # try again on the next (post-quiet) sweep
        # Smart send-time: prefer the candidate's typical active hour (derived
        # from when they last messaged). Defer to a later sweep if we're far off.
        if settings.followup_smart_send_time and not _near_preferred_hour(c, now):
            return False

        if c.last_followup_at and (now - c.last_followup_at) < timedelta(hours=CLAIM_COOLOFF_HOURS):
            return False  # already attempted within the cool-off

        # Claim + count the attempt under the row lock (bounded to 3 attempts,
        # success or not, so an unreachable number can't be retried forever).
        attempt_no = (c.followup_count or 0) + 1
        lang = candidate_lang(c)
        phone = c.phone_number
        variant = variant_for_candidate(c)
        in_window = bool(c.last_inbound_at) and (now - c.last_inbound_at) < timedelta(hours=WINDOW_HOURS)
        nudge_text = build_nudge_text(c, field, lang, variant)
        c.last_followup_at = now
        c.followup_count = attempt_no
        # Tag the A/B variant on the candidate for later effectiveness analysis.
        try:
            state = dict(c.agent_state) if isinstance(c.agent_state, dict) else {}
            state["last_followup_variant"] = variant
            c.agent_state = state
        except Exception:
            pass
        db.commit()  # releases the row lock + records the claim

        if in_window:
            result = await meta_client.send_text(phone, nudge_text)
        else:
            result = await _send_template_nudge(c, field, lang)

        if isinstance(result, dict) and result.get("error"):
            logger.warning(
                f"followup: send failed for {phone} (field={field}, "
                f"window={'in' if in_window else 'out'}, attempt={attempt_no}): {result.get('error')}"
            )
            return False

        logger.info(
            f"followup: nudge #{attempt_no} sent to {phone} "
            f"(field={field}, window={'in' if in_window else 'out'}, lang={lang})"
        )
        return True
    except Exception as exc:
        try:
            db.rollback()
        except Exception:
            pass
        logger.exception(f"followup: send_followup_for_candidate({candidate_id}) failed: {exc}")
        return False
    finally:
        db.close()


async def run_followup_sweep() -> dict:
    """Entry point for the Cloud Scheduler endpoint. Finds due candidates and
    dispatches each to the Celery worker (or runs inline if Celery is disabled)."""
    if not settings.enable_followup_nudges:
        return {"enabled": False, "dispatched": 0, "due": 0}
    if is_quiet_hours():
        return {"enabled": True, "quiet_hours": True, "dispatched": 0, "due": 0}

    db = SessionLocal()
    try:
        ids = [c.id for c in find_due_candidates(db)]
    finally:
        db.close()

    dispatched = 0
    for cid in ids:
        if settings.enable_celery_webhook_dispatch:
            try:
                from app.tasks import send_stuck_followup_task
                send_stuck_followup_task.delay(cid)
                dispatched += 1
                continue
            except Exception as exc:
                logger.warning(f"followup: Celery dispatch failed for {cid}, running inline: {exc}")
        try:
            if await send_followup_for_candidate(cid):
                dispatched += 1
        except Exception as exc:
            logger.warning(f"followup: inline send failed for {cid}: {exc}")

    logger.info(f"followup sweep: dispatched={dispatched} due={len(ids)}")
    return {"enabled": True, "dispatched": dispatched, "due": len(ids)}
