const express = require('express');
const router = express.Router();
const { query, generateUUID } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { requireSection } = require('../middleware/sections');
const { adaptQuery, isMySQL } = require('../utils/query-adapter');
const { normalizePhone } = require('../utils/phone');
const axios = require('axios');
const logger = require('../utils/logger');
const { resolveCvAccessUrl } = require('../utils/cv-url');
const { openai, createChatCompletion } = require('../config/openai');
const notifications = require('../services/notifications');
const {
    syncCandidateStage,
    setCandidateStage,
    emitStageChanged,
    candidateHasCv,
    CANDIDATE_STATUS_SET,
} = require('../services/candidate-stage');

function parseCandidateMetadata(metadata) {
    if (!metadata) return {};
    if (typeof metadata === 'object') return metadata;
    try {
        return JSON.parse(metadata);
    } catch (_error) {
        return {};
    }
}

function isPlaceholderCandidateName(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return true;
    return [
        'unknown',
        'unknown candidate',
        'candidate',
        'pending ai extraction',
        'n/a',
        'na',
    ].includes(normalized) || normalized.startsWith('whatsapp ');
}

function resolveCandidateDisplayName(candidate, metadata = parseCandidateMetadata(candidate?.metadata)) {
    const preferredNames = [
        metadata?.application_form?.full_name,
        metadata?.full_name,
        metadata?.name,
        candidate?.name,
    ];

    const explicitName = preferredNames
        .map((value) => String(value || '').trim())
        .find((value) => value && !isPlaceholderCandidateName(value));

    return explicitName || String(candidate?.phone || candidate?.whatsapp_phone || candidate?.name || 'Unknown Candidate').trim();
}

function normalizeCandidateRecord(candidate) {
    const metadata = parseCandidateMetadata(candidate?.metadata);
    const displayName = resolveCandidateDisplayName(candidate, metadata);
    const parsedAge = Number(metadata?.age);
    const age = Number.isFinite(parsedAge) ? parsedAge : null;

    return {
        ...candidate,
        metadata,
        display_name: displayName,
        name: displayName,
        age,
    };
}

function normalizeAgeInput(value) {
    if (value === undefined) return { hasValue: false, age: null };
    if (value === null || String(value).trim() === '') return { hasValue: true, age: null };

    const age = Number.parseInt(String(value), 10);
    if (!Number.isFinite(age) || age <= 0 || age > 120) {
        return { hasValue: true, invalid: true, age: null };
    }

    return { hasValue: true, age };
}

/**
 * Get all candidates with filters and pagination
 * Compatible with both MySQL and PostgreSQL
 */
router.get('/', authenticate, requireSection('candidates', 'view'), async (req, res, next) => {
    try {
        const {
            page = 1,
            limit = 20,
            status,
            source,
            search,
            language,
            project_id,
            project_ids,
            job_id,
            intervention_needed,
            has_cv,
            date_from,
            date_to,
            sort_by,
            sort_order,
        } = req.query;

        const offset = (page - 1) * limit;

        const params = [];
        // Table alias `c` so we can join latest application info below.
        let whereClause = ' WHERE 1=1';

        if (status) {
            whereClause += isMySQL ? ' AND c.status = ?' : ` AND c.status = $${params.length + 1}`;
            params.push(status);
        }

        if (source) {
            whereClause += isMySQL ? ' AND c.source = ?' : ` AND c.source = $${params.length + 1}`;
            params.push(source);
        }

        if (language) {
            // singlish/tanglish are stored as si/ta in the DB; normalise before filtering
            const LANG_NORM = { singlish: 'si', tanglish: 'ta' };
            const normLang = LANG_NORM[language] || language;
            whereClause += isMySQL ? ' AND c.preferred_language = ?' : ` AND c.preferred_language = $${params.length + 1}`;
            params.push(normLang);
        }

        const parsedProjectIds = Array.isArray(project_ids)
            ? project_ids
            : String(project_ids || '')
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean);

        const selectedProjectIds = [...new Set([
            ...(project_id ? [String(project_id).trim()] : []),
            ...parsedProjectIds,
        ].filter(Boolean))];

        if (selectedProjectIds.length > 0) {
            const inPlaceholders = selectedProjectIds
                .map((_, idx) => (isMySQL ? '?' : `$${params.length + idx + 1}`))
                .join(', ');

            whereClause += ` AND EXISTS (
                        SELECT 1
                        FROM applications a
                        JOIN jobs j ON a.job_id = j.id
                        WHERE a.candidate_id = c.id
                          AND j.project_id IN (${inPlaceholders})
                    )`;
            params.push(...selectedProjectIds);
        }

        if (job_id) {
            const placeholder = isMySQL ? '?' : `$${params.length + 1}`;
            whereClause += ` AND EXISTS (
                        SELECT 1 FROM applications a
                        WHERE a.candidate_id = c.id AND a.job_id = ${placeholder}
                    )`;
            params.push(String(job_id).trim());
        }

        if (search) {
            // Strip non-digits, plus a local-format leading zero: SL numbers are
            // stored as 94XXXXXXXXX but recruiters type 0XXXXXXXXX — keeping the
            // leading 0 makes the digit substring miss the stored number.
            const digits = String(search).replace(/\D/g, '').replace(/^0+/, '');
            // Search now also covers skills + the metadata JSON (so recruiters can
            // find candidates by skill, licence, previous employer, country, etc.).
            if (isMySQL) {
                if (digits) {
                    whereClause += ' AND (c.name LIKE ? OR c.phone LIKE ? OR c.email LIKE ? OR c.skills LIKE ? OR c.metadata LIKE ? OR REPLACE(REPLACE(REPLACE(c.phone, \' \', \'\'), \'-\', \'\'), \'+\', \'\') LIKE ?)';
                    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${digits}%`);
                } else {
                    whereClause += ' AND (c.name LIKE ? OR c.phone LIKE ? OR c.email LIKE ? OR c.skills LIKE ? OR c.metadata LIKE ?)';
                    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
                }
            } else {
                if (digits) {
                    whereClause += ` AND (c.name ILIKE $${params.length + 1} OR c.phone ILIKE $${params.length + 1} OR c.email ILIKE $${params.length + 1} OR c.skills ILIKE $${params.length + 1} OR c.metadata::text ILIKE $${params.length + 1} OR regexp_replace(c.phone, '\\D', '', 'g') ILIKE $${params.length + 2})`;
                    params.push(`%${search}%`, `%${digits}%`);
                } else {
                    whereClause += ` AND (c.name ILIKE $${params.length + 1} OR c.phone ILIKE $${params.length + 1} OR c.email ILIKE $${params.length + 1} OR c.skills ILIKE $${params.length + 1} OR c.metadata::text ILIKE $${params.length + 1})`;
                    params.push(`%${search}%`);
                }
            }
        }

        if (intervention_needed !== undefined) {
            // Prod candidates table has NO `intervention_needed` column — human
            // handoff is tracked by requires_human / is_human_handoff (mirrors
            // notifications.js). Querying the old column 500s on every poll.
            const asBool = String(intervention_needed).toLowerCase() === 'true';
            const cond = '(c.requires_human IS TRUE OR c.is_human_handoff IS TRUE)';
            whereClause += asBool ? ` AND ${cond}` : ` AND NOT ${cond}`;
        }

        // Has-CV: a candidate "has a CV" if the cv_uploaded flag is set OR a
        // cv_files row exists (the flag and the files table can disagree —
        // 45 flagged vs 33 with files in prod — so check both). No params.
        if (has_cv !== undefined && has_cv !== '') {
            const wantsCv = String(has_cv).toLowerCase() === 'true';
            const cvCondition = '(c.cv_uploaded IS TRUE OR EXISTS (SELECT 1 FROM cv_files f WHERE f.candidate_id = c.id))';
            whereClause += wantsCv ? ` AND ${cvCondition}` : ` AND NOT ${cvCondition}`;
        }

        // Date-added range on c.created_at. date_to is made inclusive of the
        // whole day by comparing against the next day's start.
        if (date_from) {
            whereClause += isMySQL ? ' AND c.created_at >= ?' : ` AND c.created_at >= $${params.length + 1}`;
            params.push(date_from);
        }
        if (date_to) {
            whereClause += isMySQL
                ? ' AND c.created_at < DATE_ADD(?, INTERVAL 1 DAY)'
                : ` AND c.created_at < ($${params.length + 1}::date + INTERVAL '1 day')`;
            params.push(date_to);
        }

        // Allowed sort keys → SQL expressions (post-join column refs)
        const SORT_MAP = {
            created_at:    'c.created_at',
            name:          'c.name',
            job_title:     'la.job_title',
            project_title: 'la.project_title',
            status:        'c.status',
        };
        const sortCol = SORT_MAP[String(sort_by || '').toLowerCase()] || 'c.created_at';
        const sortDir = String(sort_order || '').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
        // NULLS handling: keep candidates without applications at the end for job/project sorts.
        const nullsClause = (sortCol === 'la.job_title' || sortCol === 'la.project_title')
            ? (isMySQL ? '' : ' NULLS LAST')
            : '';

        // Join clause that exposes the most recent application's job/project.
        // LEFT JOIN LATERAL is supported by PostgreSQL 9.3+ and MySQL 8.0.14+.
        const lateralJoin = `
            LEFT JOIN LATERAL (
                SELECT j.id AS job_id, j.title AS job_title,
                       p.id AS project_id, p.title AS project_title,
                       a.applied_at
                FROM applications a
                JOIN jobs j ON a.job_id = j.id
                LEFT JOIN projects p ON j.project_id = p.id
                WHERE a.candidate_id = c.id
                ORDER BY a.applied_at DESC
                LIMIT 1
            ) la ON TRUE
        `;

        // Count query (uses the same where clause; no need to join the lateral)
        const countQuery = `SELECT COUNT(*) as count FROM candidates c${whereClause}`;
        const countResult = await query(countQuery, [...params]);
        const total = isMySQL ? countResult.rows[0].count : parseInt(countResult.rows[0].count);

        // List query with pagination (includes latest-application fields for the UI + sorting)
        let listQuery;
        let listParams;
        if (isMySQL) {
            listQuery = `SELECT c.*, la.job_id AS latest_job_id, la.job_title AS latest_job_title,
                                la.project_id AS latest_project_id, la.project_title AS latest_project_title,
                                la.applied_at AS latest_applied_at
                         FROM candidates c
                         ${lateralJoin}
                         ${whereClause}
                         ORDER BY ${sortCol} ${sortDir}${nullsClause}, c.created_at DESC
                         LIMIT ? OFFSET ?`;
            listParams = [...params, parseInt(limit), parseInt(offset)];
        } else {
            listQuery = `SELECT c.*, la.job_id AS latest_job_id, la.job_title AS latest_job_title,
                                la.project_id AS latest_project_id, la.project_title AS latest_project_title,
                                la.applied_at AS latest_applied_at
                         FROM candidates c
                         ${lateralJoin}
                         ${whereClause}
                         ORDER BY ${sortCol} ${sortDir}${nullsClause}, c.created_at DESC
                         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
            listParams = [...params, limit, offset];
        }

        const result = await query(listQuery, listParams);

        res.json({
            data: result.rows.map(normalizeCandidateRecord),
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
/**
 * GET /api/candidates/duplicates — MUST be registered before "/:id", otherwise
 * the literal "duplicates" path is captured by the :id param route (which then
 * fails the UUID lookup with a 500). This activates the existing
 * duplicate-detection service + the "Scan for Duplicates" UI.
 */
router.get('/duplicates', authenticate, requireSection('candidates', 'view'), async (req, res, next) => {
    try {
        const { min_confidence = 0.5, limit = 100 } = req.query;
        const { findDuplicates } = require('../services/duplicate-detection');
        const pairs = await findDuplicates(parseFloat(min_confidence), parseInt(limit, 10));
        res.json(pairs);
    } catch (err) { next(err); }
});

router.get('/:id', authenticate, requireSection('candidates', 'view'), async (req, res, next) => {
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
            metadata = parseCandidateMetadata(candidate.metadata);
        } catch (_) {}
        const displayName = resolveCandidateDisplayName(candidate, metadata);
        candidate = {
            ...candidate,
            metadata,
            display_name: displayName,
            name: displayName,
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

        // Get interviews (for the onboarding checklist, #3.1) — degrade to [] if
        // the interview_schedules table/column isn't present on this DB.
        let interviewsRows = [];
        try {
            const interviewsResult = await query(
                isMySQL
                    ? `SELECT iv.id, iv.scheduled_datetime, iv.status, iv.location, a.job_id
                       FROM interview_schedules iv JOIN applications a ON iv.application_id = a.id
                       WHERE a.candidate_id = ? ORDER BY iv.scheduled_datetime DESC`
                    : `SELECT iv.id, iv.scheduled_datetime, iv.status, iv.location, a.job_id
                       FROM interview_schedules iv JOIN applications a ON iv.application_id = a.id
                       WHERE a.candidate_id = $1 ORDER BY iv.scheduled_datetime DESC`,
                [id]
            );
            interviewsRows = interviewsResult.rows || [];
        } catch (e) {
            // Degrade to [] so the candidate page still loads (e.g. if the
            // interview_schedules table isn't present on this DB), but log it so
            // a real query error isn't fully silent.
            logger.warn(`candidate ${id} interviews query failed (degrading to []): ${e.message}`);
            interviewsRows = [];
        }

        const enrichedCvs = (cvsResult.rows || []).map((cv) => {
            const resolved = resolveCvAccessUrl(cv);
            const parsedData = cv?.parsed_data && typeof cv.parsed_data === 'string'
                ? (() => {
                    try { return JSON.parse(cv.parsed_data); } catch (_) { return null; }
                })()
                : cv?.parsed_data;

            // Preserve specific document types (passport/certificate/photo) so the
            // UI can label them; anything else is treated as the primary CV.
            const dc = String(parsedData?.__document_category || '').toLowerCase();
            const documentCategory = ['passport', 'certificate', 'photo', 'id', 'additional'].includes(dc)
                ? dc
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
            communications: communicationsResult.rows,
            interviews: interviewsRows
        });
    } catch (error) {
        next(error);
    }
});

/**
 * Create new candidate manually
 */
router.post('/', authenticate, requireSection('candidates', 'create'), async (req, res, next) => {
    try {
        const {
            name,
            phone,
            email,
            source = 'manual',
            preferred_language = 'en',
            notes,
            age,
        } = req.body;

        if (!name || !phone) {
            return res.status(400).json({ error: 'Name and phone are required' });
        }

        const normalizedPhone = normalizePhone(phone) || String(phone).trim();

        const ageInput = normalizeAgeInput(age);
        if (ageInput.invalid) {
            return res.status(400).json({ error: 'Age must be a number between 1 and 120' });
        }

        const metadata = parseCandidateMetadata(req.body?.metadata);
        if (ageInput.hasValue) {
            if (ageInput.age === null) {
                delete metadata.age;
            } else {
                metadata.age = ageInput.age;
            }
        }
        const metadataPayload = Object.keys(metadata).length ? metadata : null;

        if (isMySQL) {
            // MySQL: Insert then select
            const id = generateUUID();
            await query(
                `INSERT INTO candidates (id, name, phone, email, source, preferred_language, notes, metadata, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new')`,
                [id, name, normalizedPhone, email, source, preferred_language, notes, metadataPayload ? JSON.stringify(metadataPayload) : null]
            );

            const result = await query('SELECT * FROM candidates WHERE id = ?', [id]);
            res.status(201).json(result.rows[0]);
        } else {
            // PostgreSQL: Use RETURNING
            const result = await query(
                `INSERT INTO candidates (name, phone, email, source, preferred_language, notes, metadata, status)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 'new')
                 RETURNING *`,
                [name, normalizedPhone, email, source, preferred_language, notes, metadataPayload]
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
router.put('/:id', authenticate, requireSection('candidates', 'edit'), async (req, res, next) => {
    try {
        const { id } = req.params;
        const updates = req.body;

        // Enforce the canonical 7-value candidate vocabulary on any direct status
        // write (#1) — no ad-hoc status word can be persisted here.
        if (Object.prototype.hasOwnProperty.call(updates, 'status')
            && updates.status != null && !CANDIDATE_STATUS_SET.has(updates.status)) {
            return res.status(400).json({
                error: `Invalid candidate status "${updates.status}". Allowed: ${[...CANDIDATE_STATUS_SET].join(', ')}.`,
            });
        }

        const allowedFields = ['name', 'phone', 'email', 'source', 'status', 'preferred_language', 'notes', 'tags', 'skills', 'experience_years', 'highest_qualification'];
        // Profile fields stored inside the metadata JSON (like age) rather than
        // as flat columns — avoids schema churn on the production-only DB.
        const META_KEYS = ['age', 'height_cm', 'nationality', 'country', 'licenses', 'previous_employer', 'english_level', 'english_proficiency'];
        const setClause = [];
        const values = [];
        const metaKeysInPayload = META_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(updates, k));

        Object.keys(updates).forEach(key => {
            if (allowedFields.includes(key)) {
                if (isMySQL) {
                    setClause.push(`${key} = ?`);
                } else {
                    setClause.push(`${key} = $${values.length + 1}`);
                }
                // Normalize phone on edit so search/dedupe stay consistent
                if (key === 'phone' && updates[key]) {
                    values.push(normalizePhone(updates[key]) || String(updates[key]).trim());
                } else if (key === 'tags' && isMySQL && Array.isArray(updates[key])) {
                    values.push(JSON.stringify(updates[key]));
                } else {
                    values.push(updates[key]);
                }
            }
        });

        if (metaKeysInPayload.length > 0) {
            const placeholder = isMySQL ? '?' : '$1';
            const existingCandidateResult = await query(
                `SELECT metadata FROM candidates WHERE id = ${placeholder}`,
                [id]
            );

            if (existingCandidateResult.rows.length === 0) {
                return res.status(404).json({ error: 'Candidate not found' });
            }

            const metadata = parseCandidateMetadata(existingCandidateResult.rows[0]?.metadata);

            for (const key of metaKeysInPayload) {
                const raw = updates[key];
                if (key === 'age') {
                    const ageInput = normalizeAgeInput(raw);
                    if (ageInput.invalid) {
                        return res.status(400).json({ error: 'Age must be a number between 1 and 120' });
                    }
                    if (ageInput.age === null) delete metadata.age; else metadata.age = ageInput.age;
                } else if (key === 'height_cm') {
                    if (raw === null || String(raw).trim() === '') {
                        delete metadata.height_cm;
                    } else {
                        const h = Number.parseInt(String(raw), 10);
                        if (!Number.isFinite(h) || h <= 0 || h > 300) {
                            return res.status(400).json({ error: 'Height (cm) must be a number between 1 and 300' });
                        }
                        metadata.height_cm = h;
                    }
                } else {
                    // nationality, english_level — free text; empty clears it.
                    const val = raw === null ? '' : String(raw).trim();
                    if (!val) delete metadata[key]; else metadata[key] = val;
                }
            }

            if (isMySQL) {
                setClause.push('metadata = ?');
                values.push(JSON.stringify(metadata));
            } else {
                setClause.push(`metadata = $${values.length + 1}`);
                values.push(metadata);
            }
        }

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
 * Set the candidate's pipeline stage from CV Manager.
 *
 * candidates.status is auto-derived from applications.status, so writing it
 * directly (the old behaviour) never showed up on the Applications page and was
 * clobbered by the next syncCandidateStage(). Instead we write the chosen stage
 * THROUGH to all of the candidate's active (non-terminal) applications — the
 * source of truth — then re-derive candidate.status from them. Stages without
 * an application equivalent (new / future_pool) or candidates with no active
 * applications fall back to a direct candidate.status write. The cascade itself
 * lives in setCandidateStage() (services/candidate-stage.js) so the calling
 * console can reuse it.
 */
const VALID_CANDIDATE_STAGES = new Set([
    'new', 'screening', 'certified', 'interview_scheduled', 'future_pool',
]);

router.put('/:id/stage', authenticate, requireSection('candidates', 'edit'), async (req, res, next) => {
    try {
        const { id } = req.params;
        const { stage } = req.body;
        if (!VALID_CANDIDATE_STAGES.has(stage)) {
            return res.status(400).json({ error: 'Invalid stage' });
        }

        const candRes = await query(adaptQuery('SELECT id FROM candidates WHERE id = $1'), [id]);
        if (candRes.rows.length === 0) return res.status(404).json({ error: 'Candidate not found' });

        // CV is the hard gate (#5): a candidate with no CV can only be 'new'. Any
        // forward/pool stage requires a CV on file — reuse the screening_gate 422.
        if (stage !== 'new' && !(await candidateHasCv(id))) {
            return res.status(422).json({
                error: 'Upload a CV/resume before advancing the candidate past New.',
                code: 'screening_gate',
                has_cv: false,
            });
        }

        // Cascade through applications + re-derive candidate.status, and broadcast
        // the live `candidate_stage_changed` event (shared with the calling console).
        const { updatedApplications: updatedApps } = await setCandidateStage(id, stage);

        const fresh = await query(adaptQuery('SELECT * FROM candidates WHERE id = $1'), [id]);
        return res.json({ success: true, candidate: fresh.rows[0], updated_applications: updatedApps });
    } catch (error) {
        next(error);
    }
});

/**
 * Resolve AI intervention flag after human takeover
 */
router.post('/:id/resolve-intervention', authenticate, requireSection('candidates', 'edit'), async (req, res, next) => {
    try {
        const { id } = req.params;
        const placeholder = isMySQL ? '?' : '$1';
        // Clear the real handoff flags (requires_human / is_human_handoff +
        // escalation_reason) — there is no intervention_needed column in prod.
        const updateSql = isMySQL
            ? 'UPDATE candidates SET requires_human = FALSE, is_human_handoff = FALSE, escalation_reason = NULL, updated_at = NOW() WHERE id = ?'
            : 'UPDATE candidates SET requires_human = FALSE, is_human_handoff = FALSE, escalation_reason = NULL, updated_at = NOW() WHERE id = $1 RETURNING id';

        const updated = await query(updateSql, [id]);
        if ((!isMySQL && updated.rows.length === 0) || (isMySQL && updated.rowCount === 0)) {
            return res.status(404).json({ error: 'Candidate not found' });
        }

        const fetchSql = `SELECT * FROM candidates WHERE id = ${placeholder}`;
        const candidateResult = await query(fetchSql, [id]);
        return res.json({ success: true, candidate: candidateResult.rows[0] });
    } catch (error) {
        next(error);
    }
});

/**
 * Advance a candidate from New → Screening.
 *
 * Hard gate (locked decision): a CV/resume must be on file AND the candidate
 * must be attached to a job (an applications row). On success, the candidate
 * moves to status='screening' and the "application complete" WhatsApp is sent.
 * Certification (Screening → Certified) is a separate, agent-driven action that
 * lives in Applications/Projects.
 */
router.post('/:id/screening', authenticate, requireSection('candidates', 'edit'), async (req, res, next) => {
    try {
        const { id } = req.params;
        const { note, notify_channels = ['whatsapp'] } = req.body || {};

        const gateResult = await query(
            adaptQuery(`
                SELECT c.id, c.name, c.phone, c.status, c.notes,
                       (c.cv_uploaded IS TRUE
                        OR EXISTS (SELECT 1 FROM cv_files f WHERE f.candidate_id = c.id)) AS has_cv,
                       EXISTS (SELECT 1 FROM applications a WHERE a.candidate_id = c.id) AS has_application
                FROM candidates c
                WHERE c.id = $1
            `),
            [id]
        );
        if (gateResult.rows.length === 0) return res.status(404).json({ error: 'Candidate not found' });

        const row = gateResult.rows[0];
        const truthy = (v) => v === true || v === 1 || v === '1' || v === 't' || v === 'true';
        const hasCv = truthy(row.has_cv);
        const hasApp = truthy(row.has_application);

        if (!hasCv || !hasApp) {
            return res.status(422).json({
                error: !hasCv
                    ? 'Upload a CV/resume before moving the candidate to Screening.'
                    : 'Assign the candidate to a job before moving them to Screening.',
                code: 'screening_gate',
                has_cv: hasCv,
                has_application: hasApp,
            });
        }

        // Move to screening; keep conversation_stage unified.
        await query(
            adaptQuery("UPDATE candidates SET status = 'screening', conversation_stage = 'screening', updated_at = NOW() WHERE id = $1"),
            [id]
        );
        emitStageChanged(id, 'screening');

        // Optional internal note — append to candidate notes for an audit trail.
        if (note && String(note).trim()) {
            const prev = row.notes ? `${row.notes}\n` : '';
            await query(
                adaptQuery('UPDATE candidates SET notes = $1 WHERE id = $2'),
                [`${prev}[Screening] ${String(note).trim()}`, id]
            );
        }

        // Resolve the job title from the latest application for the message.
        let jobTitle = 'your applied position';
        try {
            const appRes = await query(
                adaptQuery(`
                    SELECT j.title FROM applications a
                    JOIN jobs j ON a.job_id = j.id
                    WHERE a.candidate_id = $1
                    ORDER BY a.applied_at DESC LIMIT 1
                `),
                [id]
            );
            if (appRes.rows.length > 0 && appRes.rows[0].title) jobTitle = appRes.rows[0].title;
        } catch (e) {
            logger.warn(`Screening: job title lookup failed for ${id}: ${e.message}`);
        }

        const channels = Array.isArray(notify_channels) ? notify_channels : ['whatsapp'];
        let notification = { success: [], failed: [] };
        try {
            notification = await notifications.sendApplicationCompleteNotification(id, jobTitle, channels);
        } catch (notifErr) {
            logger.error(`Screening notification failed for ${id}: ${notifErr.message}`);
            notification.failed.push({ channel: 'all', error: notifErr.message });
        }

        const updated = await query(adaptQuery('SELECT * FROM candidates WHERE id = $1'), [id]);
        res.json({ ...normalizeCandidateRecord(updated.rows[0]), notification });
    } catch (error) {
        next(error);
    }
});

/**
 * Delete candidate
 */
router.delete('/:id', authenticate, requireSection('candidates', 'delete'), async (req, res, next) => {
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
 * POST /api/candidates/merge
 * Merges merge_id into keep_id — migrates all data, soft-deletes the duplicate.
 */
router.post('/merge', authenticate, requireSection('candidates', 'delete'), async (req, res, next) => {
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

// ── Photo upload ──────────────────────────────────────────────────────────────
const multer = require('multer');
const path = require('path');

const photoUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const uploadDir = process.env.UPLOAD_DIR
                ? path.join(process.env.UPLOAD_DIR, 'photos')
                : path.join(__dirname, '../../uploads/photos');
            require('fs').mkdirSync(uploadDir, { recursive: true });
            cb(null, uploadDir);
        },
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname) || '.jpg';
            cb(null, `candidate_${req.params.id}_${Date.now()}${ext}`);
        },
    }),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
    fileFilter: (req, file, cb) => {
        if (!file.mimetype.startsWith('image/')) {
            return cb(new Error('Only image files are allowed'));
        }
        cb(null, true);
    },
});

/**
 * POST /api/candidates/:id/photo
 * Upload or replace the candidate's profile photo.
 */
router.post(
    '/:id/photo',
    authenticate,
    requireSection('cv_manager', 'edit'),
    photoUpload.single('photo'),
    async (req, res, next) => {
        try {
            const { id } = req.params;
            if (!req.file) {
                return res.status(400).json({ error: 'No photo file uploaded' });
            }

            const photoUrl = `/uploads/photos/${req.file.filename}`;
            const placeholder = isMySQL ? '?' : '$1';
            const idPlaceholder = isMySQL ? '?' : '$2';

            // A manual upload always wins and LOCKS the picture (#6): photo_source
            // = 'manual' so the chatbot's auto person-photo detection never
            // overwrites a recruiter's chosen avatar.
            const result = await query(
                `UPDATE candidates SET photo_url = ${placeholder}, photo_source = 'manual' WHERE id = ${idPlaceholder} RETURNING id, photo_url, photo_source`,
                [photoUrl, id]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Candidate not found' });
            }

            res.json({ photo_url: result.rows[0].photo_url, photo_source: result.rows[0].photo_source });
        } catch (error) {
            next(error);
        }
    }
);

// ── Document upload (CV / passport / certificate / photo / other) ───────────────
// Admin-side upload so recruiters can add a new CV or supporting documents
// directly from the CV Manager. Mirrors the photo multer config. A 'cv' upload
// also flips candidates.cv_uploaded so the Screening gate + auto-assign work.
const DOC_TYPES = ['cv', 'passport', 'certificate', 'photo', 'id', 'additional', 'other'];

const documentUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const uploadDir = process.env.UPLOAD_DIR
                ? path.join(process.env.UPLOAD_DIR, 'documents')
                : path.join(__dirname, '../../uploads/documents');
            require('fs').mkdirSync(uploadDir, { recursive: true });
            cb(null, uploadDir);
        },
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname) || '';
            cb(null, `candidate_${req.params.id}_${Date.now()}${ext}`);
        },
    }),
    limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
});

/**
 * POST /api/candidates/:id/documents
 * Upload a CV or supporting document for a candidate. Form fields:
 *   file     — the document (multipart)
 *   doc_type — one of DOC_TYPES (defaults to 'cv')
 */
router.post(
    '/:id/documents',
    authenticate,
    requireSection('cv_manager', 'create'),
    documentUpload.single('file'),
    async (req, res, next) => {
        try {
            const { id } = req.params;
            if (!req.file) {
                return res.status(400).json({ error: 'No file uploaded' });
            }

            const docType = DOC_TYPES.includes(String(req.body.doc_type || '').toLowerCase())
                ? String(req.body.doc_type).toLowerCase()
                : 'cv';

            const candCheck = await query(adaptQuery('SELECT id FROM candidates WHERE id = $1'), [id]);
            if (candCheck.rows.length === 0) {
                return res.status(404).json({ error: 'Candidate not found' });
            }

            const fileUrl = `/uploads/documents/${req.file.filename}`;
            const ext = (path.extname(req.file.originalname) || '').replace('.', '').toLowerCase() || null;
            const isCv = docType === 'cv';
            // Non-CV docs are tagged via parsed_data.__document_category so the
            // GET enrichment labels them (passport / certificate / photo / …).
            const parsedData = isCv ? null : JSON.stringify({ __document_category: docType });
            const cvId = generateUUID();

            // A freshly uploaded CV becomes the primary; demote prior ones.
            if (isCv) {
                await query(adaptQuery('UPDATE cv_files SET is_primary = FALSE WHERE candidate_id = $1'), [id]);
            }

            await query(
                adaptQuery(`
                    INSERT INTO cv_files
                        (id, candidate_id, file_url, file_name, file_type, ocr_status, parsed_data, is_primary, uploaded_at)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
                `),
                [cvId, id, fileUrl, req.file.originalname, ext, isCv ? 'pending' : 'completed', parsedData, isCv]
            );

            // Mark the candidate as having a CV so the Screening gate + matcher pass.
            if (isCv) {
                await query(
                    adaptQuery("UPDATE candidates SET cv_uploaded = TRUE, cv_status = 'completed', updated_at = NOW() WHERE id = $1"),
                    [id]
                );
            }

            res.status(201).json({
                success: true,
                cv_id: cvId,
                document_category: docType,
                file_url: fileUrl,
                file_name: req.file.originalname,
            });
        } catch (error) {
            next(error);
        }
    }
);

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

// ── POST /api/candidates/cv/:cvId/reparse — Auto-OCR / re-extract a stored CV ─
// Re-runs extraction on a CV whose parsed_data is thin/empty. Images go to
// GPT-4o vision (file_url is a public GCS URL); documents are re-parsed from
// their stored raw/OCR text. Updates cv_files.parsed_data + enriches metadata.
const CV_REPARSE_PROMPT = 'Extract recruitment data from this CV/document and return JSON with keys '
    + '(use null/[] when absent): full_name, email, phone, age (number), height_cm (number), '
    + 'nationality, current_job_title, current_company, previous_employer, total_experience_years (number), '
    + 'highest_qualification, technical_skills (array), soft_skills (array), languages_spoken (array), '
    + 'certifications (array), licenses (string), country, '
    + 'document_type (one of: cv, passport, certificate, photo, other), raw_text, overall_confidence (0-1).';

router.post('/cv/:cvId/reparse', authenticate, requireSection('cv_manager', 'edit'), async (req, res) => {
    const { cvId } = req.params;
    try {
        const sql = isMySQL ? 'SELECT * FROM cv_files WHERE id = ? LIMIT 1' : 'SELECT * FROM cv_files WHERE id = $1 LIMIT 1';
        const result = await query(sql, [cvId]);
        if (!result.rows.length) return res.status(404).json({ error: 'CV not found' });
        const cv = result.rows[0];
        const existingParsed = parseCandidateMetadata(cv.parsed_data);
        const resolved = resolveCvAccessUrl(cv);
        const fileUrl = (resolved && resolved.url) || cv.file_url;
        const nameLower = String(cv.file_name || cv.file_url || '').toLowerCase();
        const isImage = (cv.file_type && String(cv.file_type).includes('image')) || /\.(jpg|jpeg|png|webp|gif|bmp)\b/.test(nameLower);

        let parsedJson = null;
        if (isImage && fileUrl && /^https?:\/\//.test(fileUrl)) {
            const resp = await openai.chat.completions.create({
                model: 'gpt-4o',
                messages: [
                    { role: 'system', content: 'You are an expert CV parser. Return valid JSON only.' },
                    { role: 'user', content: [
                        { type: 'text', text: CV_REPARSE_PROMPT },
                        { type: 'image_url', image_url: { url: fileUrl, detail: 'high' } },
                    ] },
                ],
                response_format: { type: 'json_object' },
            });
            try { parsedJson = JSON.parse(resp.choices[0].message.content || '{}'); } catch { parsedJson = null; }
        } else {
            const text = cv.ocr_text || existingParsed.raw_text || '';
            if (!text || String(text).length < 20) {
                return res.status(422).json({ error: 'No image or extractable text available to re-parse', code: 'no_source' });
            }
            const content = await createChatCompletion(
                [
                    { role: 'system', content: 'You are an expert CV parser. Return valid JSON only.' },
                    { role: 'user', content: `${CV_REPARSE_PROMPT}\n\nCV TEXT:\n${String(text).slice(0, 15000)}` },
                ],
                { model: 'gpt-4o', response_format: { type: 'json_object' }, max_tokens: 1500 }
            );
            try { parsedJson = JSON.parse(content || '{}'); } catch { parsedJson = null; }
        }
        if (!parsedJson || typeof parsedJson !== 'object') {
            return res.status(502).json({ error: 'Re-parse produced no data' });
        }

        const merged = {
            ...existingParsed,
            ...parsedJson,
            __document_category: existingParsed.__document_category
                || (parsedJson.document_type && parsedJson.document_type !== 'cv' ? parsedJson.document_type : 'cv'),
        };
        const upSQL = isMySQL
            ? "UPDATE cv_files SET parsed_data = ?, ocr_status = 'completed' WHERE id = ?"
            : "UPDATE cv_files SET parsed_data = $1, ocr_status = 'completed' WHERE id = $2";
        await query(upSQL, [JSON.stringify(merged), cvId]);

        // Enrich candidate metadata — fill blanks only, never clobber.
        try {
            const cSQL = isMySQL ? 'SELECT metadata, skills FROM candidates WHERE id = ? LIMIT 1' : 'SELECT metadata, skills FROM candidates WHERE id = $1 LIMIT 1';
            const cRes = await query(cSQL, [cv.candidate_id]);
            if (cRes.rows.length) {
                const meta = parseCandidateMetadata(cRes.rows[0].metadata);
                const setIf = (k, v) => { if (v !== undefined && v !== null && v !== '' && (meta[k] === undefined || meta[k] === null || meta[k] === '')) meta[k] = v; };
                const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined);
                setIf('age', num(parsedJson.age));
                setIf('height_cm', num(parsedJson.height_cm));
                setIf('experience_years', num(parsedJson.total_experience_years));
                setIf('previous_employer', parsedJson.previous_employer || parsedJson.current_company);
                setIf('licenses', parsedJson.licenses || (Array.isArray(parsedJson.certifications) ? parsedJson.certifications.join(', ') : undefined));
                setIf('country', parsedJson.country || parsedJson.nationality);
                const metaUp = isMySQL ? 'UPDATE candidates SET metadata = ? WHERE id = ?' : 'UPDATE candidates SET metadata = $1::jsonb WHERE id = $2';
                await query(metaUp, [JSON.stringify(meta), cv.candidate_id]);
                const skillsArr = [].concat(parsedJson.technical_skills || [], parsedJson.soft_skills || []).filter(Boolean);
                if (skillsArr.length && !cRes.rows[0].skills) {
                    const sUp = isMySQL ? 'UPDATE candidates SET skills = ? WHERE id = ?' : 'UPDATE candidates SET skills = $1 WHERE id = $2';
                    await query(sUp, [skillsArr.slice(0, 20).join(', '), cv.candidate_id]);
                }
            }
        } catch (metaErr) {
            logger.warn(`Re-parse metadata enrich skipped: ${metaErr.message}`);
        }

        logger.info(`Re-parsed CV ${cvId} (candidate ${cv.candidate_id})`);
        return res.json({ success: true, cv_id: cvId, parsed_data: merged });
    } catch (error) {
        logger.error(`CV re-parse error for ${cvId}: ${error.message}`);
        return res.status(500).json({ error: 'Re-parse failed', detail: error.message });
    }
});

module.exports = router;
