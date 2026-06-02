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
const notifications = require('../services/notifications');
const logger = require('../utils/logger');

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
router.get('/', authenticate, async (req, res, next) => {
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
            ORDER BY iv.scheduled_datetime ASC
            LIMIT $${params.length - 1} OFFSET $${params.length}
        `;

        const result = await query(sql, params);
        res.json(result.rows);
    } catch (err) { next(err); }
});

// ── Upcoming interviews (next 7 days) — dashboard widget ─────────────────────
router.get('/upcoming', authenticate, async (req, res, next) => {
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

// ── Get single interview ──────────────────────────────────────────────────────
router.get('/:id', authenticate, async (req, res, next) => {
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
router.post('/', authenticate, authorize(...SCHEDULER_ROLES), async (req, res, next) => {
    try {
        const {
            application_id,
            scheduled_datetime,
            location,
            interviewer_id,
            duration_minutes = 30,
            description,
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

        // Send candidate notification synchronously so the response carries
        // real per-channel delivery results (no more silent fire-and-forget).
        const channels = Array.isArray(notify_channels) ? notify_channels : ['whatsapp'];
        let notification = { success: [], failed: [] };
        try {
            notification = await notifications.sendInterviewNotification(
                candidate_id, job_title, scheduled_datetime, location || 'TBD', channels, description || null
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
router.put('/:id', authenticate, async (req, res, next) => {
    try {
        const { id } = req.params;
        const {
            status, feedback, rating, location,
            scheduled_datetime, interviewer_id, duration_minutes
        } = req.body;

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

        if (setClauses.length === 0) return res.status(400).json({ error: 'No fields to update' });

        values.push(id);
        await query(
            `UPDATE interview_schedules SET ${setClauses.join(', ')} WHERE id = $${values.length}`,
            values
        );

        const updated = await query(adaptQuery('SELECT * FROM interview_schedules WHERE id = $1'), [id]);
        if (updated.rows.length === 0) return res.status(404).json({ error: 'Interview not found' });
        res.json(updated.rows[0]);
    } catch (err) { next(err); }
});

// ── Cancel / delete interview ─────────────────────────────────────────────────
router.delete('/:id', authenticate, async (req, res, next) => {
    try {
        const result = await query(
            adaptQuery("UPDATE interview_schedules SET status = 'cancelled' WHERE id = $1 RETURNING id"),
            [req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Interview not found' });
        res.json({ success: true, id: req.params.id });
    } catch (err) { next(err); }
});

// ── Manually trigger reminder ─────────────────────────────────────────────────
router.post('/:id/remind', authenticate, authorize(...SCHEDULER_ROLES), async (req, res, next) => {
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
router.post('/bulk-notify', authenticate, authorize(...SCHEDULER_ROLES), async (req, res, next) => {
    try {
        const { interview_ids } = req.body || {};
        if (!Array.isArray(interview_ids) || interview_ids.length === 0) {
            return res.status(400).json({ error: 'interview_ids must be a non-empty array' });
        }
        if (interview_ids.length > 200) {
            return res.status(400).json({ error: 'Cannot notify more than 200 interviews at once' });
        }

        // Pull the rows we need to send notifications. Skip any that no
        // longer exist instead of failing the whole batch.
        const result = await query(
            adaptQuery(`
                SELECT iv.id, iv.scheduled_datetime, iv.location,
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
                    ['whatsapp']
                );
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
router.post('/bulk-schedule', authenticate, authorize(...SCHEDULER_ROLES), async (req, res, next) => {
    try {
        const {
            application_ids,
            scheduled_datetime,
            location,
            duration_minutes = 30,
            interviewer_id,
            notify_channels = ['whatsapp'],
        } = req.body || {};

        if (!Array.isArray(application_ids) || application_ids.length === 0) {
            return res.status(400).json({ error: 'application_ids must be a non-empty array' });
        }
        if (!scheduled_datetime) {
            return res.status(400).json({ error: 'scheduled_datetime is required' });
        }
        if (application_ids.length > 100) {
            return res.status(400).json({ error: 'Cannot schedule more than 100 interviews at once' });
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

        const created = [];
        const skipped = [];
        const notificationResults = [];
        const channels = Array.isArray(notify_channels) ? notify_channels : ['whatsapp'];

        for (const app of appsResult.rows) {
            try {
                const id = generateUUID();
                await query(
                    adaptQuery(`
                        INSERT INTO interview_schedules
                            (id, application_id, scheduled_datetime, location, interviewer_id,
                             duration_minutes, status, created_by)
                        VALUES ($1, $2, $3, $4, $5, $6, 'scheduled', $7)
                    `),
                    [id, app.id, scheduled_datetime, location || null, interviewer_id || null,
                     duration_minutes, req.user.id]
                );
                await query(
                    adaptQuery(`
                        UPDATE applications
                        SET status = 'interview_scheduled',
                            interview_datetime = $1,
                            interview_location = $2,
                            updated_at = NOW()
                        WHERE id = $3
                    `),
                    [scheduled_datetime, location || null, app.id]
                );

                let notification = { success: [], failed: [] };
                try {
                    notification = await notifications.sendInterviewNotification(
                        app.candidate_id, app.job_title, scheduled_datetime, location || 'TBD', channels
                    );
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

                created.push({ interview_id: id, application_id: app.id, candidate_name: app.name });
                notificationResults.push({ application_id: app.id, notification });
            } catch (err) {
                logger.warn(`Bulk-schedule: failed for application ${app.id}: ${err.message}`);
                skipped.push({ application_id: app.id, error: err.message });
            }
        }

        res.status(201).json({
            total_requested: application_ids.length,
            total_created: created.length,
            created,
            skipped,
            notifications: notificationResults,
        });
    } catch (err) { next(err); }
});

module.exports = router;
