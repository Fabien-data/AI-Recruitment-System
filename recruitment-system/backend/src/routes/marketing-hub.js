/**
 * Marketing Hub Routes
 * ====================
 * Lead capture, qualification, conversion, and outreach for the call-handling
 * team. Leads live in `marketing_leads` until an agent explicitly promotes
 * them into `candidates` via the convert endpoint, keeping the recruitment
 * pipeline clean of unqualified records.
 *
 * Mounted at /api/marketing-hub in server.js.
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const { query, withTransaction } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { normalizePhone } = require('../utils/phone');
const { uploadToGCS } = require('../utils/gcs-upload');
const whatsapp = require('../services/whatsapp');
const sms = require('../services/sms');
const logger = require('../utils/logger');

const ALLOWED_ROLES = ['admin', 'sourcing_department', 'marketing_agent'];
const STAGES = ['new', 'contacted', 'qualified', 'converted', 'lost'];
const DOC_TYPES = ['cv', 'nic_copy', 'passport', 'other'];

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 },
});

// Outbound templates for lead-side messaging. Kept local to this module
// because the candidate-centric notifications service expects a candidate row.
const LEAD_TEMPLATES = {
    lead_welcome: {
        label: 'Welcome — thanks for calling',
        body: 'Hi {name}, thanks for reaching out to Dewan Recruitment. We have noted your interest{job_part} and will follow up shortly with next steps. — Dewan Recruitment',
    },
    lead_follow_up: {
        label: 'Follow up — still interested?',
        body: 'Hi {name}, this is Dewan Recruitment following up on our previous conversation. Are you still interested in the {job_part}? Please reply to confirm. — Dewan Recruitment',
    },
    lead_callback_reminder: {
        label: 'Callback reminder for the agent',
        body: 'Reminder: callback scheduled for {name} ({phone}) regarding {job_part}.',
    },
};

function renderTemplate(template, vars) {
    return template.replace(/\{(\w+)\}/g, (_, key) => (vars[key] != null ? String(vars[key]) : ''));
}

function buildJobPart(preferredJobTitle, preferredJobText) {
    const title = preferredJobTitle || preferredJobText;
    return title ? ` (${title})` : '';
}

// ── Lookup helpers ──────────────────────────────────────────────────────────

async function fetchLeadById(leadId) {
    const result = await query(
        `SELECT ml.*, ls.slug as source_slug, ls.label as source_label,
                j.title as preferred_job_title, j.category as preferred_job_category, j.is_urgent as preferred_job_is_urgent,
                u.full_name as assigned_agent_name
         FROM marketing_leads ml
         LEFT JOIN lead_sources ls ON ml.source_id = ls.id
         LEFT JOIN jobs j ON ml.preferred_job_id = j.id
         LEFT JOIN users u ON ml.assigned_agent_id = u.id
         WHERE ml.id = $1`,
        [leadId]
    );
    return result.rows[0] || null;
}

async function fetchLeadDocuments(leadId) {
    const result = await query(
        `SELECT id, doc_type, url, name, mime_type, size_bytes, uploaded_by, uploaded_at
         FROM lead_documents WHERE lead_id = $1 ORDER BY uploaded_at DESC`,
        [leadId]
    );
    return result.rows;
}

async function fetchLeadFollowUps(leadId) {
    const result = await query(
        `SELECT id, due_at, note, status, completed_at, created_by, created_at
         FROM lead_follow_ups WHERE lead_id = $1 ORDER BY due_at ASC`,
        [leadId]
    );
    return result.rows;
}

async function fetchLeadCallEvents(leadId) {
    const result = await query(
        `SELECT id, call_id, event_type, caller_number, agent_extension,
                duration_seconds, recording_url, occurred_at
         FROM lead_call_events WHERE lead_id = $1 ORDER BY occurred_at DESC LIMIT 50`,
        [leadId]
    );
    return result.rows;
}

// ── GET /lead-sources ────────────────────────────────────────────────────────
router.get('/lead-sources', authenticate, authorize(...ALLOWED_ROLES), async (_req, res, next) => {
    try {
        const result = await query(
            `SELECT id, slug, label FROM lead_sources WHERE is_active = TRUE ORDER BY label ASC`
        );
        res.json(result.rows);
    } catch (err) {
        next(err);
    }
});

// ── GET /countries ──────────────────────────────────────────────────────────
// Distinct countries pulled from active projects so the dropdown stays
// in sync with what the recruitment team actually recruits for.
router.get('/countries', authenticate, authorize(...ALLOWED_ROLES), async (_req, res, next) => {
    try {
        const result = await query(
            `SELECT DISTINCT jsonb_array_elements_text(countries) AS country
             FROM projects
             WHERE status = 'active' AND countries IS NOT NULL
             ORDER BY country ASC`
        );
        res.json(result.rows.map((r) => r.country).filter(Boolean));
    } catch (err) {
        next(err);
    }
});

// ── GET /job-search?q=… ─────────────────────────────────────────────────────
// Autocomplete for the "Preferred job role" field. Ranks active jobs by
// ILIKE match on title then category, urgent jobs surface first.
router.get('/job-search', authenticate, authorize(...ALLOWED_ROLES), async (req, res, next) => {
    try {
        const q = String(req.query.q || '').trim();
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 25);

        if (!q) {
            const result = await query(
                `SELECT id, title, category, location, is_urgent
                 FROM jobs WHERE status = 'active'
                 ORDER BY is_urgent DESC, created_at DESC LIMIT $1`,
                [limit]
            );
            return res.json(result.rows);
        }

        const like = `%${q}%`;
        const result = await query(
            `SELECT id, title, category, location, is_urgent
             FROM jobs
             WHERE status = 'active' AND (title ILIKE $1 OR category ILIKE $1)
             ORDER BY is_urgent DESC,
                      CASE WHEN title ILIKE $1 THEN 0 ELSE 1 END,
                      created_at DESC
             LIMIT $2`,
            [like, limit]
        );
        res.json(result.rows);
    } catch (err) {
        next(err);
    }
});

// ── GET /leads ──────────────────────────────────────────────────────────────
router.get('/leads', authenticate, authorize(...ALLOWED_ROLES), async (req, res, next) => {
    try {
        const {
            stage, source_id, assigned_agent_id, search,
            date_from, date_to, page = 1, limit = 20,
        } = req.query;

        const params = [];
        const where = [];

        if (stage) { params.push(stage); where.push(`ml.stage = $${params.length}`); }
        if (source_id) { params.push(source_id); where.push(`ml.source_id = $${params.length}`); }
        if (assigned_agent_id) { params.push(assigned_agent_id); where.push(`ml.assigned_agent_id = $${params.length}`); }
        if (search) {
            params.push(`%${search}%`);
            const idx = params.length;
            where.push(`(ml.full_name ILIKE $${idx} OR ml.phone ILIKE $${idx} OR ml.nic ILIKE $${idx})`);
        }
        if (date_from) { params.push(date_from); where.push(`ml.created_at >= $${params.length}`); }
        if (date_to)   { params.push(date_to);   where.push(`ml.created_at <= $${params.length}`); }

        // Marketing agents only see leads assigned to them or unassigned
        if (req.user.role === 'marketing_agent') {
            params.push(req.user.id);
            where.push(`(ml.assigned_agent_id = $${params.length} OR ml.assigned_agent_id IS NULL)`);
        }

        const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const safePage = Math.max(parseInt(page, 10) || 1, 1);
        const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
        const offset = (safePage - 1) * safeLimit;

        const dataSql = `
            SELECT ml.id, ml.full_name, ml.phone, ml.nic, ml.country, ml.stage,
                   ml.remarks, ml.last_contacted_at, ml.created_at, ml.updated_at,
                   ml.preferred_job_id, ml.preferred_job_text, ml.campaign_ref,
                   ml.converted_candidate_id, ml.converted_at,
                   ls.slug as source_slug, ls.label as source_label,
                   j.title as preferred_job_title, j.is_urgent as preferred_job_is_urgent,
                   u.full_name as assigned_agent_name, ml.assigned_agent_id
            FROM marketing_leads ml
            LEFT JOIN lead_sources ls ON ml.source_id = ls.id
            LEFT JOIN jobs j ON ml.preferred_job_id = j.id
            LEFT JOIN users u ON ml.assigned_agent_id = u.id
            ${whereClause}
            ORDER BY ml.created_at DESC
            LIMIT ${safeLimit} OFFSET ${offset}`;

        const countSql = `SELECT COUNT(*)::int AS total FROM marketing_leads ml ${whereClause}`;

        const [rowsResult, countResult] = await Promise.all([
            query(dataSql, params),
            query(countSql, params),
        ]);

        const total = countResult.rows[0]?.total || 0;
        res.json({
            data: rowsResult.rows,
            pagination: {
                page: safePage,
                limit: safeLimit,
                total,
                totalPages: Math.max(Math.ceil(total / safeLimit), 1),
            },
        });
    } catch (err) {
        next(err);
    }
});

// ── POST /leads ─────────────────────────────────────────────────────────────
router.post('/leads', authenticate, authorize(...ALLOWED_ROLES), async (req, res, next) => {
    try {
        const {
            full_name, phone, nic, dob, country,
            preferred_job_id, preferred_job_text,
            remarks, source_id, campaign_ref,
            assigned_agent_id, allow_duplicate,
        } = req.body || {};

        if (!full_name || !phone) {
            return res.status(400).json({ error: 'full_name and phone are required' });
        }

        const normalizedPhone = normalizePhone(phone) || String(phone).trim();

        if (!allow_duplicate) {
            const dupLead = await query(
                `SELECT id, full_name, stage, created_at FROM marketing_leads WHERE phone = $1 LIMIT 1`,
                [normalizedPhone]
            );
            if (dupLead.rows.length) {
                return res.status(409).json({
                    error: 'duplicate_lead',
                    existing: dupLead.rows[0],
                    hint: 'Resubmit with allow_duplicate: true to create anyway.',
                });
            }
            const dupCandidate = await query(
                `SELECT id, name, phone FROM candidates WHERE phone = $1 LIMIT 1`,
                [normalizedPhone]
            );
            if (dupCandidate.rows.length) {
                return res.status(409).json({
                    error: 'duplicate_candidate',
                    existing: dupCandidate.rows[0],
                    hint: 'A candidate with this phone already exists. Resubmit with allow_duplicate: true if intentional.',
                });
            }
        }

        const result = await query(
            `INSERT INTO marketing_leads
                (full_name, phone, nic, dob, country, preferred_job_id, preferred_job_text,
                 remarks, source_id, campaign_ref, assigned_agent_id, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             RETURNING *`,
            [
                full_name,
                normalizedPhone,
                nic || null,
                dob || null,
                country || null,
                preferred_job_id || null,
                preferred_job_text || null,
                remarks || null,
                source_id || null,
                campaign_ref || null,
                assigned_agent_id || null,
                req.user.id,
            ]
        );

        res.status(201).json(result.rows[0]);
    } catch (err) {
        next(err);
    }
});

// ── GET /leads/:id ──────────────────────────────────────────────────────────
router.get('/leads/:id', authenticate, authorize(...ALLOWED_ROLES), async (req, res, next) => {
    try {
        const lead = await fetchLeadById(req.params.id);
        if (!lead) return res.status(404).json({ error: 'lead_not_found' });

        const [documents, follow_ups, call_events] = await Promise.all([
            fetchLeadDocuments(lead.id),
            fetchLeadFollowUps(lead.id),
            fetchLeadCallEvents(lead.id),
        ]);

        res.json({ ...lead, documents, follow_ups, call_events });
    } catch (err) {
        next(err);
    }
});

// ── PATCH /leads/:id ────────────────────────────────────────────────────────
router.patch('/leads/:id', authenticate, authorize(...ALLOWED_ROLES), async (req, res, next) => {
    try {
        const { id } = req.params;
        const updates = req.body || {};
        const allowedFields = [
            'full_name', 'phone', 'nic', 'dob', 'country',
            'preferred_job_id', 'preferred_job_text', 'remarks',
            'source_id', 'campaign_ref', 'stage', 'lost_reason',
            'assigned_agent_id', 'last_contacted_at',
        ];

        if (updates.stage && !STAGES.includes(updates.stage)) {
            return res.status(400).json({ error: 'invalid_stage', allowed: STAGES });
        }

        // Backward stage transitions are admin-only (per plan).
        if (updates.stage) {
            const current = await query(`SELECT stage FROM marketing_leads WHERE id = $1`, [id]);
            if (!current.rows.length) return res.status(404).json({ error: 'lead_not_found' });
            const currentIdx = STAGES.indexOf(current.rows[0].stage);
            const nextIdx = STAGES.indexOf(updates.stage);
            if (nextIdx < currentIdx && req.user.role !== 'admin') {
                return res.status(403).json({ error: 'backward_stage_transition_admin_only' });
            }
        }

        const setClauses = [];
        const values = [];
        for (const key of Object.keys(updates)) {
            if (!allowedFields.includes(key)) continue;
            if (key === 'phone' && updates[key]) {
                values.push(normalizePhone(updates[key]) || String(updates[key]).trim());
            } else {
                values.push(updates[key] === '' ? null : updates[key]);
            }
            setClauses.push(`${key} = $${values.length}`);
        }

        if (!setClauses.length) {
            return res.status(400).json({ error: 'no_valid_fields_to_update' });
        }

        setClauses.push(`updated_at = NOW()`);
        values.push(id);

        const result = await query(
            `UPDATE marketing_leads SET ${setClauses.join(', ')}
             WHERE id = $${values.length} RETURNING *`,
            values
        );
        if (!result.rows.length) return res.status(404).json({ error: 'lead_not_found' });
        res.json(result.rows[0]);
    } catch (err) {
        next(err);
    }
});

// ── DELETE /leads/:id ───────────────────────────────────────────────────────
router.delete('/leads/:id', authenticate, authorize('admin'), async (req, res, next) => {
    try {
        const result = await query(
            `DELETE FROM marketing_leads WHERE id = $1 RETURNING id`,
            [req.params.id]
        );
        if (!result.rows.length) return res.status(404).json({ error: 'lead_not_found' });
        res.json({ ok: true, id: result.rows[0].id });
    } catch (err) {
        next(err);
    }
});

// ── POST /leads/:id/documents ───────────────────────────────────────────────
router.post(
    '/leads/:id/documents',
    authenticate,
    authorize(...ALLOWED_ROLES),
    upload.single('file'),
    async (req, res, next) => {
        try {
            const { id } = req.params;
            if (!req.file) return res.status(400).json({ error: 'file_required' });

            const docType = DOC_TYPES.includes(req.body.doc_type) ? req.body.doc_type : 'other';

            const leadCheck = await query(`SELECT id FROM marketing_leads WHERE id = $1`, [id]);
            if (!leadCheck.rows.length) return res.status(404).json({ error: 'lead_not_found' });

            const ts = Date.now();
            const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
            const uniqueName = `${ts}_${safeName}`;
            const destPath = `marketing-leads/${id}/${uniqueName}`;

            const publicUrl = await uploadToGCS(req.file.buffer, destPath, req.file.mimetype);
            if (!publicUrl) {
                return res.status(500).json({ error: 'upload_failed' });
            }

            const insert = await query(
                `INSERT INTO lead_documents
                    (lead_id, doc_type, url, name, mime_type, size_bytes, uploaded_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 RETURNING *`,
                [id, docType, publicUrl, uniqueName, req.file.mimetype, req.file.size, req.user.id]
            );

            res.status(201).json(insert.rows[0]);
        } catch (err) {
            next(err);
        }
    }
);

// ── DELETE /documents/:id ──────────────────────────────────────────────────
router.delete('/documents/:id', authenticate, authorize(...ALLOWED_ROLES), async (req, res, next) => {
    try {
        const result = await query(
            `DELETE FROM lead_documents WHERE id = $1 RETURNING id, lead_id`,
            [req.params.id]
        );
        if (!result.rows.length) return res.status(404).json({ error: 'document_not_found' });
        res.json({ ok: true, ...result.rows[0] });
    } catch (err) {
        next(err);
    }
});

// ── Follow-ups ─────────────────────────────────────────────────────────────

router.get('/leads/:id/follow-ups', authenticate, authorize(...ALLOWED_ROLES), async (req, res, next) => {
    try {
        const rows = await fetchLeadFollowUps(req.params.id);
        res.json(rows);
    } catch (err) {
        next(err);
    }
});

router.post('/leads/:id/follow-ups', authenticate, authorize(...ALLOWED_ROLES), async (req, res, next) => {
    try {
        const { due_at, note } = req.body || {};
        if (!due_at) return res.status(400).json({ error: 'due_at_required' });

        const result = await query(
            `INSERT INTO lead_follow_ups (lead_id, due_at, note, created_by)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [req.params.id, due_at, note || null, req.user.id]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        next(err);
    }
});

router.patch('/follow-ups/:id', authenticate, authorize(...ALLOWED_ROLES), async (req, res, next) => {
    try {
        const { status, note, due_at } = req.body || {};
        const setClauses = [];
        const values = [];
        if (status) {
            values.push(status);
            setClauses.push(`status = $${values.length}`);
            if (status === 'completed') {
                setClauses.push(`completed_at = NOW()`);
            }
        }
        if (note !== undefined) {
            values.push(note);
            setClauses.push(`note = $${values.length}`);
        }
        if (due_at) {
            values.push(due_at);
            setClauses.push(`due_at = $${values.length}`);
        }
        if (!setClauses.length) return res.status(400).json({ error: 'no_fields' });

        values.push(req.params.id);
        const result = await query(
            `UPDATE lead_follow_ups SET ${setClauses.join(', ')}
             WHERE id = $${values.length} RETURNING *`,
            values
        );
        if (!result.rows.length) return res.status(404).json({ error: 'follow_up_not_found' });
        res.json(result.rows[0]);
    } catch (err) {
        next(err);
    }
});

// Today's callback queue for the assigned agent (or all if admin/sourcing).
router.get('/follow-ups/due', authenticate, authorize(...ALLOWED_ROLES), async (req, res, next) => {
    try {
        const params = [];
        let agentFilter = '';
        if (req.user.role === 'marketing_agent') {
            params.push(req.user.id);
            agentFilter = `AND (ml.assigned_agent_id = $${params.length} OR ml.assigned_agent_id IS NULL)`;
        }
        const result = await query(
            `SELECT lf.*, ml.full_name as lead_name, ml.phone as lead_phone, ml.stage as lead_stage
             FROM lead_follow_ups lf
             JOIN marketing_leads ml ON lf.lead_id = ml.id
             WHERE lf.status = 'pending' AND lf.due_at <= NOW() + INTERVAL '1 day'
               ${agentFilter}
             ORDER BY lf.due_at ASC LIMIT 100`,
            params
        );
        res.json(result.rows);
    } catch (err) {
        next(err);
    }
});

// ── POST /leads/:id/send-template ──────────────────────────────────────────
router.post('/leads/:id/send-template', authenticate, authorize(...ALLOWED_ROLES), async (req, res, next) => {
    try {
        const { template_key, channel } = req.body || {};
        if (!LEAD_TEMPLATES[template_key]) {
            return res.status(400).json({ error: 'unknown_template', allowed: Object.keys(LEAD_TEMPLATES) });
        }
        if (!['whatsapp', 'sms'].includes(channel)) {
            return res.status(400).json({ error: 'invalid_channel' });
        }

        const lead = await fetchLeadById(req.params.id);
        if (!lead) return res.status(404).json({ error: 'lead_not_found' });

        const body = renderTemplate(LEAD_TEMPLATES[template_key].body, {
            name: lead.full_name,
            phone: lead.phone,
            job_part: buildJobPart(lead.preferred_job_title, lead.preferred_job_text),
        });

        let result;
        if (channel === 'whatsapp') {
            result = await whatsapp.sendTextMessage(lead.phone, body);
        } else {
            result = await sms.sendSMS(lead.phone, body.substring(0, 480));
        }

        await query(
            `UPDATE marketing_leads SET last_contacted_at = NOW(), updated_at = NOW() WHERE id = $1`,
            [lead.id]
        );

        res.json({ ok: true, channel, template_key, provider_result: result });
    } catch (err) {
        logger.warn(`marketing-hub send-template error: ${err.message}`);
        next(err);
    }
});

// Template catalog so the frontend can render the dropdown without hardcoding.
router.get('/templates', authenticate, authorize(...ALLOWED_ROLES), (_req, res) => {
    res.json(
        Object.entries(LEAD_TEMPLATES).map(([key, t]) => ({ key, label: t.label, preview: t.body }))
    );
});

// ── POST /leads/:id/convert ────────────────────────────────────────────────
// Transactional: creates a candidates row, copies the lead's primary CV into
// cv_files, optionally creates an applications row when preferred_job_id is set,
// and flips the lead to stage='converted'. If any step fails the entire
// operation rolls back and the lead stays in its previous stage.
router.post('/leads/:id/convert', authenticate, authorize(...ALLOWED_ROLES), async (req, res, next) => {
    try {
        const leadId = req.params.id;
        const { create_application = true, job_id_override } = req.body || {};

        const lead = await fetchLeadById(leadId);
        if (!lead) return res.status(404).json({ error: 'lead_not_found' });
        if (lead.converted_candidate_id) {
            return res.status(409).json({ error: 'already_converted', candidate_id: lead.converted_candidate_id });
        }

        const targetJobId = job_id_override || lead.preferred_job_id || null;

        const result = await withTransaction(async (client) => {
            // 1. Insert candidate. Reuse existing columns where possible.
            const candidateInsert = await client.query(
                `INSERT INTO candidates (name, phone, source, preferred_language, notes, status, metadata)
                 VALUES ($1, $2, 'marketing_hub', 'en', $3, 'new', $4)
                 RETURNING id`,
                [
                    lead.full_name,
                    lead.phone,
                    lead.remarks || null,
                    JSON.stringify({
                        marketing_lead_id: lead.id,
                        nic: lead.nic,
                        dob: lead.dob,
                        country: lead.country,
                        preferred_job_text: lead.preferred_job_text,
                        source_slug: lead.source_slug,
                        campaign_ref: lead.campaign_ref,
                    }),
                ]
            );
            const candidateId = candidateInsert.rows[0].id;

            // 2. Copy the lead's most recent CV document into cv_files (if any).
            const cvDocs = await client.query(
                `SELECT url, name, mime_type FROM lead_documents
                 WHERE lead_id = $1 AND doc_type = 'cv'
                 ORDER BY uploaded_at DESC LIMIT 1`,
                [leadId]
            );
            if (cvDocs.rows.length) {
                const cv = cvDocs.rows[0];
                const ext = (cv.name.split('.').pop() || 'pdf').toLowerCase();
                await client.query(
                    `INSERT INTO cv_files (candidate_id, file_url, file_name, file_type, ocr_status, is_primary)
                     VALUES ($1, $2, $3, $4, 'pending', TRUE)`,
                    [candidateId, cv.url, cv.name, ext]
                );
            }

            // 3. Optional: create an application row when a target job is set.
            let applicationId = null;
            if (create_application && targetJobId) {
                const appInsert = await client.query(
                    `INSERT INTO applications (candidate_id, job_id, status)
                     VALUES ($1, $2, 'applied') RETURNING id`,
                    [candidateId, targetJobId]
                );
                applicationId = appInsert.rows[0].id;
            }

            // 4. Mark the lead converted.
            await client.query(
                `UPDATE marketing_leads
                 SET stage = 'converted', converted_candidate_id = $1, converted_at = NOW(), updated_at = NOW()
                 WHERE id = $2`,
                [candidateId, leadId]
            );

            return { candidateId, applicationId };
        });

        res.status(201).json({
            ok: true,
            lead_id: leadId,
            candidate_id: result.candidateId,
            application_id: result.applicationId,
        });
    } catch (err) {
        logger.error(`marketing-hub convert error: ${err.message}`);
        next(err);
    }
});

// ── GET /lookup?phone=… ─────────────────────────────────────────────────────
// Endpoint consumed by the 3CX CRM template for caller-ID screen-pop.
// Auth: shared secret via X-3cx-Token header (not JWT). Returns the lead
// detail URL the 3CX Web Client should open. Returns 404 when unknown so
// 3CX renders a default "unknown caller" experience.
router.get('/lookup', async (req, res) => {
    const expected = process.env.THREECX_WEBHOOK_TOKEN;
    if (!expected) {
        return res.status(503).json({ error: 'lookup_disabled' });
    }
    if (req.headers['x-3cx-token'] !== expected) {
        return res.status(401).json({ error: 'unauthorized' });
    }

    const phone = String(req.query.phone || '').trim();
    if (!phone) return res.status(400).json({ error: 'phone_required' });

    const normalized = normalizePhone(phone) || phone;
    const result = await query(
        `SELECT id, full_name FROM marketing_leads WHERE phone = $1 LIMIT 1`,
        [normalized]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'not_found' });

    const frontendUrl = process.env.MARKETING_HUB_FRONTEND_URL || '';
    res.json({
        ContactName: result.rows[0].full_name,
        ContactUrl: `${frontendUrl}/marketing-hub/${result.rows[0].id}`,
    });
});

module.exports = router;
