/**
 * Interview Management Routes
 *
 * POST   /api/interviews                — Schedule a new interview
 * GET    /api/interviews                — List interviews with filters
 * GET    /api/interviews/upcoming       — Next 7 days (dashboard widget)
 * GET    /api/interviews/:id            — Single interview details
 * PUT    /api/interviews/:id            — Update status / feedback / rating
 * DELETE /api/interviews/:id            — Cancel interview
 * POST   /api/interviews/:id/remind     — Manually send reminder to candidate
 */

const express = require('express');
const router = express.Router();
const { query, generateUUID } = require('../config/database');
const { adaptQuery } = require('../utils/query-adapter');
const { authenticate, authorize, ROLES } = require('../middleware/auth');
const { requireSection } = require('../middleware/sections');
const notifications = require('../services/notifications');
const { syncCandidateStage } = require('../services/candidate-stage');
const {
    allocateInterviewSlots,
    DEFAULT_PER_DAY_LIMIT,
    DEFAULT_SLOT_MINUTES,
} = require('../services/interview-scheduler');
const logger = require('../utils/logger');

// Upper bound for a single bulk request. The per-item loops below are sequential
// and fault-isolated (one failure never aborts the batch), so the real constraint
// is request wall-clock vs. the platform timeout — the frontend sends very large
// selections in sequential chunks. This ceiling is a safety backstop, not the old
// hard "100 per time" limit the user hit.
const BULK_MAX = 1000;

// Update a candidate's WhatsApp reachability flag from a send result. A confirmed
// WhatsApp delivery clears the flag; a genuine "not a WhatsApp user" sets it (so the
// candidate sinks to the bottom of lists and lands in the call-list CSV). Transient
// reasons (out_of_window / rate_limited) leave the flag untouched. Defensive: the
// columns are added by migration; any error (e.g. missing column) is swallowed so a
// send never fails on bookkeeping.
async function applyWhatsappReachability(candidateId, notification) {
    if (!candidateId || !notification) return;
    try {
        const okWhatsapp = (notification.success || []).some((s) => s.channel === 'whatsapp');
        const noWhatsapp = (notification.failed || []).find((f) => f.channel === 'whatsapp' && f.reason === 'no_whatsapp');
        if (okWhatsapp) {
            await query(
                adaptQuery('UPDATE candidates SET whatsapp_unreachable = FALSE, whatsapp_last_error = NULL, whatsapp_checked_at = NOW() WHERE id = $1'),
                [candidateId]
            );
        } else if (noWhatsapp) {
            await query(
                adaptQuery('UPDATE candidates SET whatsapp_unreachable = TRUE, whatsapp_last_error = $2, whatsapp_checked_at = NOW() WHERE id = $1'),
                [candidateId, String(noWhatsapp.error || 'Not a WhatsApp number').slice(0, 500)]
            );
        }
    } catch (err) {
        logger.debug(`whatsapp reachability update skipped for ${candidateId}: ${err.message}`);
    }
}

// Roles permitted to schedule / run interviews. Marketing agents source leads
// but must NOT schedule or notify interviews (B010); the UI hides the action
// and this re-enforces it server-side so a crafted request can't bypass it.
const SCHEDULER_ROLES = [ROLES.ADMIN, ROLES.PROJECT_HANDLER, ROLES.SOURCING_DEPARTMENT];

// interview_schedules.description is added by migration 023, but on prod the
// table is owned by `postgres` so the ALTER is rejected ("must be owner").
// Cache a one-time existence check so scheduling degrades gracefully (inserts
// without the column) instead of 500ing; the description still goes into the
// WhatsApp invite regardless (B016). Run scripts/fix-interview-ownership.js to
// add the column and enable DB persistence.
let _ivDescColumn = null;
async function interviewHasDescriptionColumn() {
    if (_ivDescColumn !== null) return _ivDescColumn;
    try {
        const r = await query(adaptQuery(
            `SELECT 1 FROM information_schema.columns
              WHERE table_name = 'interview_schedules' AND column_name = 'description' LIMIT 1`
        ), []);
        _ivDescColumn = r.rows.length > 0;
    } catch (_) {
        _ivDescColumn = false;
    }
    return _ivDescColumn;
}

// ── List / filter interviews ──────────────────────────────────────────────────
router.get('/', authenticate, requireSection('interviews', 'view'), async (req, res, next) => {
    try {
        const { job_id, project_id, status, date_from, date_to, limit = 50, offset = 0 } = req.query;

        const params = [];
        const conditions = ['1=1'];

        if (job_id) {
            params.push(job_id);
            conditions.push(`a.job_id = $${params.length}`);
        }
        // Group-by-project support: filter all interviews that belong to any
        // job inside the given project. Joined via applications → jobs already.
        if (project_id) {
            params.push(project_id);
            conditions.push(`j.project_id = $${params.length}`);
        }
        if (status) {
            params.push(status);
            conditions.push(`iv.status = $${params.length}`);
        }
        if (date_from) {
            params.push(date_from);
            conditions.push(`iv.scheduled_datetime >= $${params.length}`);
        }
        if (date_to) {
            params.push(date_to);
            conditions.push(`iv.scheduled_datetime <= $${params.length}`);
        }

        params.push(parseInt(limit, 10));
        params.push(parseInt(offset, 10));

        const sql = `
            SELECT
                iv.*,
                c.name AS candidate_name, c.phone AS candidate_phone,
                c.whatsapp_unreachable,
                j.title AS job_title, j.id AS job_id, j.project_id,
                p.title AS project_title,
                a.id AS application_id,
                u.full_name AS interviewer_name
            FROM interview_schedules iv
            JOIN applications a ON iv.application_id = a.id
            JOIN candidates c ON a.candidate_id = c.id
            JOIN jobs j ON a.job_id = j.id
            LEFT JOIN projects p ON j.project_id = p.id
            LEFT JOIN users u ON iv.interviewer_id = u.id
            WHERE ${conditions.join(' AND ')}
            ORDER BY COALESCE(c.whatsapp_unreachable, FALSE) ASC, iv.scheduled_datetime ASC
            LIMIT $${params.length - 1} OFFSET $${params.length}
        `;

        const result = await query(sql, params);
        res.json(result.rows);
    } catch (err) { next(err); }
});

// ── Upcoming interviews (next 7 days) — dashboard widget ─────────────────────
router.get('/upcoming', authenticate, requireSection('interviews', 'view'), async (req, res, next) => {
    try {
        const result = await query(
            adaptQuery(`
                SELECT
                    iv.id, iv.scheduled_datetime, iv.location, iv.status,
                    iv.duration_minutes, iv.rating,
                    c.id AS candidate_id, c.name AS candidate_name, c.phone AS candidate_phone,
                    j.id AS job_id, j.title AS job_title,
                    a.id AS application_id
                FROM interview_schedules iv
                JOIN applications a ON iv.application_id = a.id
                JOIN candidates c ON a.candidate_id = c.id
                JOIN jobs j ON a.job_id = j.id
                WHERE iv.status IN ('scheduled','confirmed')
                  AND iv.scheduled_datetime BETWEEN NOW() AND NOW() + INTERVAL '7 days'
                ORDER BY iv.scheduled_datetime ASC
                LIMIT 50
            `)
        );
        res.json(result.rows);
    } catch (err) { next(err); }
});

// ── Interviewer directory (scheduler-scoped, not admin-only) ───────────────────
// Registered BEFORE '/:id' so the literal "interviewers" path isn't captured by
// the :id param route. Lets project handlers populate the interviewer dropdown
// without granting them admin /users access.
router.get('/interviewers', authenticate, requireSection('interviews', 'view'), authorize(...SCHEDULER_ROLES), async (req, res, next) => {
    try {
        const result = await query(
            adaptQuery(`
                SELECT id, full_name, role
                FROM users
                WHERE is_active = TRUE
                  AND role IN ('admin', 'project_handler', 'sourcing_department')
                ORDER BY full_name ASC
            `),
            []
        );
        res.json(result.rows);
    } catch (err) { next(err); }
});

// ── Applications still awaiting their interview message ───────────────────────
// Powers the "Quick select 100" button: the next N applications that are ready
// to be invited (certified, or scheduled-but-the-WhatsApp-never-confirmed) and
// have NOT yet had a successful interview invite. confirmation_sent_at is the
// source of truth — it's set only when the invite WhatsApp succeeds, so a failed
// (out-of-window / no-WhatsApp) send correctly leaves the application "pending".
// Registered before '/:id' so the literal path isn't captured by the param route.
router.get('/pending-send', authenticate, requireSection('interviews', 'view'), async (req, res, next) => {
    try {
        const { project_id } = req.query;
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), BULK_MAX);

        const params = [];
        const conditions = [
            `a.status IN ('certified','interview_scheduled')`,
            `NOT EXISTS (
                SELECT 1 FROM interview_schedules iv
                WHERE iv.application_id = a.id
                  AND iv.confirmation_sent_at IS NOT NULL
                  AND iv.status <> 'cancelled'
            )`,
        ];
        if (project_id) {
            params.push(project_id);
            conditions.push(`j.project_id = $${params.length}`);
        }
        params.push(limit);

        // Oldest-waiting first = fair queue; each successful send drops the row out
        // of this set, so re-pressing the button returns the NEXT batch.
        const sql = `
            SELECT a.id AS application_id, a.candidate_id, a.status,
                   c.name AS candidate_name, c.phone AS candidate_phone,
                   j.title AS job_title, j.project_id,
                   COUNT(*) OVER () AS total_pending
            FROM applications a
            JOIN candidates c ON a.candidate_id = c.id
            JOIN jobs j ON a.job_id = j.id
            WHERE ${conditions.join(' AND ')}
            ORDER BY a.applied_at ASC NULLS LAST
            LIMIT $${params.length}
        `;
        const result = await query(sql, params);
        const total = result.rows.length ? parseInt(result.rows[0].total_pending, 10) : 0;
        res.json({
            total_pending: total,
            returned: result.rows.length,
            application_ids: result.rows.map((r) => r.application_id),
            applications: result.rows.map((r) => ({
                application_id: r.application_id,
                candidate_id: r.candidate_id,
                candidate_name: r.candidate_name,
                candidate_phone: r.candidate_phone,
                job_title: r.job_title,
                project_id: r.project_id,
                status: r.status,
            })),
        });
    } catch (err) { next(err); }
});

// ── Unreachable candidates CSV (manual call list) ─────────────────────────────
// Streams a CSV of candidates flagged "not a WhatsApp user" so agents can phone
// them — the guarantee that no application is silently dropped. Registered before
// '/:id'. The .csv suffix is captured by '/:id'-less literal matching here.
router.get('/unreachable.csv', authenticate, requireSection('interviews', 'view'), async (req, res, next) => {
    try {
        const { project_id } = req.query;
        const params = [];
        let projectFilter = '';
        if (project_id) {
            params.push(project_id);
            projectFilter = `AND app.project_id = $${params.length}`;
        }
        const result = await query(
            adaptQuery(`
                SELECT c.name, c.phone, c.whatsapp_last_error, c.whatsapp_checked_at,
                       app.job_title, app.project_title
                FROM candidates c
                LEFT JOIN LATERAL (
                    SELECT j.title AS job_title, p.title AS project_title, j.project_id
                    FROM applications a
                    JOIN jobs j ON a.job_id = j.id
                    LEFT JOIN projects p ON j.project_id = p.id
                    WHERE a.candidate_id = c.id
                    ORDER BY a.applied_at DESC NULLS LAST
                    LIMIT 1
                ) app ON TRUE
                WHERE c.whatsapp_unreachable IS TRUE ${projectFilter}
                ORDER BY c.whatsapp_checked_at DESC NULLS LAST
            `),
            params
        );

        const esc = (v) => {
            const s = v === null || v === undefined ? '' : String(v);
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const header = ['Name', 'Phone', 'Job', 'Project', 'Last error', 'Last attempt'];
        const lines = [header.join(',')];
        for (const r of result.rows) {
            lines.push([
                esc(r.name), esc(r.phone), esc(r.job_title), esc(r.project_title),
                esc(r.whatsapp_last_error),
                esc(r.whatsapp_checked_at ? new Date(r.whatsapp_checked_at).toISOString() : ''),
            ].join(','));
        }
        // BOM so Excel reads UTF-8 (Sinhala/Tamil names) correctly.
        const csv = '﻿' + lines.join('\r\n');
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="unreachable-candidates.csv"`);
        res.send(csv);
    } catch (err) { next(err); }
});

// ── Get single interview ──────────────────────────────────────────────────────
router.get('/:id', authenticate, requireSection('interviews', 'view'), async (req, res, next) => {
    try {
        const result = await query(
            adaptQuery(`
                SELECT iv.*,
                    c.name AS candidate_name, c.phone AS candidate_phone, c.email AS candidate_email,
                    c.id AS candidate_id,
                    j.title AS job_title, j.id AS job_id,
                    u.full_name AS interviewer_name
                FROM interview_schedules iv
                JOIN applications a ON iv.application_id = a.id
                JOIN candidates c ON a.candidate_id = c.id
                JOIN jobs j ON a.job_id = j.id
                LEFT JOIN users u ON iv.interviewer_id = u.id
                WHERE iv.id = $1
            `),
            [req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Interview not found' });
        res.json(result.rows[0]);
    } catch (err) { next(err); }
});

// ── Schedule new interview ────────────────────────────────────────────────────
router.post('/', authenticate, requireSection('interviews', 'create'), authorize(...SCHEDULER_ROLES), async (req, res, next) => {
    try {
        const {
            application_id,
            scheduled_datetime,
            location,
            interviewer_id,
            duration_minutes = 30,
            description,
            translate_notes = false,
            notify_channels = ['whatsapp']
        } = req.body;

        if (!application_id || !scheduled_datetime) {
            return res.status(400).json({ error: 'application_id and scheduled_datetime are required' });
        }

        // Validate application exists and grab candidate/job info
        const appResult = await query(
            adaptQuery(`
                SELECT a.id, a.candidate_id, a.job_id, c.name, j.title AS job_title
                FROM applications a
                JOIN candidates c ON a.candidate_id = c.id
                JOIN jobs j ON a.job_id = j.id
                WHERE a.id = $1
            `),
            [application_id]
        );
        if (appResult.rows.length === 0) return res.status(404).json({ error: 'Application not found' });
        const { candidate_id, job_title } = appResult.rows[0];

        const id = generateUUID();
        if (await interviewHasDescriptionColumn()) {
            await query(
                adaptQuery(`
                    INSERT INTO interview_schedules
                        (id, application_id, scheduled_datetime, location, interviewer_id,
                         duration_minutes, status, description, created_by)
                    VALUES ($1, $2, $3, $4, $5, $6, 'scheduled', $7, $8)
                `),
                [id, application_id, scheduled_datetime, location || null, interviewer_id || null,
                 duration_minutes, description || null, req.user.id]
            );
        } else {
            // description column not present (table-ownership block) — persist
            // the row without it; the note still rides the WhatsApp invite below.
            await query(
                adaptQuery(`
                    INSERT INTO interview_schedules
                        (id, application_id, scheduled_datetime, location, interviewer_id,
                         duration_minutes, status, created_by)
                    VALUES ($1, $2, $3, $4, $5, $6, 'scheduled', $7)
                `),
                [id, application_id, scheduled_datetime, location || null, interviewer_id || null,
                 duration_minutes, req.user.id]
            );
        }

        // Update application status to interview_scheduled
        await query(
            adaptQuery("UPDATE applications SET status = 'interview_scheduled', interview_datetime = $1, interview_location = $2, updated_at = NOW() WHERE id = $3"),
            [scheduled_datetime, location || null, application_id]
        );
        // Candidate stage → Interview Scheduled.
        syncCandidateStage(candidate_id).catch(() => {});

        // Send candidate notification synchronously so the response carries
        // real per-channel delivery results (no more silent fire-and-forget).
        const channels = Array.isArray(notify_channels) ? notify_channels : ['whatsapp'];
        let notification = { success: [], failed: [] };
        try {
            notification = await notifications.sendInterviewNotification(
                candidate_id, job_title, scheduled_datetime, location || 'TBD', channels, description || null, translate_notes === true
            );
            if (notification.success.some(s => s.channel === 'whatsapp')) {
                await query(
                    adaptQuery('UPDATE interview_schedules SET confirmation_sent_at = NOW() WHERE id = $1'),
                    [id]
                );
            }
        } catch (notifErr) {
            logger.error(`Interview notification failed for ${id}: ${notifErr.message}`);
            notification.failed.push({ channel: 'all', error: notifErr.message });
        }

        const created = await query(adaptQuery('SELECT * FROM interview_schedules WHERE id = $1'), [id]);
        res.status(201).json({ ...created.rows[0], notification });
    } catch (err) { next(err); }
});

// ── Update interview (status / feedback / rating) ─────────────────────────────
router.put('/:id', authenticate, requireSection('interviews', 'edit'), async (req, res, next) => {
    try {
        const { id } = req.params;
        const {
            status, feedback, rating, location,
            scheduled_datetime, interviewer_id, duration_minutes
        } = req.body;

        // Detect a genuine reschedule (datetime actually changed) so we only
        // reset reminder markers + notify the candidate when it really moved.
        let datetimeChanged = false;
        if (scheduled_datetime) {
            try {
                const before = await query(
                    adaptQuery('SELECT scheduled_datetime FROM interview_schedules WHERE id = $1'),
                    [id]
                );
                const oldDt = before.rows[0] && before.rows[0].scheduled_datetime;
                datetimeChanged = !oldDt || new Date(oldDt).getTime() !== new Date(scheduled_datetime).getTime();
            } catch (_) { datetimeChanged = true; }
        }

        const setClauses = [];
        const values = [];
        const p = () => `$${values.length + 1}`;

        if (status)             { setClauses.push(`status = ${p()}`);             values.push(status); }
        if (feedback)           { setClauses.push(`feedback = ${p()}`);           values.push(feedback); }
        if (rating != null)     { setClauses.push(`rating = ${p()}`);             values.push(rating); }
        if (location)           { setClauses.push(`location = ${p()}`);           values.push(location); }
        if (scheduled_datetime) { setClauses.push(`scheduled_datetime = ${p()}`); values.push(scheduled_datetime); }
        if (interviewer_id)     { setClauses.push(`interviewer_id = ${p()}`);     values.push(interviewer_id); }
        if (duration_minutes)   { setClauses.push(`duration_minutes = ${p()}`);   values.push(duration_minutes); }
        if (status === 'completed') { setClauses.push('completed_at = NOW()'); }
        // Reschedule: clear the one-shot reminder marker so reminders re-fire for
        // the new datetime (reminder_sent_at always exists; cadence columns are
        // reset best-effort below in case the prod table lacks them).
        if (datetimeChanged) { setClauses.push('reminder_sent_at = NULL'); }

        if (setClauses.length === 0) return res.status(400).json({ error: 'No fields to update' });

        values.push(id);
        await query(
            `UPDATE interview_schedules SET ${setClauses.join(', ')} WHERE id = $${values.length}`,
            values
        );

        // Reschedule: reset the recurring-cadence markers so the daily + day-of
        // reminders run again for the new date. Best-effort — the migration-025
        // columns may be absent on a postgres-owned prod table.
        if (datetimeChanged) {
            try {
                await query(
                    adaptQuery(`UPDATE interview_schedules
                                   SET last_reminder_date = NULL,
                                       reminder_count = 0,
                                       dayof_reminder_sent_at = NULL
                                 WHERE id = $1`),
                    [id]
                );
            } catch (_) { /* cadence columns not present (ownership) — reminder_sent_at reset above still resumes reminders */ }
        }

        const updated = await query(adaptQuery('SELECT * FROM interview_schedules WHERE id = $1'), [id]);
        if (updated.rows.length === 0) return res.status(404).json({ error: 'Interview not found' });

        // Tell the candidate their interview moved (fire-and-forget so the
        // response isn't blocked by outbound WhatsApp).
        if (datetimeChanged) {
            try {
                const info = await query(adaptQuery(`
                    SELECT c.id AS candidate_id, j.title AS job_title
                    FROM interview_schedules iv
                    JOIN applications a ON iv.application_id = a.id
                    JOIN candidates c ON a.candidate_id = c.id
                    JOIN jobs j ON a.job_id = j.id
                    WHERE iv.id = $1
                `), [id]);
                if (info.rows.length) {
                    const row = updated.rows[0];
                    notifications.sendInterviewRescheduledNotification(
                        info.rows[0].candidate_id, info.rows[0].job_title,
                        row.scheduled_datetime, row.location || 'TBD'
                    ).catch((e) => logger.warn(`reschedule notify failed for interview ${id}: ${e.message}`));
                }
            } catch (e) { logger.warn(`reschedule notify lookup failed for ${id}: ${e.message}`); }
        }

        res.json(updated.rows[0]);
    } catch (err) { next(err); }
});

// ── Cancel / delete interview ─────────────────────────────────────────────────
router.delete('/:id', authenticate, requireSection('interviews', 'delete'), async (req, res, next) => {
    try {
        const result = await query(
            adaptQuery("UPDATE interview_schedules SET status = 'cancelled' WHERE id = $1 RETURNING id, application_id"),
            [req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Interview not found' });

        // Tell the candidate their interview was cancelled (fire-and-forget).
        try {
            const info = await query(adaptQuery(`
                SELECT c.id AS candidate_id, j.title AS job_title
                FROM applications a
                JOIN candidates c ON a.candidate_id = c.id
                JOIN jobs j ON a.job_id = j.id
                WHERE a.id = $1
            `), [result.rows[0].application_id]);
            if (info.rows.length) {
                notifications.sendInterviewCancelledNotification(
                    info.rows[0].candidate_id, info.rows[0].job_title
                ).catch((e) => logger.warn(`cancel notify failed for interview ${req.params.id}: ${e.message}`));
            }
        } catch (e) { logger.warn(`cancel notify lookup failed for ${req.params.id}: ${e.message}`); }

        res.json({ success: true, id: req.params.id });
    } catch (err) { next(err); }
});

// ── Manually trigger reminder ─────────────────────────────────────────────────
router.post('/:id/remind', authenticate, requireSection('interviews', 'edit'), authorize(...SCHEDULER_ROLES), async (req, res, next) => {
    try {
        const ivResult = await query(
            adaptQuery(`
                SELECT iv.*, c.id AS candidate_id, j.title AS job_title
                FROM interview_schedules iv
                JOIN applications a ON iv.application_id = a.id
                JOIN candidates c ON a.candidate_id = c.id
                JOIN jobs j ON a.job_id = j.id
                WHERE iv.id = $1
            `),
            [req.params.id]
        );
        if (ivResult.rows.length === 0) return res.status(404).json({ error: 'Interview not found' });
        const iv = ivResult.rows[0];

        const channels = req.body.notify_channels || ['whatsapp'];
        let notification = { success: [], failed: [] };
        try {
            notification = await notifications.sendInterviewReminderNotification(
                iv.candidate_id, iv.job_title, iv.scheduled_datetime, iv.location || 'TBD', channels
            );
            if (notification.success.some(s => s.channel === 'whatsapp')) {
                await query(
                    adaptQuery('UPDATE interview_schedules SET reminder_sent_at = NOW() WHERE id = $1'),
                    [req.params.id]
                );
            }
        } catch (notifErr) {
            logger.error(`Reminder send failed for ${req.params.id}: ${notifErr.message}`);
            notification.failed.push({ channel: 'all', error: notifErr.message });
        }

        const ok = notification.success.length > 0;
        res.json({
            success: ok,
            message: ok ? 'Reminder sent' : 'Reminder send failed',
            notification,
        });
    } catch (err) { next(err); }
});

// ── Bulk notify — re-send the interview WhatsApp to multiple scheduled
// candidates at once. Used by the Interview Management page when a project
// handler picks several rows and clicks "Notify selected".
router.post('/bulk-notify', authenticate, requireSection('interviews', 'edit'), authorize(...SCHEDULER_ROLES), async (req, res, next) => {
    try {
        const { interview_ids, translate_notes = false } = req.body || {};
        if (!Array.isArray(interview_ids) || interview_ids.length === 0) {
            return res.status(400).json({ error: 'interview_ids must be a non-empty array' });
        }
        if (interview_ids.length > BULK_MAX) {
            return res.status(400).json({ error: `Cannot notify more than ${BULK_MAX} interviews at once` });
        }

        // Pull the rows we need to send notifications. Skip any that no
        // longer exist instead of failing the whole batch. Include the stored
        // description (when the column exists) so the re-sent invite carries
        // the same instructions as the original.
        const hasDescCol = await interviewHasDescriptionColumn();
        const result = await query(
            adaptQuery(`
                SELECT iv.id, iv.scheduled_datetime, iv.location,
                       ${hasDescCol ? 'iv.description,' : ''}
                       a.candidate_id, j.title AS job_title
                FROM interview_schedules iv
                JOIN applications a ON iv.application_id = a.id
                JOIN jobs j ON a.job_id = j.id
                WHERE iv.id = ANY($1::uuid[])
            `),
            [interview_ids]
        );

        const successes = [];
        const failures = [];
        for (const row of result.rows) {
            try {
                const notif = await notifications.sendInterviewNotification(
                    row.candidate_id,
                    row.job_title,
                    row.scheduled_datetime,
                    row.location || 'TBD',
                    ['whatsapp'],
                    row.description || null,
                    translate_notes === true
                );
                await applyWhatsappReachability(row.candidate_id, notif);
                if (notif.success.length > 0) {
                    successes.push({ interview_id: row.id, channels: notif.success.map(s => s.channel) });
                    await query(
                        adaptQuery('UPDATE interview_schedules SET confirmation_sent_at = NOW() WHERE id = $1'),
                        [row.id]
                    );
                }
                if (notif.failed.length > 0) {
                    failures.push({ interview_id: row.id, errors: notif.failed });
                }
            } catch (err) {
                logger.warn(`Bulk-notify: interview ${row.id} failed: ${err.message}`);
                failures.push({ interview_id: row.id, errors: [{ channel: 'whatsapp', error: err.message }] });
            }
        }

        res.json({
            total_requested: interview_ids.length,
            total_processed: result.rows.length,
            successes,
            failures,
        });
    } catch (err) { next(err); }
});

// ── Bulk schedule — create N interview rows sharing the same datetime/
// location, flip each application's status to interview_scheduled, and
// dispatch the invitation WhatsApp per candidate. One round-trip from the
// UI instead of N.
router.post('/bulk-schedule', authenticate, requireSection('interviews', 'edit'), authorize(...SCHEDULER_ROLES), async (req, res, next) => {
    try {
        const {
            application_ids,
            scheduled_datetime,
            location,
            duration_minutes = 30,
            interviewer_id,
            interviewer_ids,
            description,
            translate_notes = false,
            notify_channels = ['whatsapp'],
            mode = 'fixed',
            start_date,
            per_day_limit,
            slot_minutes,
            dry_run = false,
        } = req.body || {};

        if (!Array.isArray(application_ids) || application_ids.length === 0) {
            return res.status(400).json({ error: 'application_ids must be a non-empty array' });
        }
        if (application_ids.length > BULK_MAX) {
            return res.status(400).json({ error: `Cannot schedule more than ${BULK_MAX} interviews at once` });
        }

        const isSmart = String(mode).toLowerCase() === 'smart';
        if (!isSmart && !scheduled_datetime) {
            return res.status(400).json({ error: 'scheduled_datetime is required (or use mode="smart")' });
        }

        // Interviewer lane(s): smart mode is interviewer-scoped (the per-day cap
        // is per interviewer), so it requires at least one.
        const interviewerLanes = Array.isArray(interviewer_ids) && interviewer_ids.length
            ? interviewer_ids.filter(Boolean)
            : (interviewer_id ? [interviewer_id] : []);
        if (isSmart) {
            if (!start_date) return res.status(400).json({ error: 'start_date (YYYY-MM-DD) is required for smart mode' });
            if (interviewerLanes.length === 0) return res.status(400).json({ error: 'At least one interviewer is required for smart mode' });
        }

        // Fetch the apps we'll touch, joined to candidate+job for notification.
        const appsResult = await query(
            adaptQuery(`
                SELECT a.id, a.candidate_id, a.job_id, c.name, j.title AS job_title
                FROM applications a
                JOIN candidates c ON a.candidate_id = c.id
                JOIN jobs j ON a.job_id = j.id
                WHERE a.id = ANY($1::uuid[])
            `),
            [application_ids]
        );

        // Preserve the caller's order so allocation is deterministic.
        const orderIndex = new Map(application_ids.map((id, i) => [id, i]));
        const appRows = appsResult.rows.slice().sort(
            (a, b) => (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0)
        );

        // Build a per-application slot plan: id -> { datetime, interviewer_id }.
        const slotMins = Math.min(Math.max(parseInt(slot_minutes, 10) || DEFAULT_SLOT_MINUTES, 5), 240);
        const perDay = Math.min(Math.max(parseInt(per_day_limit, 10) || DEFAULT_PER_DAY_LIMIT, 1), 50);
        const plan = new Map();
        let allocation = null;

        if (isSmart) {
            // Seed existing per-interviewer/day load so re-runs don't overbook.
            const seedRes = await query(
                adaptQuery(`
                    SELECT interviewer_id, CAST(scheduled_datetime AS DATE) AS d, COUNT(*) AS n
                    FROM interview_schedules
                    WHERE interviewer_id = ANY($1::uuid[])
                      AND status IN ('scheduled', 'confirmed')
                      AND scheduled_datetime >= $2
                    GROUP BY interviewer_id, CAST(scheduled_datetime AS DATE)
                `),
                [interviewerLanes, start_date]
            );
            const existingByInterviewerDay = {};
            for (const r of seedRes.rows) {
                const dKey = (r.d instanceof Date) ? r.d.toISOString().slice(0, 10) : String(r.d).slice(0, 10);
                if (!existingByInterviewerDay[r.interviewer_id]) existingByInterviewerDay[r.interviewer_id] = {};
                existingByInterviewerDay[r.interviewer_id][dKey] = Number(r.n) || 0;
            }

            allocation = allocateInterviewSlots({
                applications: appRows.map((a) => a.id),
                interviewerIds: interviewerLanes,
                startDate: start_date,
                perDayLimit: perDay,
                slotMinutes: slotMins,
                existingByInterviewerDay,
            });
            for (const a of allocation.assignments) {
                plan.set(a.application_id, { datetime: a.scheduled_datetime, interviewer_id: a.interviewer_id });
            }
        } else {
            for (const a of appRows) {
                plan.set(a.id, { datetime: scheduled_datetime, interviewer_id: interviewer_id || null });
            }
        }

        // Smart preview (dry run): return the day-by-day plan without writing.
        if (isSmart && (dry_run === true || dry_run === 'true' || dry_run === 1)) {
            const nameByApp = new Map(appRows.map((a) => [a.id, { candidate_name: a.name, job_title: a.job_title }]));
            const enrich = (it) => ({
                ...it,
                candidate_name: nameByApp.get(it.application_id)?.candidate_name || null,
                job_title: nameByApp.get(it.application_id)?.job_title || null,
            });
            const dates = (allocation.assignments || []).map((a) => a.scheduled_datetime.slice(0, 10)).sort();
            return res.json({
                mode: 'smart',
                dry_run: true,
                total: appRows.length,
                effective_slots_per_day: allocation.effective_slots_per_day,
                physical_slots_per_day: allocation.physical_slots_per_day,
                span: dates.length ? { first: dates[0], last: dates[dates.length - 1] } : null,
                assignments: allocation.assignments.map(enrich),
                byDay: (allocation.byDay || []).map((b) => ({ ...b, items: b.items.map(enrich) })),
            });
        }

        const created = [];
        const skipped = [];
        const notificationResults = [];
        const channels = Array.isArray(notify_channels) ? notify_channels : ['whatsapp'];
        // Resolve once for the whole batch; the note still rides the WhatsApp
        // invite even when the column is absent (B016).
        const hasDescCol = await interviewHasDescriptionColumn();

        for (const app of appRows) {
            const slot = plan.get(app.id);
            if (!slot || !slot.datetime) {
                skipped.push({ application_id: app.id, error: 'No slot allocated' });
                continue;
            }
            const apptDatetime = slot.datetime;
            const apptInterviewer = slot.interviewer_id || interviewer_id || null;
            try {
                const id = generateUUID();
                if (hasDescCol) {
                    await query(
                        adaptQuery(`
                            INSERT INTO interview_schedules
                                (id, application_id, scheduled_datetime, location, interviewer_id,
                                 duration_minutes, status, description, created_by)
                            VALUES ($1, $2, $3, $4, $5, $6, 'scheduled', $7, $8)
                        `),
                        [id, app.id, apptDatetime, location || null, apptInterviewer,
                         duration_minutes, description || null, req.user.id]
                    );
                } else {
                    await query(
                        adaptQuery(`
                            INSERT INTO interview_schedules
                                (id, application_id, scheduled_datetime, location, interviewer_id,
                                 duration_minutes, status, created_by)
                            VALUES ($1, $2, $3, $4, $5, $6, 'scheduled', $7)
                        `),
                        [id, app.id, apptDatetime, location || null, apptInterviewer,
                         duration_minutes, req.user.id]
                    );
                }
                await query(
                    adaptQuery(`
                        UPDATE applications
                        SET status = 'interview_scheduled',
                            interview_datetime = $1,
                            interview_location = $2,
                            updated_at = NOW()
                        WHERE id = $3
                    `),
                    [apptDatetime, location || null, app.id]
                );
                // Candidate stage → Interview Scheduled.
                syncCandidateStage(app.candidate_id).catch(() => {});

                let notification = { success: [], failed: [] };
                try {
                    notification = await notifications.sendInterviewNotification(
                        app.candidate_id, app.job_title, apptDatetime, location || 'TBD', channels, description || null, translate_notes === true
                    );
                    await applyWhatsappReachability(app.candidate_id, notification);
                    if (notification.success.some(s => s.channel === 'whatsapp')) {
                        await query(
                            adaptQuery('UPDATE interview_schedules SET confirmation_sent_at = NOW() WHERE id = $1'),
                            [id]
                        );
                    }
                } catch (notifErr) {
                    logger.warn(`Bulk-schedule: notification failed for ${id}: ${notifErr.message}`);
                    notification.failed.push({ channel: 'all', error: notifErr.message });
                }

                created.push({
                    interview_id: id,
                    application_id: app.id,
                    candidate_name: app.name,
                    scheduled_datetime: apptDatetime,
                    interviewer_id: apptInterviewer,
                });
                notificationResults.push({ application_id: app.id, notification });
            } catch (err) {
                logger.warn(`Bulk-schedule: failed for application ${app.id}: ${err.message}`);
                skipped.push({ application_id: app.id, error: err.message });
            }
        }

        res.status(201).json({
            mode: isSmart ? 'smart' : 'fixed',
            total_requested: application_ids.length,
            total_created: created.length,
            created,
            skipped,
            notifications: notificationResults,
            ...(isSmart && allocation
                ? { byDay: allocation.byDay, effective_slots_per_day: allocation.effective_slots_per_day }
                : {}),
        });
    } catch (err) { next(err); }
});

module.exports = router;
