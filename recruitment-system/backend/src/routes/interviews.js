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
const { authenticate } = require('../middleware/auth');
const notifications = require('../services/notifications');
const logger = require('../utils/logger');

// ── List / filter interviews ──────────────────────────────────────────────────
router.get('/', authenticate, async (req, res, next) => {
    try {
        const { job_id, status, date_from, date_to, limit = 50, offset = 0 } = req.query;

        const params = [];
        const conditions = ['1=1'];

        if (job_id) {
            params.push(job_id);
            conditions.push(`a.job_id = $${params.length}`);
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
                j.title AS job_title, j.id AS job_id,
                u.full_name AS interviewer_name
            FROM interview_schedules iv
            JOIN applications a ON iv.application_id = a.id
            JOIN candidates c ON a.candidate_id = c.id
            JOIN jobs j ON a.job_id = j.id
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
router.post('/', authenticate, async (req, res, next) => {
    try {
        const {
            application_id,
            scheduled_datetime,
            location,
            interviewer_id,
            duration_minutes = 30,
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

        // Update application status to interview_scheduled
        await query(
            adaptQuery("UPDATE applications SET status = 'interview_scheduled', interview_datetime = $1, interview_location = $2, updated_at = NOW() WHERE id = $3"),
            [scheduled_datetime, location || null, application_id]
        );

        // Send candidate notification asynchronously
        const channels = Array.isArray(notify_channels) ? notify_channels : ['whatsapp'];
        setImmediate(async () => {
            try {
                await notifications.sendInterviewNotification(
                    candidate_id, job_title, scheduled_datetime, location || 'TBD', channels
                );
                // Mark confirmation sent
                await query(
                    adaptQuery('UPDATE interview_schedules SET confirmation_sent_at = NOW() WHERE id = $1'),
                    [id]
                );
            } catch (notifErr) {
                logger.error(`Interview notification failed for ${id}: ${notifErr.message}`);
            }
        });

        const created = await query(adaptQuery('SELECT * FROM interview_schedules WHERE id = $1'), [id]);
        res.status(201).json(created.rows[0]);
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
router.post('/:id/remind', authenticate, async (req, res, next) => {
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
        await notifications.sendInterviewNotification(
            iv.candidate_id, iv.job_title, iv.scheduled_datetime, iv.location || 'TBD', channels
        );
        await query(
            adaptQuery('UPDATE interview_schedules SET reminder_sent_at = NOW() WHERE id = $1'),
            [req.params.id]
        );

        res.json({ success: true, message: 'Reminder sent' });
    } catch (err) { next(err); }
});

module.exports = router;
