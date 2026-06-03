const express = require('express');
const router = express.Router();
const { query, withTransaction, generateUUID } = require('../config/database');
const { adaptQuery, isMySQL } = require('../utils/query-adapter');
const { authenticate } = require('../middleware/auth');
const { calculateMatchScore } = require('../config/openai');
const notifications = require('../services/notifications');
const { syncJobAsync } = require('./chatbot-sync');
const { syncCandidateStage } = require('../services/candidate-stage');
const logger = require('../utils/logger');

/**
 * Get all applications with filters
 * MySQL + PostgreSQL compatible
 */
router.get('/', authenticate, async (req, res, next) => {
    try {
        const {
            job_id,
            candidate_id,
            status,
            project_id,
            date_from,
            date_to,
            search,
            page,
            limit,
        } = req.query;
        const params = [];
        let whereClause = ' WHERE 1=1';

        if (job_id) {
            whereClause += isMySQL ? ' AND a.job_id = ?' : ` AND a.job_id = $${params.length + 1}`;
            params.push(job_id);
        }
        if (candidate_id) {
            whereClause += isMySQL ? ' AND a.candidate_id = ?' : ` AND a.candidate_id = $${params.length + 1}`;
            params.push(candidate_id);
        }
        if (status) {
            whereClause += isMySQL ? ' AND a.status = ?' : ` AND a.status = $${params.length + 1}`;
            params.push(status);
        }
        if (project_id) {
            whereClause += isMySQL ? ' AND j.project_id = ?' : ` AND j.project_id = $${params.length + 1}`;
            params.push(project_id);
        }
        if (date_from) {
            whereClause += isMySQL
                ? ' AND DATE(a.applied_at) >= DATE(?)'
                : ` AND CAST(a.applied_at AS DATE) >= CAST($${params.length + 1} AS DATE)`;
            params.push(date_from);
        }
        if (date_to) {
            whereClause += isMySQL
                ? ' AND DATE(a.applied_at) <= DATE(?)'
                : ` AND CAST(a.applied_at AS DATE) <= CAST($${params.length + 1} AS DATE)`;
            params.push(date_to);
        }
        // Candidate name / phone / email search. Digit-normalized so a phone
        // typed with/without country code, spaces or '+' still matches the
        // stored number (mirrors candidates.js search).
        if (search) {
            const digits = String(search).replace(/\D/g, '');
            if (isMySQL) {
                if (digits) {
                    whereClause += " AND (c.name LIKE ? OR c.phone LIKE ? OR c.email LIKE ? OR REPLACE(REPLACE(REPLACE(c.phone, ' ', ''), '-', ''), '+', '') LIKE ?)";
                    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${digits}%`);
                } else {
                    whereClause += ' AND (c.name LIKE ? OR c.phone LIKE ? OR c.email LIKE ?)';
                    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
                }
            } else if (digits) {
                whereClause += ` AND (c.name ILIKE $${params.length + 1} OR c.phone ILIKE $${params.length + 1} OR c.email ILIKE $${params.length + 1} OR regexp_replace(c.phone, '\\D', '', 'g') ILIKE $${params.length + 2})`;
                params.push(`%${search}%`, `%${digits}%`);
            } else {
                whereClause += ` AND (c.name ILIKE $${params.length + 1} OR c.phone ILIKE $${params.length + 1} OR c.email ILIKE $${params.length + 1})`;
                params.push(`%${search}%`);
            }
        }

        const safePage = Math.max(parseInt(page, 10) || 1, 1);
        const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 0, 0), 100);
        const usePagination = safeLimit > 0;

        let paginationClause = '';
        if (usePagination) {
            const offset = (safePage - 1) * safeLimit;
            paginationClause = isMySQL
                ? ` LIMIT ${safeLimit} OFFSET ${offset}`
                : ` LIMIT ${safeLimit} OFFSET ${offset}`;
        }

        const sql = `SELECT a.*, c.name as candidate_name, c.phone as candidate_phone,
                     c.email as candidate_email, j.title as job_title, j.category as job_category,
                     j.project_id, p.title as project_title, p.client_name as project_client
                     FROM applications a
                     JOIN candidates c ON a.candidate_id = c.id
                     JOIN jobs j ON a.job_id = j.id
                     LEFT JOIN projects p ON j.project_id = p.id
                     ${whereClause} ORDER BY a.applied_at DESC${paginationClause}`;
        const result = await query(sql, params);

        if (!usePagination) {
            return res.json(result.rows);
        }

        const countSql = `SELECT COUNT(*) AS total
                          FROM applications a
                          JOIN jobs j ON a.job_id = j.id
                          ${search ? 'JOIN candidates c ON a.candidate_id = c.id' : ''}
                          ${whereClause}`;
        const countResult = await query(countSql, params);
        const total = parseInt(countResult.rows?.[0]?.total, 10) || 0;
        const totalPages = Math.max(Math.ceil(total / safeLimit), 1);

        return res.json({
            data: result.rows,
            pagination: {
                page: safePage,
                limit: safeLimit,
                total,
                totalPages,
            },
        });
    } catch (error) { next(error); }
});

/**
 * Create application
 */
router.post('/', authenticate, async (req, res, next) => {
    try {
        const { candidate_id, job_id } = req.body;
        if (!candidate_id || !job_id) {
            return res.status(400).json({ error: 'Candidate ID and Job ID are required' });
        }

        const candidateResult = await query(
            adaptQuery('SELECT c.*, cv.parsed_data FROM candidates c LEFT JOIN cv_files cv ON c.id = cv.candidate_id WHERE c.id = $1 LIMIT 1'),
            [candidate_id]
        );
        if (candidateResult.rows.length === 0) return res.status(404).json({ error: 'Candidate not found' });

        const jobResult = await query(
            adaptQuery('SELECT j.*, p.title as project_title FROM jobs j INNER JOIN projects p ON j.project_id = p.id WHERE j.id = $1'),
            [job_id]
        );
        if (jobResult.rows.length === 0) return res.status(404).json({ error: 'Job not found or not associated with a project' });

        const candidate = candidateResult.rows[0];
        const job = jobResult.rows[0];
        let matchScore = null;
        if (candidate.parsed_data) {
            try {
                const mr = await calculateMatchScore(candidate.parsed_data, job.requirements);
                matchScore = mr.score;
            } catch (e) { logger.warn('Match score failed:', e.message); }
        }

        // Idempotent insert: a (candidate_id, job_id) pair is unique. Under a
        // race/retry, return the existing application instead of erroring (no
        // more duplicate applications). adaptQuery cannot translate ON CONFLICT,
        // so branch explicitly per dialect.
        const appId = generateUUID();
        let application;
        let created = false;
        if (isMySQL) {
            await query(
                "INSERT INTO applications (id, candidate_id, job_id, match_score, status) VALUES (?, ?, ?, ?, 'applied') ON DUPLICATE KEY UPDATE match_score = VALUES(match_score)",
                [appId, candidate_id, job_id, matchScore]
            );
            const existing = await query(
                'SELECT * FROM applications WHERE candidate_id = ? AND job_id = ? LIMIT 1',
                [candidate_id, job_id]
            );
            application = existing.rows[0];
            created = application && application.id === appId;
        } else {
            const ins = await query(
                "INSERT INTO applications (id, candidate_id, job_id, match_score, status) VALUES ($1, $2, $3, $4, 'applied') ON CONFLICT (candidate_id, job_id) DO NOTHING RETURNING *",
                [appId, candidate_id, job_id, matchScore]
            );
            if (ins.rows.length > 0) {
                application = ins.rows[0];
                created = true;
            } else {
                const existing = await query(
                    'SELECT * FROM applications WHERE candidate_id = $1 AND job_id = $2 LIMIT 1',
                    [candidate_id, job_id]
                );
                application = existing.rows[0];
            }
        }

        // If this candidate was sitting in future_pool (General Pool view),
        // a manual assignment means they belong in active screening now.
        if (candidate.status === 'future_pool') {
            try {
                await query(
                    adaptQuery("UPDATE candidates SET status = 'screening', updated_at = NOW() WHERE id = $1"),
                    [candidate_id]
                );
                logger.info(`Candidate ${candidate_id} lifted from future_pool → screening on manual application`);
            } catch (statusErr) {
                logger.warn(`Failed to lift candidate ${candidate_id} from future_pool: ${statusErr.message}`);
            }
        }

        // New application → candidate moves into screening (or stays 'new' if no
        // CV on file yet). Derived centrally so candidate.status stays in sync.
        syncCandidateStage(candidate_id).catch(() => {});

        res.status(created ? 201 : 200).json(application);
    } catch (error) {
        if (error.message && error.message.toLowerCase().includes('duplicate')) {
            return res.status(400).json({ error: 'Application already exists' });
        }
        next(error);
    }
});

/**
 * Update application status  auto-sends WhatsApp/SMS/email notifications
 */
// Lifecycle transition map. Mirrors frontend constants/lifecycle.js so the
// backend can reject impossible jumps (e.g. applied → selected) regardless
// of what the UI sends. `placed` is terminal in the post-deployment sense
// so it intentionally has no successors here.
const VALID_TRANSITIONS = {
    // Entry states a freshly-sourced candidate sits in before screening.
    // auto_assigned is written by the auto-assign matcher; omitting it here is
    // why certifying a matched candidate always 400'd ("Unable to certify" —
    // B011). reviewing is the manual-intake equivalent.
    auto_assigned:       ['certified', 'rejected', 'screening'],
    reviewing:           ['certified', 'rejected', 'screening'],
    applied:             ['certified', 'rejected', 'screening'],
    screening:           ['certified', 'rejected'],
    certified:           ['pre_screened', 'rejected'],
    pre_screened:        ['interview_scheduled', 'rejected'],
    interview_scheduled: ['selected', 'rejected', 'interviewed'],
    interviewed:         ['selected', 'rejected'],
    selected:            ['placed', 'rejected'],
    rejected:            [],
    placed:              [],
};

router.put('/:id', authenticate, async (req, res, next) => {
    try {
        const { id } = req.params;
        const {
            status, rejection_reason, interview_datetime, interview_location,
            interview_notes, certification_notes, prescreening_datetime,
            prescreening_location, prescreening_notes, prescreening_rating,
            notify_channels = ['whatsapp']
        } = req.body;

        const effDt = prescreening_datetime || interview_datetime;
        const effLoc = prescreening_location || interview_location;

        // Validate the requested status transition against the current state.
        // Skipped when no status was passed (this PUT also accepts pure metadata
        // updates like adding interview_notes without a state change).
        let currentStatus = null;
        if (status) {
            const currentRes = await query(
                adaptQuery('SELECT status FROM applications WHERE id = $1'),
                [id],
            );
            if (currentRes.rows.length === 0) {
                return res.status(404).json({ error: 'Application not found' });
            }
            currentStatus = currentRes.rows[0].status;
            const allowed = VALID_TRANSITIONS[currentStatus] || [];
            // Same-state writes are a no-op upstream — let them through so
            // recruiters can re-trigger notifications without an error.
            if (status !== currentStatus && !allowed.includes(status)) {
                return res.status(400).json({
                    error: `Invalid lifecycle transition: ${currentStatus} → ${status}. Allowed next states: ${allowed.join(', ') || '(none, terminal)'}.`,
                });
            }
        }

        const setClauses = [];
        const values = [];
        const p = () => isMySQL ? '?' : `$${values.length + 1}`;

        if (status) {
            setClauses.push(`status = ${p()}`); values.push(status);
            if (status === 'certified') {
                setClauses.push('certified_at = NOW()');
                setClauses.push(`certified_by = ${p()}`); values.push(req.user.id);
            }
            if (status === 'pre_screened') {
                setClauses.push('prescreening_completed_at = NOW()');
            }
        }
        if (certification_notes)  { setClauses.push(`certification_notes = ${p()}`); values.push(certification_notes); }
        if (rejection_reason)     { setClauses.push(`rejection_reason = ${p()}`);    values.push(rejection_reason); }
        if (effDt)  { setClauses.push(`interview_datetime = ${p()}`); values.push(effDt); }
        if (effLoc) { setClauses.push(`interview_location = ${p()}`); values.push(effLoc); }
        if (interview_notes) { setClauses.push(`interview_notes = ${p()}`); values.push(interview_notes); }
        if (prescreening_notes) { setClauses.push(`prescreening_notes = ${p()}`); values.push(prescreening_notes); }
        if (prescreening_rating != null) {
            const r = parseInt(prescreening_rating, 10);
            if (!Number.isNaN(r) && r >= 1 && r <= 5) {
                setClauses.push(`prescreening_rating = ${p()}`);
                values.push(r);
            }
        }

        if (setClauses.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

        values.push(id);
        await query(`UPDATE applications SET ${setClauses.join(', ')} WHERE id = ${isMySQL ? '?' : `$${values.length}`}`, values);

        const appResult = await query(adaptQuery('SELECT * FROM applications WHERE id = $1'), [id]);
        if (appResult.rows.length === 0) return res.status(404).json({ error: 'Application not found' });
        const application = appResult.rows[0];

        // Re-derive the candidate's canonical stage from this status change.
        if (status) syncCandidateStage(application.candidate_id).catch(() => {});

        if (status === 'certified' && effDt) {
            const existingInterview = await query(
                adaptQuery('SELECT id FROM interview_schedules WHERE application_id = $1 ORDER BY created_at DESC LIMIT 1'),
                [application.id]
            );

            if (existingInterview.rows.length > 0) {
                await query(
                    adaptQuery(`
                        UPDATE interview_schedules
                        SET scheduled_datetime = $1,
                            location = $2,
                            status = 'scheduled'
                        WHERE id = $3
                    `),
                    [effDt, effLoc || null, existingInterview.rows[0].id]
                );
            } else {
                await query(
                    adaptQuery(`
                        INSERT INTO interview_schedules
                            (id, application_id, scheduled_datetime, location, status, created_by)
                        VALUES ($1, $2, $3, $4, 'scheduled', $5)
                    `),
                    [generateUUID(), application.id, effDt, effLoc || null, req.user.id]
                );
            }
        }

        // Approval cascade: when status transitions to selected/placed, the
        // derived positions_filled count on the job increases. If the job is
        // now fully staffed, flip its status to 'complete' and re-sync the
        // chatbot KB so the bot stops offering it. Audit-logged for traceability.
        if (status === 'selected' || status === 'placed') {
            try {
                const fillCheck = await query(
                    adaptQuery(`
                        SELECT j.id AS job_id, j.status AS job_status, j.positions_available,
                               (SELECT COUNT(*)::int FROM applications a
                                WHERE a.job_id = j.id AND a.status IN ('selected','placed')) AS filled
                        FROM jobs j
                        WHERE j.id = $1
                    `),
                    [application.job_id]
                );
                const jobRow = fillCheck.rows[0];
                if (jobRow && jobRow.job_status === 'active'
                    && Number(jobRow.filled) >= Number(jobRow.positions_available || 0)
                    && Number(jobRow.positions_available || 0) > 0) {
                    await query(
                        adaptQuery(`UPDATE jobs SET status = 'complete', updated_at = NOW() WHERE id = $1`),
                        [jobRow.job_id]
                    );
                    logger.info(`Job ${jobRow.job_id} auto-completed: all ${jobRow.positions_available} positions filled`);
                }
                // Re-sync the job to chatbot regardless — positions_remaining changed.
                await syncJobAsync(application.job_id);
            } catch (cascadeErr) {
                logger.warn(`Approval cascade failed for application ${id}: ${cascadeErr.message}`);
            }

            // Audit log
            try {
                await query(
                    adaptQuery(`
                        INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, changes)
                        VALUES ($1, $2, $3, $4, $5, $6)
                    `),
                    [
                        generateUUID(),
                        req.user.id,
                        'application_approved',
                        'application',
                        application.id,
                        JSON.stringify({ new_status: status, job_id: application.job_id }),
                    ]
                );
            } catch (auditErr) {
                logger.warn(`Audit log failed for approval ${id}: ${auditErr.message}`);
            }
        }

        let notification = { success: [], failed: [] };
        if (status) {
            const jobResult = await query(adaptQuery('SELECT title FROM jobs WHERE id = $1'), [application.job_id]);
            const jobTitle = jobResult.rows[0]?.title || 'the position';
            const channels = Array.isArray(notify_channels) ? notify_channels : ['whatsapp'];

            try {
                switch (status) {
                    case 'certified':
                        // Certify is now just the status flip + "you've been
                        // certified, pre-screen coming next" message. Optional
                        // prescreening_datetime is still supported for the
                        // legacy bundled flow but no longer required.
                        if (prescreening_datetime && prescreening_location) {
                            notification = await notifications.sendPreScreeningNotification(
                                application.candidate_id, jobTitle, prescreening_datetime, prescreening_location, channels);
                        } else {
                            notification = await notifications.sendCertificationNotification(
                                application.candidate_id, jobTitle, certification_notes, channels);
                        }
                        break;
                    case 'pre_screened':
                        notification = await notifications.sendPreScreenedPassedNotification(
                            application.candidate_id, jobTitle, channels);
                        break;
                    case 'interview_scheduled':
                        if (effDt && effLoc)
                            notification = await notifications.sendInterviewNotification(application.candidate_id, jobTitle, effDt, effLoc, channels);
                        break;
                    case 'selected':
                        notification = await notifications.sendSelectionNotification(application.candidate_id, jobTitle, channels);
                        break;
                    case 'rejected':
                        notification = await notifications.sendRejectionNotification(application.candidate_id, jobTitle, channels);
                        break;
                }
            } catch (notifError) {
                logger.error(`Notification failed for application ${id}:`, notifError);
                notification.failed.push({ channel: 'all', error: notifError.message });
            }
        }

        res.json({
            ...application,
            notification,
        });
    } catch (error) { next(error); }
});

/**
 * Reject application  move candidate to general pool + notify
 */
router.post('/:id/reject-to-pool', authenticate, async (req, res, next) => {
    try {
        const { id } = req.params;
        const { rejection_reason, notify_channels = ['whatsapp'] } = req.body;

        const appResult = await query(
            adaptQuery('SELECT a.*, j.title as job_title FROM applications a JOIN jobs j ON a.job_id = j.id WHERE a.id = $1'),
            [id]
        );
        if (appResult.rows.length === 0) return res.status(404).json({ error: 'Application not found' });
        const application = appResult.rows[0];

        await query(
            adaptQuery("UPDATE applications SET status = 'rejected', rejection_reason = $1 WHERE id = $2"),
            [rejection_reason || 'Moved to general pool', id]
        );
        await query(
            adaptQuery("UPDATE candidates SET status = 'future_pool', updated_at = NOW() WHERE id = $1"),
            [application.candidate_id]
        );

        const channels = Array.isArray(notify_channels) ? notify_channels : ['whatsapp'];
        let notification = { success: [], failed: [] };
        try {
            notification = await notifications.sendGeneralPoolNotification(application.candidate_id, channels);
        } catch (e) {
            logger.error(`General pool notification failed: ${e.message}`);
            notification.failed.push({ channel: 'all', error: e.message });
        }

        res.json({
            success: true,
            message: 'Candidate moved to general pool',
            application_id: id,
            candidate_id: application.candidate_id,
            channels,
            notification,
        });
    } catch (error) { next(error); }
});

/**
 * Transfer application to a different job
 */
router.post('/:id/transfer', authenticate, async (req, res, next) => {
    try {
        const { id } = req.params;
        const { target_job_id, transfer_reason } = req.body;
        if (!target_job_id) return res.status(400).json({ error: 'Target Job ID is required' });

        const originalAppResult = await query(adaptQuery('SELECT * FROM applications WHERE id = $1'), [id]);
        if (originalAppResult.rows.length === 0) return res.status(404).json({ error: 'Application not found' });
        const originalApp = originalAppResult.rows[0];

        const targetJobResult = await query(adaptQuery('SELECT id, title FROM jobs WHERE id = $1'), [target_job_id]);
        if (targetJobResult.rows.length === 0) return res.status(404).json({ error: 'Target job not found' });

        // Guard against creating a duplicate (candidate_id, job_id) pair — the
        // candidate may already have an application for the target job.
        const dupCheck = await query(
            adaptQuery('SELECT id FROM applications WHERE candidate_id = $1 AND job_id = $2 LIMIT 1'),
            [originalApp.candidate_id, target_job_id]
        );
        if (dupCheck.rows.length > 0) {
            return res.status(409).json({
                error: 'Candidate already has an application for the target job',
                application_id: dupCheck.rows[0].id,
            });
        }

        const newAppId = generateUUID();

        await withTransaction(async (conn) => {
            // Works for both MySQL (conn.execute) and Postgres (conn.query)
            const exec = typeof conn.execute === 'function'
                ? (sql, p) => conn.execute(sql, p)
                : (sql, p) => conn.query(sql, p);

            await exec(
                adaptQuery("INSERT INTO applications (id, candidate_id, job_id, status, transferred_from_job_id, transfer_reason) VALUES ($1, $2, $3, 'reviewing', $4, $5)"),
                [newAppId, originalApp.candidate_id, target_job_id, originalApp.job_id, transfer_reason || null]
            );
            await exec(
                adaptQuery("UPDATE applications SET status = 'transferred', updated_at = NOW() WHERE id = $1"),
                [id]
            );
        });

        const newApp = await query(adaptQuery('SELECT * FROM applications WHERE id = $1'), [newAppId]);

        // The new (reviewing) application resets the candidate's furthest stage.
        syncCandidateStage(originalApp.candidate_id).catch(() => {});

        // Notify candidate that their application has been moved
        const channels = Array.isArray(req.body.notify_channels) ? req.body.notify_channels : ['whatsapp'];
        let notification = { success: [], failed: [] };
        try {
            const oldJobTitle = (await query(adaptQuery('SELECT title FROM jobs WHERE id = $1'), [originalApp.job_id])).rows[0]?.title || 'previous position';
            notification = await notifications.sendTransferNotification(
                originalApp.candidate_id,
                targetJobResult.rows[0].title,
                oldJobTitle,
                channels
            );
        } catch (notifErr) {
            logger.error(`Transfer notification failed for application ${id}: ${notifErr.message}`);
            notification.failed.push({ channel: 'all', error: notifErr.message });
        }

        res.json({ ...newApp.rows[0], notification });
    } catch (error) { next(error); }
});

/**
 * Delete an application (admin only).
 * Cascades to interview_schedules rows that reference this application,
 * so the call works regardless of FK ON DELETE setting.
 */
router.delete('/:id', authenticate, async (req, res, next) => {
    try {
        if (req.user?.role !== 'admin') {
            return res.status(403).json({ error: 'Only admins can delete applications' });
        }

        const { id } = req.params;

        const appResult = await query(
            adaptQuery('SELECT id, candidate_id, job_id FROM applications WHERE id = $1'),
            [id]
        );
        if (appResult.rows.length === 0) {
            return res.status(404).json({ error: 'Application not found' });
        }
        const application = appResult.rows[0];

        await withTransaction(async (conn) => {
            const exec = typeof conn.execute === 'function'
                ? (sql, p) => conn.execute(sql, p)
                : (sql, p) => conn.query(sql, p);

            await exec(adaptQuery('DELETE FROM interview_schedules WHERE application_id = $1'), [id]);
            await exec(adaptQuery('DELETE FROM applications WHERE id = $1'), [id]);
        });

        try {
            await query(
                adaptQuery(`
                    INSERT INTO audit_logs (id, user_id, action, entity_type, entity_id, changes)
                    VALUES ($1, $2, $3, $4, $5, $6)
                `),
                [
                    generateUUID(),
                    req.user.id,
                    'application_deleted',
                    'application',
                    id,
                    JSON.stringify({ candidate_id: application.candidate_id, job_id: application.job_id }),
                ]
            );
        } catch (auditErr) {
            logger.warn(`Audit log failed for application delete ${id}: ${auditErr.message}`);
        }

        res.json({ success: true, application_id: id });
    } catch (error) { next(error); }
});

/**
 * Batch certify multiple applications at once
 */
router.post('/batch-certify', authenticate, async (req, res, next) => {
    try {
        const {
            application_ids,
            prescreening_datetime,
            prescreening_location,
            certification_notes,
            notify_channels = ['whatsapp']
        } = req.body;

        if (!Array.isArray(application_ids) || application_ids.length === 0) {
            return res.status(400).json({ error: 'application_ids array is required' });
        }

        const results = { success: [], failed: [] };
        const channels = Array.isArray(notify_channels) ? notify_channels : ['whatsapp'];

        for (const appId of application_ids) {
            try {
                // Update status and certification fields
                await query(
                    adaptQuery(`UPDATE applications SET
                        status = 'certified',
                        certified_at = NOW(),
                        certified_by = $1,
                        certification_notes = $2
                        ${prescreening_datetime ? ', interview_datetime = $4' : ''}
                        ${prescreening_location  ? `, interview_location = $${prescreening_datetime ? 5 : 4}` : ''}
                        WHERE id = $3`
                        .replace('$4', isMySQL ? '?' : '$4')
                        .replace('$5', isMySQL ? '?' : '$5')
                    ),
                    [
                        req.user.id,
                        certification_notes || null,
                        appId,
                        ...(prescreening_datetime ? [prescreening_datetime] : []),
                        ...(prescreening_location  ? [prescreening_location]  : [])
                    ]
                );

                const appResult = await query(
                    adaptQuery('SELECT a.candidate_id, j.title as job_title FROM applications a JOIN jobs j ON a.job_id = j.id WHERE a.id = $1'),
                    [appId]
                );
                const app = appResult.rows[0];

                // Certified → candidate stage advances to Certified.
                if (app?.candidate_id) syncCandidateStage(app.candidate_id).catch(() => {});

                let perCandidateNotification = { success: [], failed: [] };
                try {
                    if (prescreening_datetime && prescreening_location) {
                        perCandidateNotification = await notifications.sendPreScreeningNotification(
                            app.candidate_id, app.job_title, prescreening_datetime, prescreening_location, channels);
                    } else {
                        perCandidateNotification = await notifications.sendCertificationNotification(
                            app.candidate_id, app.job_title, certification_notes || '', channels);
                    }
                } catch (notifErr) {
                    logger.error(`Batch certify notification failed for ${appId}: ${notifErr.message}`);
                    perCandidateNotification.failed.push({ channel: 'all', error: notifErr.message });
                }

                results.success.push({
                    application_id: appId,
                    candidate_id: app?.candidate_id,
                    notification: perCandidateNotification,
                });
            } catch (err) {
                results.failed.push({ application_id: appId, error: err.message });
            }
        }

        res.json({
            processed: application_ids.length,
            success_count: results.success.length,
            failed_count: results.failed.length,
            results
        });
    } catch (error) { next(error); }
});

/**
 * AI-powered candidate matching for a job
 */
router.get('/match/:job_id', authenticate, async (req, res, next) => {
    try {
        const { job_id } = req.params;

        const jobResult = await query(adaptQuery('SELECT * FROM jobs WHERE id = $1'), [job_id]);
        if (jobResult.rows.length === 0) return res.status(404).json({ error: 'Job not found' });
        const job = jobResult.rows[0];

        const candidatesResult = await query(
            adaptQuery(`SELECT c.*, cv.parsed_data FROM candidates c
                        JOIN cv_files cv ON c.id = cv.candidate_id
                        WHERE cv.ocr_status = 'completed' AND c.status NOT IN ('hired','rejected')
                        AND cv.parsed_data IS NOT NULL
                        AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.candidate_id = c.id AND a.job_id = $1)`),
            [job_id]
        );

        const matches = [];
        for (const candidate of candidatesResult.rows) {
            try {
                const matchResult = await calculateMatchScore(candidate.parsed_data, job.requirements);
                if (matchResult.score >= 0.5) {
                    matches.push({
                        candidate_id: candidate.id, candidate_name: candidate.name,
                        candidate_phone: candidate.phone, match_score: matchResult.score,
                        reasons: matchResult.reasons, concerns: matchResult.concerns
                    });
                }
            } catch (e) { logger.warn(`Match score failed for candidate ${candidate.id}: ${e.message}`); }
        }

        matches.sort((a, b) => b.match_score - a.match_score);
        res.json(matches);
    } catch (error) { next(error); }
});

module.exports = router;
