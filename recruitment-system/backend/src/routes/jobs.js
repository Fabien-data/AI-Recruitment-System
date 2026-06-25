const express = require('express');
const router = express.Router();
const multer = require('multer');
const { pool } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { requireSection } = require('../middleware/sections');
const { syncJobAsync, syncJobDeleteAsync, syncProjectAsync } = require('./chatbot-sync');
const { processJobFlyer, extractJobFlyer } = require('../services/auto-ingest');
const { POSITIONS_FILLED_JOIN, POSITIONS_FILLED_SELECT, CERTIFIED_JOIN, CERTIFIED_SELECT, JOB_COUNTS_JOIN, JOB_COUNTS_SELECT } = require('../utils/job-queries');
const { resolveCountry } = require('../utils/countries');
const { notifyWaitlistForJob } = require('../services/job-waitlist');
const logger = require('../utils/logger');

const MAX_FLYERS_PER_BATCH = 20;

const VALID_STATUSES = new Set(['active', 'inactive', 'complete', 'future', 'pending_review']);
const VALID_URGENCY = new Set(['top_urgent', 'urgent', 'situational', 'normal']);
const VALID_DOMAINS = new Set(['middle_east', 'europe']);
const VALID_SORTS = new Set(['recent', 'project', 'title', 'deadline', 'urgency']);

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024 },
});

function getFlyerFiles(req) {
    if (Array.isArray(req.files) && req.files.length > 0) {
        return req.files;
    }
    if (req.file) {
        return [req.file];
    }
    return [];
}

function parseCsvParam(value, allowedSet) {
    if (!value) return [];
    return String(value)
        .split(',')
        .map(s => s.trim())
        .filter(s => s && (!allowedSet || allowedSet.has(s)));
}

function deriveIsUrgent(urgency_level) {
    return urgency_level === 'urgent' || urgency_level === 'top_urgent';
}

// ─────────────────────────────────────────────────────────────────────────────
// AI ingestion endpoints
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/jobs/extract — review-first AI ingestion.
 * Parses each uploaded flyer with OpenAI vision (+ Vision OCR fallback) and
 * returns the extracted JSON WITHOUT writing anything to the database. The
 * frontend opens a per-file review modal so the agent can fill missing
 * required fields (country, domain, salary, location, project) and chooses
 * an existing project or creates a new one before saving via POST /api/jobs.
 */
async function handleExtractFlyers(req, res, next) {
    try {
        const files = getFlyerFiles(req);
        if (files.length === 0) {
            return res.status(400).json({ error: 'No flyer image uploaded' });
        }
        const invalidFile = files.find((file) => !file.mimetype || !file.mimetype.startsWith('image/'));
        if (invalidFile) {
            return res.status(400).json({ error: 'Flyer must be an image file' });
        }

        const results = [];
        const failures = [];
        for (const file of files) {
            try {
                const extraction = await extractJobFlyer(file.buffer, file.mimetype);
                results.push({ fileName: file.originalname, extraction });
            } catch (error) {
                failures.push({ fileName: file.originalname, error: error.message });
                logger.error(`Extract failed for ${file.originalname}: ${error.message}`);
            }
        }

        if (results.length === 0) {
            return res.status(500).json({ error: 'Failed to extract from flyer batch', failures });
        }

        res.status(200).json({
            totalFiles: files.length,
            succeeded: results.length,
            failed: failures.length,
            files: results,
            failures,
        });
    } catch (error) {
        logger.error(`Extract endpoint failed: ${error.message}`);
        next(error);
    }
}

/**
 * Legacy auto-save handler retained for back-compat with any external
 * integration still calling /magic-create. Logs a deprecation warning.
 */
async function handleMagicCreate(req, res, next) {
    logger.warn('POST /api/jobs/magic-create is deprecated — use /api/jobs/extract + POST /api/jobs');
    try {
        const files = getFlyerFiles(req);

        if (files.length === 0) {
            return res.status(400).json({ error: 'No flyer image uploaded' });
        }

        const invalidFile = files.find((file) => !file.mimetype || !file.mimetype.startsWith('image/'));
        if (invalidFile) {
            return res.status(400).json({ error: 'Flyer must be an image file' });
        }

        const results = [];
        const failures = [];

        for (const file of files) {
            try {
                const result = await processJobFlyer(file.buffer, file.mimetype);
                results.push({
                    fileName: file.originalname,
                    ...result,
                });
            } catch (error) {
                failures.push({
                    fileName: file.originalname,
                    error: error.message,
                });
                logger.error(`Magic create failed for ${file.originalname}: ${error.message}`);
            }
        }

        if (results.length === 0) {
            return res.status(500).json({
                error: 'Failed to process flyer batch',
                failures,
            });
        }

        res.status(201).json({
            message: files.length === 1
                ? 'Flyer processed successfully'
                : `Processed ${results.length} of ${files.length} flyers successfully`,
            totalFiles: files.length,
            succeeded: results.length,
            failed: failures.length,
            results,
            failures,
        });
    } catch (error) {
        logger.error(`Magic create failed: ${error.message}`);
        next(error);
    }
}

router.post('/extract',      authenticate, requireSection('jobs', 'create'), authorize('admin', 'sourcing_department'), upload.array('flyer', MAX_FLYERS_PER_BATCH), handleExtractFlyers);
router.post('/magic-create', authenticate, requireSection('jobs', 'create'), authorize('admin', 'sourcing_department'), upload.array('flyer', MAX_FLYERS_PER_BATCH), handleMagicCreate);
router.post('/auto-ingest',  authenticate, requireSection('jobs', 'create'), authorize('admin', 'sourcing_department'), upload.array('flyer', MAX_FLYERS_PER_BATCH), handleMagicCreate);


// ─────────────────────────────────────────────────────────────────────────────
// Read endpoints
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/jobs
 *
 * Filters: status (csv), urgency_level (csv), country, country_code, domain,
 *          category, project_id, q (free-text), include_pending_review (admin).
 * Sort:    recent | project | title | deadline | urgency.
 * Paging:  page, limit (default 50, max 200).
 *
 * positions_filled / positions_remaining are derived from applications, not
 * read from the stored column (which is no longer written).
 */
router.get('/', authenticate, requireSection('jobs', 'view'), async (req, res, next) => {
    try {
        const {
            category,
            project_id,
            country,
            country_code,
            domain,
            q,
            sort = 'recent',
            include_pending_review,
        } = req.query;

        const statuses = parseCsvParam(req.query.status ?? 'active', VALID_STATUSES);
        const urgencies = parseCsvParam(req.query.urgency_level, VALID_URGENCY);

        // pending_review is admin-only by default; recruiters never see it
        // unless they pass include_pending_review=true AND have the role.
        const isAdmin = req.user && (req.user.role === 'admin' || req.user.role === 'sourcing_department');
        if (!isAdmin || !['true', '1', 'yes'].includes(String(include_pending_review).toLowerCase())) {
            const idx = statuses.indexOf('pending_review');
            if (idx >= 0) statuses.splice(idx, 1);
        }

        const params = [];
        const where = ['1=1'];

        if (statuses.length > 0) {
            const placeholders = statuses.map((_, i) => `$${params.length + i + 1}`).join(',');
            where.push(`j.status IN (${placeholders})`);
            params.push(...statuses);
        }
        if (category) {
            // Substring, case-insensitive match: stored categories are mixed-case
            // (e.g. 'Security Officer') and recruiters type partial text ("secur"),
            // so an exact `=` comparison silently returned nothing (B006). ILIKE
            // with wildcards matches any job whose category contains the query.
            params.push(`%${String(category).trim()}%`);
            where.push(`j.category ILIKE $${params.length}`);
        }
        if (project_id) {
            params.push(project_id);
            where.push(`j.project_id = $${params.length}`);
        }
        if (urgencies.length > 0) {
            const placeholders = urgencies.map((_, i) => `$${params.length + i + 1}`).join(',');
            where.push(`j.urgency_level IN (${placeholders})`);
            params.push(...urgencies);
        }
        if (country) {
            params.push(country);
            where.push(`j.country = $${params.length}`);
        }
        if (country_code) {
            params.push(String(country_code).toUpperCase());
            where.push(`j.country_code = $${params.length}`);
        }
        if (domain && VALID_DOMAINS.has(domain)) {
            params.push(domain);
            where.push(`j.domain = $${params.length}`);
        }
        if (q) {
            params.push(`%${q}%`);
            const idx = params.length;
            where.push(`(j.title ILIKE $${idx} OR j.category ILIKE $${idx} OR p.title ILIKE $${idx} OR j.location ILIKE $${idx})`);
        }

        const sortKey = VALID_SORTS.has(sort) ? sort : 'recent';
        const orderBy = {
            recent:   'j.created_at DESC',
            project:  'p.title ASC NULLS LAST, j.title ASC',
            title:    'j.title ASC',
            deadline: 'j.deadline ASC NULLS LAST, j.created_at DESC',
            urgency:  `CASE j.urgency_level WHEN 'top_urgent' THEN 0 WHEN 'urgent' THEN 1 WHEN 'situational' THEN 2 ELSE 3 END, j.created_at DESC`,
        }[sortKey];

        const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
        const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
        const offset = (page - 1) * limit;
        params.push(limit, offset);

        const sql = `
            SELECT j.*, ${POSITIONS_FILLED_SELECT}, ${CERTIFIED_SELECT}, ${JOB_COUNTS_SELECT},
                   p.title AS project_title, p.client_name AS project_client
            FROM jobs j
            LEFT JOIN projects p ON j.project_id = p.id
            ${POSITIONS_FILLED_JOIN}
            ${CERTIFIED_JOIN}
            ${JOB_COUNTS_JOIN}
            WHERE ${where.join(' AND ')}
            ORDER BY ${orderBy}
            LIMIT $${params.length - 1} OFFSET $${params.length}
        `;
        const result = await pool.query(sql, params);

        res.json({ data: result.rows, page, limit });
    } catch (error) {
        next(error);
    }
});

router.get('/:id', authenticate, requireSection('jobs', 'view'), async (req, res, next) => {
    try {
        const { id } = req.params;

        const result = await pool.query(
            `SELECT j.*, ${POSITIONS_FILLED_SELECT}, ${CERTIFIED_SELECT}, ${JOB_COUNTS_SELECT},
                    p.title AS project_title, p.client_name AS project_client
             FROM jobs j
             LEFT JOIN projects p ON j.project_id = p.id
             ${POSITIONS_FILLED_JOIN}
             ${CERTIFIED_JOIN}
             ${JOB_COUNTS_JOIN}
             WHERE j.id = $1`,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Job not found' });
        }

        const countResult = await pool.query(
            'SELECT COUNT(*) FROM applications WHERE job_id = $1',
            [id]
        );

        const job = result.rows[0];
        job.application_count = parseInt(countResult.rows[0].count);
        res.json(job);
    } catch (error) {
        next(error);
    }
});


// ─────────────────────────────────────────────────────────────────────────────
// Write endpoints
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/jobs — create a new job.
 *
 * Accepts the full new schema: urgency_level, country, country_code, domain,
 * plus status (default 'active'). is_urgent is auto-derived from urgency_level
 * for back-compat with the chatbot's Pinecone metadata. The manual
 * positions_filled override is no longer accepted — counts are derived.
 */
router.post('/', authenticate, requireSection('jobs', 'create'), authorize('admin', 'sourcing_department', 'project_handler'), async (req, res, next) => {
    try {
        const {
            title,
            category,
            description,
            requirements,
            wiggle_room,
            positions_available,
            salary_range,
            location,
            deadline,
            project_id,
            required_fields_schema,
        } = req.body;

        // Status: default 'active' for manual create. Only allow values from the
        // user-facing set + pending_review (for the AI review-queue Save action).
        const requestedStatus = String(req.body.status || 'active').toLowerCase();
        const status = VALID_STATUSES.has(requestedStatus) ? requestedStatus : 'active';

        // Inline / future roles are lightweight placeholders created from the
        // Messages assign/transfer picker (or a "future project"): only a title +
        // project are required — category/requirements default so it's still a
        // real, assignable job (Kanban/shortlist/counts key off project_id/job_id).
        const isInline = req.body.inline === true || status === 'future';
        const effCategory = category || (isInline ? 'General' : null);
        const effRequirements = requirements || (isInline ? {} : null);

        if (!title || !effCategory || !effRequirements) {
            return res.status(400).json({ error: 'Title, category, and requirements are required' });
        }
        if (!project_id) {
            return res.status(400).json({ error: 'Project ID is required. Jobs must belong to a project.' });
        }

        const projectResult = await pool.query('SELECT id, title FROM projects WHERE id = $1', [project_id]);
        if (projectResult.rows.length === 0) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Urgency: validated and used to derive is_urgent (deprecated column).
        const urgency_level = VALID_URGENCY.has(req.body.urgency_level) ? req.body.urgency_level : 'normal';
        const is_urgent = deriveIsUrgent(urgency_level);

        // Country + domain: normalize via ISO list; domain auto-suggested when
        // missing and the country has a confident default.
        const geo = resolveCountry({
            name: req.body.country,
            code: req.body.country_code,
            domain: req.body.domain,
        });

        const result = await pool.query(
            `INSERT INTO jobs (
                title, category, description, requirements, wiggle_room,
                positions_available, salary_range, location, deadline, project_id,
                created_by, status, urgency_level, is_urgent,
                country, country_code, domain, required_fields_schema
             ) VALUES (
                $1, $2, $3, $4::jsonb, $5::jsonb,
                $6, $7, $8, $9, $10,
                $11, $12, $13, $14,
                $15, $16, $17, $18::jsonb
             ) RETURNING *`,
            [
                title,
                effCategory,
                description,
                JSON.stringify(effRequirements),
                JSON.stringify(wiggle_room || {}),
                positions_available || 1,
                salary_range,
                location,
                deadline,
                project_id,
                req.user.id,
                status,
                urgency_level,
                is_urgent,
                geo.country,
                geo.country_code,
                geo.domain,
                JSON.stringify(required_fields_schema || {}),
            ]
        );

        const newJob = result.rows[0];
        try {
            await syncJobAsync(newJob.id);
        } catch (syncErr) {
            logger.warn(`Job created but chatbot sync failed for job ${newJob.id}: ${syncErr.message}`);
        }
        // Re-sync the project so its KB doc reflects the new job belonging to it.
        try {
            await syncProjectAsync(project_id);
        } catch (syncErr) {
            logger.warn(`Project resync failed for ${project_id}: ${syncErr.message}`);
        }
        // Re-engage waiting-list candidates who wanted this role (fire-and-forget
        // so the create response isn't blocked by outbound messaging).
        if (String(newJob.status).toLowerCase() === 'active') {
            notifyWaitlistForJob(newJob).catch((e) =>
                logger.warn(`job-waitlist notify failed for new job ${newJob.id}: ${e.message}`));
        }
        res.status(201).json(newJob);
    } catch (error) {
        next(error);
    }
});

/**
 * PUT /api/jobs/:id — update job fields.
 *
 * Drops manual positions_filled (now derived). Adds the new schema fields.
 * If project_id changes, both the old and the new project are re-enqueued
 * to the chatbot KB so neither stale-references the moved job.
 */
router.put('/:id', authenticate, requireSection('jobs', 'edit'), authorize('admin', 'sourcing_department', 'project_handler'), async (req, res, next) => {
    try {
        const { id } = req.params;
        const updates = req.body;

        // Look up old project_id + status before update so we can detect a move
        // and a transition into 'active' (for the re-engagement waitlist).
        const beforeRes = await pool.query('SELECT project_id, status FROM jobs WHERE id = $1', [id]);
        if (beforeRes.rows.length === 0) {
            return res.status(404).json({ error: 'Job not found' });
        }
        const oldProjectId = beforeRes.rows[0].project_id;
        const oldStatus = String(beforeRes.rows[0].status || '').toLowerCase();

        const allowedFields = [
            'title', 'category', 'description', 'requirements',
            'wiggle_room', 'status', 'positions_available',
            'salary_range', 'location', 'deadline', 'project_id',
            'urgency_level', 'country', 'country_code', 'domain',
            'required_fields_schema',
        ];

        // Validate constrained fields
        if (updates.status != null && !VALID_STATUSES.has(updates.status)) {
            return res.status(400).json({ error: `Invalid status. Allowed: ${[...VALID_STATUSES].join(', ')}` });
        }
        if (updates.urgency_level != null && !VALID_URGENCY.has(updates.urgency_level)) {
            return res.status(400).json({ error: `Invalid urgency_level. Allowed: ${[...VALID_URGENCY].join(', ')}` });
        }
        if (updates.domain != null && updates.domain !== '' && !VALID_DOMAINS.has(updates.domain)) {
            return res.status(400).json({ error: `Invalid domain. Allowed: ${[...VALID_DOMAINS].join(', ')}` });
        }

        // If urgency_level provided, auto-derive is_urgent as a hidden update.
        if (updates.urgency_level != null) {
            updates.is_urgent = deriveIsUrgent(updates.urgency_level);
        }

        // If country/code provided, normalize through ISO list and derive
        // domain when one wasn't explicitly given.
        if (updates.country != null || updates.country_code != null) {
            const geo = resolveCountry({
                name: updates.country,
                code: updates.country_code,
                domain: updates.domain,
            });
            updates.country = geo.country;
            updates.country_code = geo.country_code;
            if (updates.domain == null) updates.domain = geo.domain;
        }

        const setClause = [];
        const values = [];
        let paramCount = 1;

        Object.keys(updates).forEach(key => {
            if (key === 'is_urgent') {
                setClause.push(`is_urgent = $${paramCount}`);
                values.push(Boolean(updates.is_urgent));
                paramCount++;
                return;
            }
            if (!allowedFields.includes(key)) return;
            if (key === 'requirements' || key === 'wiggle_room' || key === 'required_fields_schema') {
                setClause.push(`${key} = $${paramCount}::jsonb`);
                values.push(JSON.stringify(updates[key] || {}));
            } else {
                setClause.push(`${key} = $${paramCount}`);
                values.push(updates[key]);
            }
            paramCount++;
        });

        if (setClause.length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }

        setClause.push(`updated_at = NOW()`);
        values.push(id);

        const query = `UPDATE jobs SET ${setClause.join(', ')} WHERE id = $${paramCount} RETURNING *`;
        const result = await pool.query(query, values);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Job not found' });
        }

        const updated = result.rows[0];

        try {
            await syncJobAsync(updated.id);
        } catch (syncErr) {
            logger.warn(`Job updated but chatbot sync failed for job ${updated.id}: ${syncErr.message}`);
        }

        // Job just became active (e.g. future/inactive → active): re-engage
        // waiting-list candidates who wanted this role. Fire-and-forget.
        if (String(updated.status).toLowerCase() === 'active' && oldStatus !== 'active') {
            notifyWaitlistForJob(updated).catch((e) =>
                logger.warn(`job-waitlist notify failed for job ${updated.id}: ${e.message}`));
        }

        // If the job moved between projects, re-sync both. Otherwise just one.
        const newProjectId = updated.project_id;
        const projectsToResync = newProjectId === oldProjectId
            ? [newProjectId].filter(Boolean)
            : [oldProjectId, newProjectId].filter(Boolean);
        for (const projId of projectsToResync) {
            try {
                await syncProjectAsync(projId);
            } catch (syncErr) {
                logger.warn(`Project resync failed for ${projId}: ${syncErr.message}`);
            }
        }

        res.json(updated);
    } catch (error) {
        next(error);
    }
});

router.delete('/:id', authenticate, requireSection('jobs', 'delete'), authorize('admin'), async (req, res, next) => {
    try {
        const { id } = req.params;

        const beforeRes = await pool.query('SELECT project_id FROM jobs WHERE id = $1', [id]);
        const projectId = beforeRes.rows[0]?.project_id;

        const result = await pool.query(
            'DELETE FROM jobs WHERE id = $1 RETURNING *',
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Job not found' });
        }

        try {
            await syncJobDeleteAsync(id);
        } catch (syncErr) {
            logger.warn(`Job ${id} deleted but outbox enqueue failed: ${syncErr.message}`);
        }
        if (projectId) {
            try {
                await syncProjectAsync(projectId);
            } catch (syncErr) {
                logger.warn(`Project resync failed for ${projectId} after job delete: ${syncErr.message}`);
            }
        }
        res.json({ message: 'Job deleted successfully' });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
