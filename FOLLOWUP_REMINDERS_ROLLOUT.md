# Proactive Follow-up & Reminder Engine — Rollout Guide

Three features were implemented. The **code ships dark/safe**; the proactive
sends to *inactive* candidates light up only after you complete the external
steps below (Meta template approval + two Cloud Scheduler jobs + flags).

| Feature | Where | Activation |
|---|---|---|
| **F1 — Stuck-candidate nudges** (24h/3d/7d, auto-stop) | Chatbot | Cloud Scheduler → `/webhook/internal/run-followups` + `ENABLE_FOLLOWUP_NUDGES=true` |
| **F2 — Interview reminders** (daily last-3-days + morning-of) | Backend | Cloud Scheduler → `/api/internal/process-queue` (already wired) |
| **F3 — "We now have a {role} job"** re-engagement | Backend | Automatic on job activation (no scheduler) |

---

## 1. Register WhatsApp message templates (Meta Business Manager)

Proactive messages to candidates **silent > 24h** must be **approved templates**
(free-form is dropped by Meta out of window). Submit these for approval, then set
the matching env vars. Until then, in-window sends work; out-of-window sends are
skipped (no errors, no spam).

Create **Utility** templates (5 language variants where you can — `en`, `si`,
`ta`; Singlish/Tanglish fall back to the `en` template):

| Template name | Body (params in order) | Used by |
|---|---|---|
| `dewan_followup_missing_info` | `Hi {{1}}! You're almost done with your Dewan application — we just need your {{2}} to finish. Reply here to continue. 🙌` (params: name, field) | F1 |
| `dewan_interview_reminder` | `Hi {{1}}! Reminder — your interview for {{2}} is on {{3}}. Please be prepared and on time. 📋` (params: name, job, datetime) | F2 daily |
| `dewan_interview_dayof` | `Hi {{1}}! Today is your interview for {{2}} — {{3}}. Arrive 15 min early with your documents. Good luck! 🍀` (params: name, job, datetime) | F2 day-of |
| `dewan_job_now_available` | `Hi {{1}}! Good news — a {{2}} role just opened and matches what you wanted. Reply YES to apply. 🙌` (params: name, job) | F3 |

> The exact wordings mirror the in-window free-form messages already in
> `prompt_templates.py` (`STATUS_UPDATE_TEMPLATES`) and
> `notifications.js` (`NOTIFICATION_TEMPLATES`).

Then set on the **chatbot** service (env / `env.yaml`):

```
ENABLE_FOLLOWUP_NUDGES=true                      # turn on F1 sweep (after approval)
FOLLOWUP_TEMPLATE_MISSING_INFO=dewan_followup_missing_info
TEMPLATE_INTERVIEW_REMINDER=dewan_interview_reminder
TEMPLATE_INTERVIEW_DAY_REMINDER=dewan_interview_dayof
TEMPLATE_JOB_NOW_AVAILABLE=dewan_job_now_available
# Optional quiet hours (Asia/Colombo, defaults shown):
FOLLOWUP_QUIET_START_HOUR=21
FOLLOWUP_QUIET_END_HOUR=8
```

Leaving the `TEMPLATE_*` vars empty keeps today's behavior (free-form only).

---

## 2. Create the two Cloud Scheduler jobs

Both call existing endpoints; neither is version-controlled yet.

**A. Backend interview reminders + notification queue** (run at least hourly so
the morning-of reminder fires; mornings are enough for the day-of pass):

```
gcloud scheduler jobs create http reminders-process-queue \
  --schedule="0 * * * *" --time-zone="Asia/Colombo" \
  --uri="https://<BACKEND_URL>/api/internal/process-queue" --http-method=POST \
  --headers="x-internal-key=<INTERNAL_API_KEY>"
```

**B. Chatbot stuck-candidate follow-up sweep** (every 30 min; quiet hours are
enforced in-code):

```
gcloud scheduler jobs create http chatbot-run-followups \
  --schedule="*/30 * * * *" --time-zone="Asia/Colombo" \
  --uri="https://<CHATBOT_URL>/webhook/internal/run-followups" --http-method=POST \
  --headers="x-chatbot-api-key=<CHATBOT_API_KEY>"
```

(No Celery Beat — the worker scales to 3 instances and would triple-fire. The
web service claims due rows and fans sends to the worker via `.delay()`.)

---

## 3. Migrations (run automatically on deploy)

- **Backend** (`migrations.js`, on startup): M025 adds `interview_schedules`
  `last_reminder_date`, `reminder_count`, `dayof_reminder_sent_at`; M026 adds
  `general_pool.interest_notified_at`.
  ⚠️ On prod `interview_schedules` may be **postgres-owned** → the M025 ALTERs
  can be rejected. The reminder sweep **degrades to the legacy single 24h
  reminder** automatically; run `scripts/fix-interview-ownership.js` to enable
  the full daily + day-of cadence.
- **Chatbot** (`database.py` self-heal, on startup): adds `candidates`
  `last_inbound_at`, `followup_count`, `last_followup_at`, `followup_stopped`,
  and back-fills `last_inbound_at` from the latest conversation per candidate.

Deploy **backend first** (runs its migrations), verify, then the chatbot
(web + worker), then `gcloud run services update-traffic … --to-latest`.

---

## 4. Bug fixed along the way

`sendInterviewReminderNotification` referenced a `NOTIFICATION_TEMPLATES`
`interview_reminder` key that **did not exist** — every interview reminder threw
"Unknown notification type" before reaching WhatsApp. The template is now added,
so the existing reminder path works again (in addition to the new cadence).

---

## 5. How to verify

- **F1 (no prod needed):** `python scripts/verify_followup_engine.py` (chatbot) —
  18 checks: due detection, out/in-window send, cool-off, complete→stop, 3-cap.
- **F2:** create an interview 2 days out, `POST /api/internal/process-queue` with
  `x-internal-key` on consecutive days → one reminder/day, none on a re-run same
  day; set the interview date = today → distinct day-of message fires once; PUT a
  new `scheduled_datetime` → markers reset and reminders resume.
- **F3:** with a `general_pool` candidate whose `metadata.job_interest_stated`
  is "security", activate a Security job → they receive the
  `job_now_available` message once (`interest_notified_at` set).

---

## 6. Enhancement roadmap — now BUILT (Phases B/C/D)

All 15 enhancements are implemented. Most need no extra setup; the items below do:

**Third Cloud Scheduler job — daily digest (#15)** (run once each morning):
```
gcloud scheduler jobs create http recruitment-daily-digest \
  --schedule="0 8 * * *" --time-zone="Asia/Colombo" \
  --uri="https://<BACKEND_URL>/api/internal/daily-digest" --http-method=POST \
  --headers="x-internal-key=<INTERNAL_API_KEY>"
```
(Emails admins via the Gmail integration; if Gmail isn't connected it just logs.)

**New agent-facing UI** — a new **Engagement** page (frontend nav) shows the daily
digest, re-engagement funnel/analytics (#11), stuck candidates with AI next-best-
action (#6/#12), due callback tasks (#9), and a **"Nudge all shown"** bulk
re-engagement action (#8 → `POST /api/engagement/bulk-nudge` → chatbot
`/webhook/internal/nudge-candidates`; each send respects opt-out / completion /
quiet hours / the 3-nudge cap). No setup; visible to admin / sourcing roles
(grant the `engagement` section to others).

**New candidate self-service keywords** (chatbot, exact-match): `STOP` /
`unsubscribe` (#5, opt-out → sets followup_stopped), `STATUS` (#3, current stage +
next step), `DOCUMENTS` / `CHECKLIST` (#4, required-items checklist). No setup.

**Interactive interview buttons (#1)** — in-window `interview_scheduled` invites now
carry Confirm ✅ / Reschedule 🔁 / Can't-make-it ❌ buttons. Confirm marks the
interview confirmed; Reschedule / Can't-make-it create an agent callback task
(#9, the pragmatic form of #2) and alert the team. Backend endpoint:
`POST /api/chatbot/interview-response` (x-chatbot-api-key). Buttons only deliver
in-window (Meta rule); out-of-window invites fall back to text/template.

**Reschedule / cancel auto-notify (#10)** — editing an interview's datetime or
cancelling it now messages the candidate (reuses the chatbot status path).

**A/B nudge phrasing (#14) + smart send-time (#13)** — follow-up nudges pick one of
two intro variants (stable per candidate, tagged on `agent_state.last_followup_variant`)
and prefer the candidate's typical active hour. Toggle with
`FOLLOWUP_SMART_SEND_TIME` (default true).

**New migrations (auto-applied):** M026 `general_pool.interest_notified_at`,
M027 `candidate_tasks` table.

### Still a future enhancement
- **Full self-service reschedule (#2):** the Reschedule button currently routes to
  an agent task. End-to-end self-booking (bot offers open slots via
  `allocateInterviewSlots`, candidate picks from an interactive list, auto-books)
  needs a backend slot-availability API + a chatbot slot-selection state machine —
  scoped as the next iteration.
