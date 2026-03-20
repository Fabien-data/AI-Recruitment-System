const express = require('express');
const router = express.Router();
const { query, withTransaction, generateUUID } = require('../config/database');
const { adaptQuery, isMySQL } = require('../utils/query-adapter');
const { authenticate } = require('../middleware/auth');
const { calculateMatchScore } = require('../config/openai');
const notifications = require('../services/notifications');
const logger = require('../utils/logger');

/**
 * Get all applications with filters
 * MySQL + PostgreSQL compatible
 */
router.get('/', authenticate, async (req, res, next) => {
    try {
        const { job_id, candidate_id, status, project_id } = req.query;
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

        const sql = `SELECT a.*, c.name as candidate_name, c.phone as candidate_phone,
                     c.email as candidate_email, j.title as job_title, j.category as job_category,
                     j.project_id, p.title as project_title, p.client_name as project_client
                     FROM applications a
                     JOIN candidates c ON a.candidate_id = c.id
                     JOIN jobs j ON a.job_id = j.id
                     LEFT JOIN projects p ON j.project_id = p.id
                     ${whereClause} ORDER BY a.applied_at DESC`;
        const result = await query(sql, params);
        res.json(result.rows);
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

        const appId = generateUUID();
        await query(
            adaptQuery("INSERT INTO applications (id, candidate_id, job_id, match_score, status) VALUES ($1, $2, $3, $4, 'applied')"),
            [appId, candidate_id, job_id, matchScore]
        );
        const inserted = await query(adaptQuery('SELECT * FROM applications WHERE id = $1'), [appId]);
        res.status(201).json(inserted.rows[0]);
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
router.put('/:id', authenticate, async (req, res, next) => {
    try {
        const { id } = req.params;
        const {
            status, rejection_reason, interview_datetime, interview_location,
            interview_notes, certification_notes, prescreening_datetime,
            prescreening_location, notify_channels = ['whatsapp']
        } = req.body;

        const setClauses = [];
        const values = [];
        const p = () => isMySQL ? '?' : `$${values.length + 1}`;

        if (status) {
            setClauses.push(`status = ${p()}`); values.push(status);
            if (status === 'certified') {
                setClauses.push('certified_at = NOW()');
                setClauses.push(`certified_by = ${p()}`); values.push(req.user.id);
            }
        }
        if (certification_notes)  { setClauses.push(`certification_notes = ${p()}`); values.push(certification_notes); }
        if (rejection_reason)     { setClauses.push(`rejection_reason = ${p()}`);    values.push(rejection_reason); }
        const effDt = prescreening_datetime || interview_datetime;
        if (effDt)  { setClauses.push(`interview_datetime = ${p()}`); values.push(effDt); }
        const effLoc = prescreening_location || interview_location;
        if (effLoc) { setClauses.push(`interview_location = ${p()}`); values.push(effLoc); }
        if (interview_notes) { setClauses.push(`interview_notes = ${p()}`); values.push(interview_notes); }

        if (setClauses.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

        values.push(id);
        await query(`UPDATE applications SET ${setClauses.join(', ')} WHERE id = ${isMySQL ? '?' : `$${values.length}`}`, values);

        const appResult = await query(adaptQuery('SELECT * FROM applications WHERE id = $1'), [id]);
        if (appResult.rows.length === 0) return res.status(404).json({ error: 'Application not found' });
        const application = appResult.rows[0];

        if (status) {
            const jobResult = await query(adaptQuery('SELECT title FROM jobs WHERE id = $1'), [application.job_id]);
            const jobTitle = jobResult.rows[0]?.title || 'the position';
            const channels = Array.isArray(notify_channels) ? notify_channels : ['whatsapp'];

            setImmediate(async () => {
                try {
                    switch (status) {
                        case 'certified':
                            if (prescreening_datetime && prescreening_location) {
                                await notifications.sendPreScreeningNotification(
                                    application.candidate_id, jobTitle, prescreening_datetime, prescreening_location, channels);
                            } else {
                                await notifications.sendCertificationNotification(
                                    application.candidate_id, jobTitle, certification_notes, channels);
                            }
                            break;
                        case 'interview_scheduled':
                            if (effDt && effLoc)
                                await notifications.sendInterviewNotification(application.candidate_id, jobTitle, effDt, effLoc, channels);
                            break;
                        case 'selected':
                            await notifications.sendSelectionNotification(application.candidate_id, jobTitle, channels);
                            break;
                        case 'rejected':
                            await notifications.sendRejectionNotification(application.candidate_id, jobTitle, channels);
                            break;
                    }
                } catch (notifError) {
                    logger.error(`Notification failed for application ${id}:`, notifError);
                }
            });
        }

        res.json({
            ...application,
            notification_queued: !!status && ['certified','interview_scheduled','selected','rejected'].includes(status)
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
        setImmediate(async () => {
            try {
                await notifications.sendGeneralPoolNotification(application.candidate_id, channels);
            } catch (e) { logger.error(`General pool notification failed: ${e.message}`); }
        });

        res.json({ success: true, message: 'Candidate moved to general pool',
                   application_id: id, candidate_id: application.candidate_id,
                   notification_queued: true, channels });
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

        // Notify candidate that their application has been moved
        const channels = Array.isArray(req.body.notify_channels) ? req.body.notify_channels : ['whatsapp'];
        setImmediate(async () => {
            try {
                await notifications.sendTransferNotification(
                    originalApp.candidate_id,
                    targetJobResult.rows[0].title,
                    /* oldJobTitle */ (await query(adaptQuery('SELECT title FROM jobs WHERE id = $1'), [originalApp.job_id])).rows[0]?.title || 'previous position',
                    channels
                );
            } catch (notifErr) {
                logger.error(`Transfer notification failed for application ${id}: ${notifErr.message}`);
            }
        });

        res.json(newApp.rows[0]);
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

                setImmediate(async () => {
                    try {
                        if (prescreening_datetime && prescreening_location) {
                            await notifications.sendPreScreeningNotification(
                                app.candidate_id, app.job_title, prescreening_datetime, prescreening_location, channels);
                        } else {
                            await notifications.sendCertificationNotification(
                                app.candidate_id, app.job_title, certification_notes || '', channels);
                        }
                    } catch (notifErr) {
                        logger.error(`Batch certify notification failed for ${appId}: ${notifErr.message}`);
                    }
                });

                results.success.push({ application_id: appId, candidate_id: app?.candidate_id });
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
