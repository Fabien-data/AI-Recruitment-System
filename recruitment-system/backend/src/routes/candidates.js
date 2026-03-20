const express = require('express');
const router = express.Router();
const { query, generateUUID } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { adaptQuery, isMySQL } = require('../utils/query-adapter');
const axios = require('axios');
const logger = require('../utils/logger');
const { resolveCvAccessUrl } = require('../utils/cv-url');

/**
 * Get all candidates with filters and pagination
 * Compatible with both MySQL and PostgreSQL
 */
router.get('/', authenticate, async (req, res, next) => {
    try {
        const {
            page = 1,
            limit = 20,
            status,
            source,
            search,
            language
        } = req.query;

        const offset = (page - 1) * limit;

        const params = [];
        let whereClause = ' WHERE 1=1';

        if (status) {
            whereClause += isMySQL ? ' AND status = ?' : ` AND status = $${params.length + 1}`;
            params.push(status);
        }

        if (source) {
            whereClause += isMySQL ? ' AND source = ?' : ` AND source = $${params.length + 1}`;
            params.push(source);
        }

        if (language) {
            // singlish/tanglish are stored as si/ta in the DB; normalise before filtering
            const LANG_NORM = { singlish: 'si', tanglish: 'ta' };
            const normLang = LANG_NORM[language] || language;
            whereClause += isMySQL ? ' AND preferred_language = ?' : ` AND preferred_language = $${params.length + 1}`;
            params.push(normLang);
        }

        if (search) {
            if (isMySQL) {
                whereClause += ' AND (name LIKE ? OR phone LIKE ? OR email LIKE ?)';
                params.push(`%${search}%`, `%${search}%`, `%${search}%`);
            } else {
                whereClause += ` AND (name ILIKE $${params.length + 1} OR phone ILIKE $${params.length + 1} OR email ILIKE $${params.length + 1})`;
                params.push(`%${search}%`);
            }
        }

        // Count query
        const countQuery = `SELECT COUNT(*) as count FROM candidates${whereClause}`;
        const countResult = await query(countQuery, [...params]);
        const total = isMySQL ? countResult.rows[0].count : parseInt(countResult.rows[0].count);

        // List query with pagination
        let listQuery;
        let listParams;
        if (isMySQL) {
            listQuery = `SELECT * FROM candidates${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
            listParams = [...params, parseInt(limit), parseInt(offset)];
        } else {
            listQuery = `SELECT * FROM candidates${whereClause} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
            listParams = [...params, limit, offset];
        }

        const result = await query(listQuery, listParams);

        res.json({
            data: result.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: total,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        next(error);
    }
});

/**
 * Get candidate by ID with full details
 */
router.get('/:id', authenticate, async (req, res, next) => {
    try {
        const { id } = req.params;
        const placeholder = isMySQL ? '?' : '$1';

        // Get candidate
        const candidateResult = await query(
            `SELECT * FROM candidates WHERE id = ${placeholder}`,
            [id]
        );

        if (candidateResult.rows.length === 0) {
            return res.status(404).json({ error: 'Candidate not found' });
        }

        let candidate = candidateResult.rows[0];

        // Extract age / height / language_register from JSONB metadata so the frontend doesn't need to dig  
        let metadata = {};
        try {
            metadata = candidate.metadata
                ? (typeof candidate.metadata === 'string' ? JSON.parse(candidate.metadata) : candidate.metadata)
                : {};
        } catch (_) {}
        candidate = {
            ...candidate,
            age: metadata.age ?? null,
            height_cm: metadata.height_cm ?? null,
            // Expose the precise language register (singlish/tanglish/si/ta/en)
            language_register: metadata.language_register ?? candidate.preferred_language ?? null,
        };

        // Get CVs
        const cvsResult = await query(
            `SELECT * FROM cv_files WHERE candidate_id = ${placeholder} ORDER BY uploaded_at DESC`,
            [id]
        );

        // Get applications (include project info for Projects tab)
        const applicationsResult = await query(
            isMySQL
                ? `SELECT a.*, j.title as job_title, j.category as job_category,
                          p.id as project_id, p.title as project_title
                   FROM applications a
                   JOIN jobs j ON a.job_id = j.id
                   LEFT JOIN projects p ON j.project_id = p.id
                   WHERE a.candidate_id = ?
                   ORDER BY a.applied_at DESC`
                : `SELECT a.*, j.title as job_title, j.category as job_category,
                          p.id as project_id, p.title as project_title
                   FROM applications a
                   JOIN jobs j ON a.job_id = j.id
                   LEFT JOIN projects p ON j.project_id = p.id
                   WHERE a.candidate_id = $1
                   ORDER BY a.applied_at DESC`,
            [id]
        );

        // Get communications
        const communicationsResult = await query(
            `SELECT * FROM communications
             WHERE candidate_id = ${placeholder}
             ORDER BY sent_at DESC
             LIMIT 50`,
            [id]
        );

        const enrichedCvs = (cvsResult.rows || []).map((cv) => {
            const resolved = resolveCvAccessUrl(cv);
            const parsedData = cv?.parsed_data && typeof cv.parsed_data === 'string'
                ? (() => {
                    try { return JSON.parse(cv.parsed_data); } catch (_) { return null; }
                })()
                : cv?.parsed_data;

            const documentCategory = parsedData?.__document_category === 'additional'
                ? 'additional'
                : 'cv';

            return {
                ...cv,
                document_category: documentCategory,
                resolved_file_url: resolved.url,
                cv_retrieval_status: resolved.status,
                cv_url_source: resolved.source,
            };
        });

        res.json({
            ...candidate,
            cvs: enrichedCvs,
            applications: applicationsResult.rows,
            communications: communicationsResult.rows
        });
    } catch (error) {
        next(error);
    }
});

/**
 * Create new candidate manually
 */
router.post('/', authenticate, async (req, res, next) => {
    try {
        const {
            name,
            phone,
            email,
            source = 'manual',
            preferred_language = 'en',
            notes
        } = req.body;

        if (!name || !phone) {
            return res.status(400).json({ error: 'Name and phone are required' });
        }

        if (isMySQL) {
            // MySQL: Insert then select
            const id = generateUUID();
            await query(
                `INSERT INTO candidates (id, name, phone, email, source, preferred_language, notes, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'new')`,
                [id, name, phone, email, source, preferred_language, notes]
            );

            const result = await query('SELECT * FROM candidates WHERE id = ?', [id]);
            res.status(201).json(result.rows[0]);
        } else {
            // PostgreSQL: Use RETURNING
            const result = await query(
                `INSERT INTO candidates (name, phone, email, source, preferred_language, notes, status)
                 VALUES ($1, $2, $3, $4, $5, $6, 'new')
                 RETURNING *`,
                [name, phone, email, source, preferred_language, notes]
            );
            res.status(201).json(result.rows[0]);
        }
    } catch (error) {
        if (error.message.includes('duplicate') || error.message.includes('Duplicate')) {
            return res.status(400).json({ error: 'Candidate with this phone or email already exists' });
        }
        next(error);
    }
});

/**
 * Update candidate
 */
router.put('/:id', authenticate, async (req, res, next) => {
    try {
        const { id } = req.params;
        const updates = req.body;

        const allowedFields = ['name', 'email', 'status', 'preferred_language', 'notes', 'tags', 'skills', 'experience_years', 'highest_qualification'];
        const setClause = [];
        const values = [];

        Object.keys(updates).forEach(key => {
            if (allowedFields.includes(key)) {
                if (isMySQL) {
                    setClause.push(`${key} = ?`);
                } else {
                    setClause.push(`${key} = $${values.length + 1}`);
                }
                // Handle JSON fields for MySQL
                if (key === 'tags' && isMySQL && Array.isArray(updates[key])) {
                    values.push(JSON.stringify(updates[key]));
                } else {
                    values.push(updates[key]);
                }
            }
        });

        if (setClause.length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }

        values.push(id);

        if (isMySQL) {
            // MySQL: Update then select
            const updateQuery = `UPDATE candidates SET ${setClause.join(', ')}, updated_at = NOW() WHERE id = ?`;
            const updateResult = await query(updateQuery, values);

            if (updateResult.rowCount === 0) {
                return res.status(404).json({ error: 'Candidate not found' });
            }

            const result = await query('SELECT * FROM candidates WHERE id = ?', [id]);
            const updatedCandidate = result.rows[0];
            res.json(updatedCandidate);

            // Notify chatbot of status change (async, non-blocking)
            if (updates.status) {
                _notifyChatbotStatusChange(updatedCandidate, updates.status);
            }
        } else {
            // PostgreSQL: Use RETURNING
            const updateQuery = `UPDATE candidates SET ${setClause.join(', ')}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`;
            const result = await query(updateQuery, values);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Candidate not found' });
            }

            const updatedCandidate = result.rows[0];
            res.json(updatedCandidate);

            // Notify chatbot of status change (async, non-blocking)
            if (updates.status) {
                _notifyChatbotStatusChange(updatedCandidate, updates.status);
            }
        }
    } catch (error) {
        next(error);
    }
});

/**
 * Delete candidate
 */
router.delete('/:id', authenticate, authorize('admin'), async (req, res, next) => {
    try {
        const { id } = req.params;
        const placeholder = isMySQL ? '?' : '$1';

        if (isMySQL) {
            // Check if exists first
            const checkResult = await query(`SELECT id FROM candidates WHERE id = ?`, [id]);
            if (checkResult.rows.length === 0) {
                return res.status(404).json({ error: 'Candidate not found' });
            }
            await query(`DELETE FROM candidates WHERE id = ?`, [id]);
        } else {
            const result = await query(
                `DELETE FROM candidates WHERE id = ${placeholder} RETURNING *`,
                [id]
            );
            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Candidate not found' });
            }
        }

        res.json({ message: 'Candidate deleted successfully' });
    } catch (error) {
        next(error);
    }
});

// ── Duplicate detection routes ─────────────────────────────────────────────────

/**
 * GET /api/candidates/duplicates
 * Returns potential duplicate pairs with confidence scores.
 */
router.get('/duplicates', authenticate, async (req, res, next) => {
    try {
        const { min_confidence = 0.5, limit = 100 } = req.query;
        const { findDuplicates } = require('../services/duplicate-detection');
        const pairs = await findDuplicates(parseFloat(min_confidence), parseInt(limit, 10));
        res.json(pairs);
    } catch (err) { next(err); }
});

/**
 * POST /api/candidates/merge
 * Merges merge_id into keep_id — migrates all data, soft-deletes the duplicate.
 */
router.post('/merge', authenticate, authorize('admin', 'supervisor'), async (req, res, next) => {
    try {
        const { keep_id, merge_id } = req.body;
        if (!keep_id || !merge_id) {
            return res.status(400).json({ error: 'keep_id and merge_id are required' });
        }
        if (keep_id === merge_id) {
            return res.status(400).json({ error: 'keep_id and merge_id must be different' });
        }
        const { mergeCandidates } = require('../services/duplicate-detection');
        const result = await mergeCandidates(keep_id, merge_id, req.user.id);
        res.json(result);
    } catch (err) { next(err); }
});

// ── Chatbot status notification helper ──────────────────────────────────────
// Fires and forgets — does not block the API response.
const STATUS_NOTIFY_MAP = ['shortlisted', 'interview_scheduled', 'hired', 'rejected_with_alternatives'];

async function _notifyChatbotStatusChange(candidate, newStatus) {
    if (!STATUS_NOTIFY_MAP.includes(newStatus)) return;

    const chatbotUrl = process.env.CHATBOT_API_URL || 'http://localhost:8000';
    const apiKey = process.env.CHATBOT_API_KEY;
    if (!apiKey) {
        logger.warn('Cannot notify chatbot of status change — CHATBOT_API_KEY not set');
        return;
    }

    const phone = candidate.whatsapp_phone || candidate.phone;
    if (!phone) {
        logger.warn(`Cannot notify chatbot — candidate ${candidate.id} has no phone`);
        return;
    }

    // Resolve job title from most recent application
    let jobTitle = 'your applied position';
    let interviewDate = null;
    let interviewLocation = null;
    let alternativeJobs = null;

    try {
        const appSQL = isMySQL
            ? `SELECT j.title, a.metadata FROM applications a
               LEFT JOIN jobs j ON a.job_id = j.id
               WHERE a.candidate_id = ? ORDER BY a.applied_at DESC LIMIT 1`
            : `SELECT j.title, a.metadata FROM applications a
               LEFT JOIN jobs j ON a.job_id = j.id
               WHERE a.candidate_id = $1 ORDER BY a.applied_at DESC LIMIT 1`;
        const appResult = await query(appSQL, [candidate.id]);
        if (appResult.rows.length > 0) {
            jobTitle = appResult.rows[0].title || jobTitle;
            const meta = appResult.rows[0].metadata;
            if (meta) {
                const parsed = typeof meta === 'string' ? JSON.parse(meta) : meta;
                interviewDate = parsed.interview_date || null;
                interviewLocation = parsed.interview_location || null;
            }
        }

        // For rejected_with_alternatives, find other active jobs
        if (newStatus === 'rejected_with_alternatives') {
            const altSQL = isMySQL
                ? `SELECT title FROM jobs WHERE status = 'active' ORDER BY created_at DESC LIMIT 3`
                : `SELECT title FROM jobs WHERE status = 'active' ORDER BY created_at DESC LIMIT 3`;
            const altResult = await query(altSQL, []);
            if (altResult.rows.length > 0) {
                alternativeJobs = altResult.rows.map(r => r.title);
            }
        }
    } catch (lookupErr) {
        logger.warn(`Status notify: job lookup failed — ${lookupErr.message}`);
    }

    try {
        await axios.post(
            `${chatbotUrl}/webhook/candidate-status`,
            {
                candidate_phone: phone,
                candidate_name: candidate.name || 'Candidate',
                status: newStatus,
                job_title: jobTitle,
                interview_date: interviewDate,
                interview_location: interviewLocation,
                alternative_jobs: alternativeJobs,
            },
            {
                headers: { 'x-chatbot-api-key': apiKey },
                timeout: 10000,
            }
        );
        logger.info(`Status notification sent to chatbot for candidate ${candidate.id}: ${newStatus}`);
    } catch (err) {
        logger.warn(`Failed to notify chatbot of status change for ${candidate.id}: ${err.message}`);
    }
}

module.exports = router;
