const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const axios = require('axios');
const { randomUUID } = require('crypto');
const { query } = require('../config/database');
const { adaptQuery, isMySQL } = require('../utils/query-adapter');
const { authenticate, authorize } = require('../middleware/auth');
const { normalizePhone } = require('../utils/phone');
const logger = require('../utils/logger');
const chatbotOutbox = require('../services/chatbot-outbox');
const { buildJobPayload, buildProjectPayload } = require('../services/chatbot-payloads');
const { POSITIONS_FILLED_JOIN, POSITIONS_FILLED_SELECT } = require('../utils/job-queries');

// Some deployments don't include a ../models layer; keep this route DB-driven.
let Candidate;
let CVFile;
try {
    ({ Candidate, CVFile } = require('../models'));
} catch (err) {
    logger.warn('chatbot-sync: ../models unavailable, using query fallback for intake');
}

// Configure multer to save incoming CVs to a temporary or permanent folder
const upload = multer({ dest: 'uploads/cvs/' });

const CHATBOT_API_URL = process.env.CHATBOT_API_URL || 'http://localhost:8000';
const CHATBOT_API_KEY = process.env.CHATBOT_API_KEY || '';
    
function isPlaceholderCandidateName(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return true;
    return ['unknown', 'unknown candidate', 'candidate', 'pending ai extraction', 'n/a', 'na'].includes(normalized)
        || normalized.startsWith('whatsapp ');
}

function resolveCandidateSyncName(phone, name) {
    const explicitName = String(name || '').trim();
    if (explicitName && !isPlaceholderCandidateName(explicitName)) {
        return explicitName;
    }
    return String(phone || '').trim() || 'Pending AI Extraction';
}

async function _postToChatbot(endpoint, body) {
    if (!CHATBOT_API_KEY) {
        logger.warn('CHATBOT_API_KEY not set � skipping chatbot sync');
        return null;
    }
    return axios.post(`${CHATBOT_API_URL}${endpoint}`, body, {
        headers: { 'x-chatbot-api-key': CHATBOT_API_KEY },
        timeout: 10000,
    });
}

async function _loadJobWithProject(jobId) {
    // MySQL deployments don't get derived positions_filled (no LATERAL); the
    // legacy stored column is the fallback there. Postgres uses the shared
    // join so positions_filled and positions_remaining are always live.
    const sql = isMySQL
        ? `SELECT j.*, p.countries, p.benefits, p.salary_info,
                  p.start_date, p.interview_date, p.title as project_title
           FROM jobs j LEFT JOIN projects p ON j.project_id = p.id
           WHERE j.id = ? LIMIT 1`
        : `SELECT j.*, ${POSITIONS_FILLED_SELECT},
                  p.countries, p.benefits, p.salary_info,
                  p.start_date, p.interview_date, p.title as project_title
           FROM jobs j
           LEFT JOIN projects p ON j.project_id = p.id
           ${POSITIONS_FILLED_JOIN}
           WHERE j.id = $1 LIMIT 1`;
    const result = await query(sql, [jobId]);
    return (result.rows && result.rows[0]) || null;
}

/**
 * Re-enqueue a project upsert. Used by the jobs route when a job's project_id
 * changes — both the old and the new project rows in the chatbot KB need to
 * refresh so they no longer reference / now reference the moved job.
 */
async function syncProjectAsync(projectId) {
    if (!projectId) return;
    try {
        const sql = isMySQL
            ? 'SELECT * FROM projects WHERE id = ? LIMIT 1'
            : 'SELECT * FROM projects WHERE id = $1 LIMIT 1';
        const result = await query(sql, [projectId]);
        const row = result.rows && result.rows[0];
        if (!row) return;
        await chatbotOutbox.enqueue({
            doc_id: `project_${row.id}`,
            doc_type: 'project_desc',
            operation: 'upsert',
            payload: buildProjectPayload(row),
        });
    } catch (err) {
        logger.warn(`syncProjectAsync failed for ${projectId}: ${err.message}`);
    }
}

/**
 * Push a single job to the chatbot — historically a direct HTTP call, now goes
 * through the outbox so it survives chatbot restarts and gets retried on
 * failure. Signature preserved for back-compat with existing callers.
 */
async function syncJobToChatbot(job) {
    if (!job || !job.id) return;
    await chatbotOutbox.enqueue({
        doc_id: `job_${job.id}`,
        doc_type: 'job_desc',
        operation: 'upsert',
        payload: buildJobPayload(job),
    });
}

/**
 * Look up a job (with project context) and enqueue an upsert or delete based
 * on its status. This is the canonical hook every job mutation calls.
 */
async function syncJobAsync(jobId) {
    if (!jobId) return;
    const job = await _loadJobWithProject(jobId);
    if (!job) return;

    if (job.status && job.status !== 'active') {
        await chatbotOutbox.enqueue({
            doc_id: `job_${job.id}`,
            doc_type: 'job_desc',
            operation: 'delete',
            payload: { doc_id: `job_${job.id}` },
        });
        return;
    }
    await syncJobToChatbot(job);
}

async function syncJobDeleteAsync(jobId) {
    if (!jobId) return;
    await chatbotOutbox.enqueue({
        doc_id: `job_${jobId}`,
        doc_type: 'job_desc',
        operation: 'delete',
        payload: { doc_id: `job_${jobId}` },
    });
}

async function syncAllActiveJobs() {
    const stats = await chatbotOutbox.fullResync();
    return {
        total: stats.jobs + stats.projects + stats.faqs,
        synced: stats.jobs + stats.projects + stats.faqs,
        failed: 0,
        breakdown: stats,
    };
}

router.post('/refresh-jobs', authenticate, authorize('admin', 'sourcing_department'), async (req, res) => {
    try {
        const result = await syncAllActiveJobs();
        res.json({
            success: true,
            message: 'Active jobs synchronized with chatbot knowledge base',
            ...result,
        });
    } catch (error) {
        logger.error(`refresh-jobs endpoint error: ${error.message}`);
        res.status(500).json({ error: 'Failed to refresh chatbot knowledge base' });
    }
});

/**
 * POST /api/chatbot-sync/full-resync
 * Re-enqueue every active job, project, and FAQ. Used by the admin
 * "Resync chatbot" button after a CRM migration or chatbot redeploy.
 */
router.post('/full-resync', authenticate, authorize('admin', 'sourcing_department'), async (req, res) => {
    try {
        const stats = await chatbotOutbox.fullResync();
        res.json({
            success: true,
            message: 'Full resync enqueued — worker is draining now',
            ...stats,
        });
    } catch (error) {
        logger.error(`full-resync endpoint error: ${error.message}`);
        res.status(500).json({ error: 'Failed to enqueue full resync' });
    }
});

/**
 * GET /api/chatbot-sync/outbox-status
 * Aggregated counts of outbox rows by status — for admin monitoring.
 */
router.get('/outbox-status', authenticate, authorize('admin', 'sourcing_department'), async (req, res) => {
    try {
        const result = await query(
            `SELECT status, COUNT(*)::int AS count, MAX(updated_at) AS most_recent
             FROM chatbot_sync_outbox
             GROUP BY status`,
            []
        );
        res.json({ rows: result.rows || [] });
    } catch (error) {
        logger.error(`outbox-status error: ${error.message}`);
        res.status(500).json({ error: 'Failed to read outbox status' });
    }
});

router.post('/general-knowledge', authenticate, authorize('admin', 'sourcing_department'), async (req, res) => {
    try {
        const { key, category, data, description } = req.body;
        if (!key || !category || !data) {
            return res.status(400).json({ error: 'key, category, and data are required' });
        }
        const result = await _postToChatbot('/api/knowledge/general', {
            key,
            category,
            data,
            description: description || null,
        });
        res.json({ success: true, key, chatbot_response: result ? result.data : null });
    } catch (error) {
        logger.error(`general-knowledge sync error: ${error.message}`);
        res.status(500).json({ error: 'Failed to push general knowledge to chatbot' });
    }
});

router.post('/intake', upload.single('cv_file'), async (req, res) => {
    const traceId = req.headers['x-trace-id'] || 'no-trace';
    try {
        // The Python bot sends metadata as a JSON string in 'payload'
        const payload = JSON.parse(req.body.payload);
        const {
            name,
            experience_years,
            job_interest,
            job_role,
            country,
            skills,
            preferred_language,
            email,
            // Ad-attribution (FB/IG job-ad funnel). When present we resolve a
            // job_id and create an applications row tying this candidate to
            // the specific role they clicked on.
            ad_ref,
            ad_job_id,
            job_id: providedJobId,
        } = payload;

        const phone = normalizePhone(payload.phone);
        if (!phone) {
            return res.status(400).json({ error: 'Missing or invalid phone number' });
        }

        logger.info(`[${traceId}] Intake for phone: ${phone}`);

        const resolvedJobInterest = job_interest || job_role || 'General';
        const resolvedCandidateName = resolveCandidateSyncName(phone, name);

        // 1. Create or update candidate by phone
        let candidate;
        if (Candidate && typeof Candidate.upsert === 'function') {
            [candidate] = await Candidate.upsert({
                phone,
                name: resolvedCandidateName,
                experience_years: experience_years !== undefined && experience_years !== null ? experience_years : null,
                status: 'screening',
                job_interest: resolvedJobInterest,
                ...(country && { preferred_country: country }),
                ...(preferred_language && { preferred_language }),
                ...(email && { email }),
            });
        } else {
            const existing = await query(
                adaptQuery('SELECT id FROM candidates WHERE phone = $1 LIMIT 1'),
                [phone]
            );

            if (existing.rows.length > 0) {
                const candidateId = existing.rows[0].id;
                await query(
                    adaptQuery(`
                        UPDATE candidates
                        SET name = $1,
                            experience_years = $2,
                            status = 'screening',
                            job_interest = $3,
                            updated_at = NOW()
                        WHERE id = $4
                    `),
                    [
                        resolvedCandidateName,
                        experience_years !== undefined && experience_years !== null ? experience_years : null,
                        resolvedJobInterest,
                        candidateId,
                    ]
                );

                // Optional columns can differ by environment; update best-effort.
                try {
                    await query(
                        adaptQuery('UPDATE candidates SET preferred_country = $1 WHERE id = $2'),
                        [country || null, candidateId]
                    );
                } catch (_err) {}

                try {
                    await query(
                        adaptQuery('UPDATE candidates SET preferred_language = $1 WHERE id = $2'),
                        [preferred_language || null, candidateId]
                    );
                } catch (_err) {}

                try {
                    await query(
                        adaptQuery('UPDATE candidates SET email = $1 WHERE id = $2'),
                        [email || null, candidateId]
                    );
                } catch (_err) {}

                candidate = { id: candidateId };
            } else {
                const candidateId = randomUUID();
                await query(
                    adaptQuery(`
                        INSERT INTO candidates
                            (id, phone, name, experience_years, status, job_interest)
                        VALUES ($1, $2, $3, $4, 'screening', $5)
                    `),
                    [
                        candidateId,
                        phone,
                        resolvedCandidateName,
                        experience_years !== undefined && experience_years !== null ? experience_years : null,
                        resolvedJobInterest,
                    ]
                );

                try {
                    await query(
                        adaptQuery('UPDATE candidates SET preferred_country = $1, preferred_language = $2, email = $3 WHERE id = $4'),
                        [country || null, preferred_language || null, email || null, candidateId]
                    );
                } catch (_err) {}

                candidate = { id: candidateId };
            }
        }

        // 2. Store skills if provided
        if (Array.isArray(skills) && skills.length > 0 && candidate) {
            try {
                await query(
                    adaptQuery('UPDATE candidates SET skills = $1 WHERE id = $2'),
                    [isMySQL ? skills.slice(0, 20).join(', ') : skills.slice(0, 20), candidate.id]
                );
            } catch (_err) {
                // skills column may not exist yet � skip silently
            }
        }

        // 3. Attach the CV file if it exists
        if (req.file) {
            // Sanitise filename to prevent path-traversal attacks
            const safeOriginalName = path.basename(req.file.originalname || 'cv_upload');
            if (CVFile && typeof CVFile.create === 'function') {
                await CVFile.create({
                    candidate_id: candidate.id,
                    file_path: req.file.path,
                    original_name: safeOriginalName,
                    ocr_status: 'pending',
                });
            } else {
                await query(
                    adaptQuery(`
                        INSERT INTO cv_files
                            (id, candidate_id, file_url, file_name, file_type, ocr_status)
                        VALUES ($1, $2, $3, $4, $5, 'pending')
                    `),
                    [
                        randomUUID(),
                        candidate.id,
                        req.file.path,
                        safeOriginalName,
                        req.file.mimetype || 'application/octet-stream',
                    ]
                );
            }
        }

        // 4. Ad-funnel application: when the candidate arrived via a FB/IG
        // job ad, resolve the job_id (preferring an explicit one, falling
        // back to ad_tracking lookup, then UUID fallback) and INSERT into
        // applications so the candidate appears under that specific role in
        // the recruiter dashboard. Idempotent on (candidate_id, job_id).
        let applicationId = null;
        try {
            let resolvedJobId = providedJobId || ad_job_id || null;
            const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

            if (!resolvedJobId && ad_ref) {
                const adResult = await query(
                    adaptQuery('SELECT job_id FROM ad_tracking WHERE ad_ref = $1 AND is_active = TRUE LIMIT 1'),
                    [ad_ref]
                );
                if (adResult.rows.length > 0) {
                    resolvedJobId = adResult.rows[0].job_id;
                }
            }

            if (!resolvedJobId && ad_ref && UUID_RE.test(ad_ref)) {
                const uuidResult = await query(
                    adaptQuery(isMySQL
                        ? `SELECT id FROM jobs WHERE id = $1 AND status = 'active' LIMIT 1`
                        : `SELECT id FROM jobs WHERE id = $1::uuid AND status = 'active' LIMIT 1`),
                    [ad_ref]
                );
                if (uuidResult.rows.length > 0) {
                    resolvedJobId = uuidResult.rows[0].id;
                }
            }

            if (resolvedJobId && candidate && candidate.id) {
                const dupResult = await query(
                    adaptQuery('SELECT id FROM applications WHERE candidate_id = $1 AND job_id = $2 LIMIT 1'),
                    [candidate.id, resolvedJobId]
                );
                if (dupResult.rows.length > 0) {
                    applicationId = dupResult.rows[0].id;
                    logger.info(`[${traceId}] Application already exists: ${applicationId}`);
                } else {
                    applicationId = randomUUID();
                    await query(
                        adaptQuery(`
                            INSERT INTO applications (id, candidate_id, job_id, status, metadata)
                            VALUES ($1, $2, $3, 'applied', $4)
                        `),
                        [
                            applicationId,
                            candidate.id,
                            resolvedJobId,
                            JSON.stringify({
                                source: 'whatsapp_chatbot',
                                ad_ref: ad_ref || null,
                                destination_country: country || null,
                                job_interest_stated: resolvedJobInterest,
                            }),
                        ]
                    );
                    logger.info(`[${traceId}] Created application ${applicationId} for candidate ${candidate.id} → job ${resolvedJobId}`);
                }
            }
        } catch (appErr) {
            // Don't fail the whole sync if application creation hits a
            // schema issue — the candidate row already landed and recruiters
            // can still see them. Log loud so we notice.
            logger.error(`[${traceId}] Application creation failed (sync continues):`, appErr);
        }

        res.status(200).json({
            success: true,
            candidate_id: candidate.id,
            application_id: applicationId,
            fields_received: {
                name: !!name,
                experience_years: experience_years !== undefined && experience_years !== null,
                job_interest: !!resolvedJobInterest,
                country: !!country,
                skills_count: Array.isArray(skills) ? skills.length : 0,
                cv_attached: !!req.file,
                ad_ref: !!ad_ref,
                application_linked: !!applicationId,
            },
        });
    } catch (error) {
        logger.error('CRM Sync Error:', error);
        res.status(500).json({ error: 'Sync failed' });
    }
});

module.exports = router;
router.syncJobAsync = syncJobAsync;
router.syncJobDeleteAsync = syncJobDeleteAsync;
router.syncJobToChatbot = syncJobToChatbot;
router.syncAllActiveJobs = syncAllActiveJobs;
router.syncProjectAsync = syncProjectAsync;
