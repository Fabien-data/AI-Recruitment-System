# Plan: Recruitment System — Next-Level Feature Upgrade

**TL;DR:** Transform the recruitment system from a functional CRUD app into a fully automated, notification-driven recruitment pipeline. The plan addresses 7 critical gaps (orphaned notification queue, unused interview management, missing recruiter alerts, English-only templates, no duplicate detection, hardcoded dashboard, unused template messages) and adds 4 major feature upgrades (batch certification, interview management UI, analytics dashboard, real-time recruiter alerts). All work targets Cloud Run deployment with Google Cloud Scheduler for background jobs.

---

## Phase 1: Fix Foundation — Notification Reliability (Critical)

**Problem:** Notifications are fire-and-forget via `setImmediate()`. If they fail, they're queued to `notification_queue` but `processNotificationQueue()` at [notifications.js#L506](recruitment-system/backend/src/services/notifications.js#L506) is **never called**. Also, `sendTemplateMessage()` in [whatsapp.js#L40](recruitment-system/backend/src/services/whatsapp.js#L40) exists but is never used — all outbound WhatsApp messages use freeform text, which Meta blocks outside the 24-hour session window.

**Steps:**

1. **Wire the notification queue processor** — Add a new route `POST /api/internal/process-queue` in [server.js](recruitment-system/backend/src/server.js) protected by an internal API key. This endpoint calls `processNotificationQueue()` from [notifications.js](recruitment-system/backend/src/services/notifications.js). Add a Google Cloud Scheduler job that hits this endpoint every 2 minutes.

2. **Switch to WhatsApp template messages for proactive outbound** — Update `sendNotification()` in [notifications.js#L249-L362](recruitment-system/backend/src/services/notifications.js#L249-L362) to use `sendTemplateMessage()` instead of `sendTextMessage()` for all outbound notifications (certified, prescreening, interview, selected, rejected, general_pool). Map each notification type to a Meta-approved template name. Keep `sendTextMessage()` as fallback for replies within the 24-hour window.

3. **Add missing multilingual templates** — Add Sinhala (`si`) and Tamil (`ta`) translations for `interview_scheduled`, `selected`, and `rejected` templates in [notifications.js#L134-L190](recruitment-system/backend/src/services/notifications.js#L134-L190).

4. **Add transfer notification** — In [applications.js#L215-L260](recruitment-system/backend/src/routes/applications.js#L215-L260), add a `setImmediate()` block after a successful transfer to notify the candidate that their application has been moved to a new job, including the new job title.

---

## Phase 2: Recruiter Alerts — New Candidate Notifications

**Problem:** When the WhatsApp chatbot pushes a completed candidate via `POST /api/chatbot/intake` ([chatbot-intake.js#L171](recruitment-system/backend/src/routes/chatbot-intake.js#L171)), no recruiter is notified. Recruiters must manually check the dashboard. Also, the human handoff TODO at [webhooks.js#L143](recruitment-system/backend/src/routes/webhooks.js#L143) does nothing.

**Steps:**

5. **Create a recruiter notification service** — New file `backend/src/services/recruiter-alerts.js` that sends alerts to recruiters via email (using existing Gmail service) and optionally WhatsApp. Accepts alert types: `new_candidate`, `human_handoff`, `high_match_candidate`, `interview_reminder`, `queue_failure`.

6. **Wire new-candidate alert in chatbot-intake** — After step 7 (logging communication) in [chatbot-intake.js#L484-L500](recruitment-system/backend/src/routes/chatbot-intake.js#L484-L500), trigger `recruiterAlert('new_candidate', { candidate, matchedJob })` to notify relevant recruiter(s). Use `project_assignments` table to find the recruiter assigned to the matched job's project.

7. **Implement human handoff alert** — Replace the TODO at [webhooks.js#L143](recruitment-system/backend/src/routes/webhooks.js#L143) with a call to `recruiterAlert('human_handoff', { candidatePhone, lastMessage })`.

---

## Phase 3: Batch Certification

**Problem:** The [JobCandidates.jsx](recruitment-system/frontend/src/pages/JobCandidates.jsx) page certifies candidates one at a time. For jobs with dozens of candidates, this is tedious.

**Steps:**

8. **Add batch certify API endpoint** — New route `POST /api/applications/batch-certify` in [applications.js](recruitment-system/backend/src/routes/applications.js) accepting `{ application_ids[], prescreening_datetime, prescreening_location, certification_notes, notify_channels }`. Process each application in a transaction, send notifications asynchronously.

9. **Add checkbox selection to JobCandidates UI** — In [JobCandidates.jsx](recruitment-system/frontend/src/pages/JobCandidates.jsx), add a checkbox column to `CandidateRow` ([L313-L425](recruitment-system/frontend/src/pages/JobCandidates.jsx#L313-L425)), a "Select All" header checkbox, and a floating action bar showing count + "Batch Certify" button when ≥1 candidate is selected.

10. **Build BatchCertifyModal** — Similar to the existing `CertifyModal` ([L607-L900](recruitment-system/frontend/src/pages/JobCandidates.jsx#L607-L900)) but shows a list of selected candidates, shared pre-screening date/location, and notification channel selection. Calls the batch endpoint.

---

## Phase 4: Interview Management

**Problem:** The `interview_schedules` table exists in [schema.sql#L208-L227](recruitment-system/database/schema.sql#L208-L227) with rich fields (interviewer, duration, rating, feedback, confirmation/reminder tracking) but is **completely unused**. Interview data is stored loosely on the `applications` table. No UI for managing interviews.

**Steps:**

11. **Create interview API routes** — New file `backend/src/routes/interviews.js` with:
    - `POST /api/interviews` — schedule interview (links to application_id)
    - `GET /api/interviews?job_id=X&date_range=Y` — list with filters
    - `PUT /api/interviews/:id` — update status/feedback/rating
    - `DELETE /api/interviews/:id` — cancel
    - `POST /api/interviews/:id/remind` — manually trigger reminder
    - `GET /api/interviews/upcoming` — next 7 days for dashboard widget

12. **Wire interview notification on schedule** — When an interview is created, send `interview_scheduled` notification to the candidate via WhatsApp/SMS with date, time, location.

13. **Add automated interview reminders** — Extend the queue processor endpoint (from Step 1) to also check `interview_schedules` for entries where `scheduled_datetime` is within 24 hours and `reminder_sent_at IS NULL`. Send reminder notification and set `reminder_sent_at`.

14. **Build Interview Management frontend page** — New page `frontend/src/pages/Interviews.jsx`:
    - Calendar/list view of upcoming interviews
    - Filter by job, date range, status
    - Quick actions: confirm, complete (with rating/feedback form), cancel, no-show
    - Link to candidate profile

15. **Add interview widget to Dashboard** — In [Dashboard.jsx](recruitment-system/frontend/src/pages/Dashboard.jsx), add a "Today's Interviews" section showing scheduled interviews for the current day with candidate name, job, time, and quick-action buttons.

---

## Phase 5: Duplicate Candidate Detection & Merge

**Problem:** Candidates can apply via WhatsApp, email, and manual entry — creating duplicates. No UI or API exists to detect/merge them.

**Steps:**

16. **Create duplicate detection service** — New file `backend/src/services/duplicate-detection.js`. Match candidates by: exact phone match, normalized phone match (strip country code/spaces), fuzzy name match (Levenshtein distance ≤ 2), same email. Return confidence score per pair.

17. **Add duplicate detection API** — New route `GET /api/candidates/duplicates` returns pairs of potential duplicates with confidence scores. `POST /api/candidates/merge` accepts `{ keep_id, merge_id }` — migrates all applications, communications, CV files from `merge_id` to `keep_id`, and soft-deletes the duplicate.

18. **Build Duplicate Detection UI** — New page or section in [Candidates.jsx](recruitment-system/frontend/src/pages/Candidates.jsx) showing a list of potential duplicate pairs with side-by-side comparison and a "Merge" button.

19. **Auto-check on intake** — In [chatbot-intake.js](recruitment-system/backend/src/routes/chatbot-intake.js), after candidate upsert, run duplicate detection. If a high-confidence match is found (different record, same person), flag it for recruiter review via the alert system from Phase 2.

---

## Phase 6: Analytics & Real Dashboard

**Problem:** Dashboard stats at [Dashboard.jsx#L59-L84](recruitment-system/frontend/src/pages/Dashboard.jsx#L59-L84) have hardcoded change percentages and a static "24%" conversion rate. No reporting or export capability exists. Ad tracking data is collected but never displayed.

**Steps:**

20. **Create analytics API** — New file `backend/src/routes/analytics.js` with:
    - `GET /api/analytics/overview` — real conversion rates, period-over-period changes, pipeline funnel stats
    - `GET /api/analytics/jobs/:id/pipeline` — funnel for a specific job (applied → assigned → certified → interviewed → selected → placed)
    - `GET /api/analytics/recruiter-performance` — candidates processed, avg certification time, by user
    - `GET /api/analytics/ad-performance` — clicks, conversions, cost-per-hire from `ad_tracking`
    - `GET /api/analytics/export` — CSV/Excel export of filtered data

21. **Fix Dashboard with real data** — Replace hardcoded values in [Dashboard.jsx](recruitment-system/frontend/src/pages/Dashboard.jsx) with data from `/api/analytics/overview`. Calculate actual conversion rate (certified/total applications), real period-over-period changes.

22. **Build Analytics page** — New page `frontend/src/pages/Analytics.jsx` with:
    - Pipeline funnel visualization (bar/sankey chart)
    - Time-series charts (candidates per week, certifications per week)
    - Ad performance table (if ad tracking is active)
    - Export button

---

## Phase 7: Audit Trail & Polish

**Steps:**

23. **Implement audit logging middleware** — New middleware `backend/src/middleware/audit.js` that intercepts all mutation routes (POST/PUT/DELETE) and writes to the `audit_logs` table with `user_id`, `action`, `entity_type`, `entity_id`, `changes` (JSONB diff), and `ip_address`.

24. **Fix database consistency issues** — Update [communications.js](recruitment-system/backend/src/routes/communications.js) to use the `query()` adapter instead of `pool.query()` directly. Fix the MySQL `JSON_EXTRACT` syntax at [line 52](recruitment-system/backend/src/routes/communications.js#L52) to use PostgreSQL `metadata->>'notification_type'`.

25. **Add missing route registration** — Register interview routes and analytics routes in [server.js](recruitment-system/backend/src/server.js).

---

## Verification

- **Phase 1:** Send a test certification → verify WhatsApp template message arrives. Kill the server mid-notification → restart → verify the queue processor retries and delivers. Check all 3 languages for all 6 template types.
- **Phase 2:** Complete a chatbot intake flow → verify recruiter receives email/WhatsApp alert. Send "talk to human" via WhatsApp → verify recruiter alert fires.
- **Phase 3:** Select 5 candidates on JobCandidates page → batch certify with pre-screening → verify all 5 receive WhatsApp notifications with correct details.
- **Phase 4:** Schedule an interview → verify candidate gets notification. Wait for reminder window → verify reminder fires. Complete interview with rating → verify data persists.
- **Phase 5:** Create two candidates with same phone → verify duplicate detection flags them. Merge → verify applications/CVs/communications consolidate.
- **Phase 6:** Check Dashboard shows real conversion rate. Open Analytics page → verify pipeline funnel matches actual data. Export CSV → verify data integrity.
- **Phase 7:** Certify a candidate → check `audit_logs` table for the change record.

---

## Decisions

- **Cloud Scheduler over in-process cron:** Cloud Run instances can scale to zero; an in-process `setInterval` would be lost. A Cloud Scheduler HTTP trigger to `POST /api/internal/process-queue` every 2 minutes is reliable and serverless-friendly.
- **Template messages over freeform text:** Meta requires pre-approved templates for proactive outbound messages (outside the 24-hour window). Since you confirmed approved templates exist, we'll use them for all notification types.
- **Soft-delete on merge over hard-delete:** Merged candidates are marked as `status='merged'` with a `merged_into_id` reference, preserving history for audit purposes.
- **Phase ordering:** Foundation fixes first (Phases 1-2), then productivity features (Phases 3-4), then intelligence features (Phases 5-6), then compliance (Phase 7). Each phase is independently deployable.

---

This is a 25-step plan across 7 phases. Each phase is independently deployable and builds upon the previous ones to create a comprehensive recruitment automation system.
