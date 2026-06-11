/**
 * Communications Route
 * ====================
 * Full chat transcript, agent send, and live handoff/release endpoints.
 *
 * Routes:
 *   GET  /api/communications/candidate/:id              — full transcript
 *   GET  /api/communications/candidate/:id/notifications— outbound notifications
 *   GET  /api/communications/active-chats               — list of active whatsapp convos
 *   POST /api/communications/escalate                   — chatbot escalation alert
 *   POST /api/communications/send                       — agent sends a message
 *   POST /api/communications/candidate/:id/takeover     — agent takes over from bot
 *   POST /api/communications/candidate/:id/release      — release back to bot
 *   POST /api/communications/send-bulk                  — bulk notification
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const { query, generateUUID } = require('../config/database');
const { adaptQuery } = require('../utils/query-adapter');
const { isMySQL } = require('../utils/query-adapter');
const { authenticate } = require('../middleware/auth');
const { requireSection } = require('../middleware/sections');
const { normalizePhone } = require('../utils/phone');
const logger = require('../utils/logger');
const { uploadToGCS } = require('../utils/gcs-upload');
const { setCandidateStage, emitStageChanged } = require('../services/candidate-stage');
const { openClaimSession, closeClaimSession, getOpenClaimSessionId } = require('../services/claim-sessions');
const {
    EFF_PROJECT_ID_EXPR,
    PIPELINE_STAGE_EXPR,
    buildConversationFilters,
    buildCandidateStatusCountsSql,
    shapeCountsRow,
} = require('../services/conversation-counts');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 },
});

// Agent call outcomes / lead statuses (app-validated; no DB CHECK constraint).
const DISPOSITIONS = ['new', 'attempted', 'contacted', 'interested', 'callback', 'not_interested', 'qualified', 'unreachable'];
const CALL_OUTCOMES = ['answered', 'no_answer', 'busy', 'callback', 'wrong_number', 'note', 'not_interested'];
// Candidate statuses a call outcome may set: the forward pipeline ("Done → advance":
// New→Screening / Screening→Certified / Certified→Interview Scheduled) plus the
// decline outcome (Not interested → future_pool, UPGRADES.md #1: there is no
// candidate-level 'rejected'). Forward stages cascade through setCandidateStage();
// a decline rejects the active application(s) and moves the candidate to future_pool
// (CV-gated to New if no CV). 'rejected' is still accepted as a legacy input alias
// for the decline so older clients don't break.
const FORWARD_STAGE_TARGETS = ['screening', 'certified', 'interview_scheduled'];
const CALL_STATUS_TARGETS = [...FORWARD_STAGE_TARGETS, 'future_pool', 'rejected'];
const isDeclineStatus = (s) => s === 'future_pool' || s === 'rejected';
// Follow-up task types an agent action may open (no_answer powers the Engagement catch-up list).
const FOLLOWUP_TASK_TYPES = ['callback', 'no_answer'];

const ALLOWED_MEDIA_MIME_PREFIXES = ['image/', 'audio/', 'video/'];
const ALLOWED_DOC_MIME_TYPES = new Set([
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
]);

function sanitizeFileName(name) {
    return String(name || 'upload.bin').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function detectMediaType(mimeType, requestedType) {
    if (requestedType && ['image', 'audio', 'document', 'video'].includes(requestedType)) {
        return requestedType;
    }

    if (mimeType?.startsWith('image/')) return 'image';
    if (mimeType?.startsWith('audio/')) return 'audio';
    if (mimeType?.startsWith('video/')) return 'video';
    return 'document';
}

function validateMediaMime(file) {
    if (!file?.mimetype) return false;
    if (ALLOWED_MEDIA_MIME_PREFIXES.some(prefix => file.mimetype.startsWith(prefix))) return true;
    return ALLOWED_DOC_MIME_TYPES.has(file.mimetype);
}

function normalizeSortOrder(sortBy) {
    if (String(sortBy || '').toLowerCase() === 'latest_asc') return 'ASC';
    return 'DESC';
}

async function uploadCommunicationMedia(file, candidateId) {
    const safeName = sanitizeFileName(file.originalname);
    const objectName = `communications/${candidateId}/${Date.now()}_${safeName}`;
    const mediaUrl = await uploadToGCS(file.buffer, objectName, file.mimetype || 'application/octet-stream');
    if (!mediaUrl) {
        throw new Error('Media upload failed. Check GCS configuration and bucket permissions.');
    }
    return mediaUrl;
}

async function insertCommunicationMessage({
    id,
    candidateId,
    channel,
    direction,
    messageType,
    content,
    sentBy,
    senderType,
    senderName,
    attachmentsValue,
    metadataValue,
    callRecordingUrl,
    whatsappMessageId,
    claimSessionId,
}) {
    try {
        await query(
            adaptQuery(`INSERT INTO communications
                (id, candidate_id, channel, direction, message_type, content,
                 attachments, metadata, call_recording_url,
                 sent_by, sender_type, sender_name, whatsapp_message_id, claim_session_id)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`),
            [
                id,
                candidateId,
                channel,
                direction,
                messageType,
                content,
                isMySQL ? JSON.stringify(attachmentsValue || []) : (attachmentsValue || []),
                metadataValue || '{}',
                callRecordingUrl || null,
                sentBy || null,
                senderType || null,
                senderName || null,
                whatsappMessageId || null,
                claimSessionId || null,
            ]
        );
    } catch (err) {
        const msg = String(err?.message || '').toLowerCase();
        const schemaMismatch = msg.includes('column') || msg.includes('does not exist') || msg.includes('unknown column');
        if (!schemaMismatch) throw err;

        await query(
            adaptQuery(`INSERT INTO communications
                (id, candidate_id, channel, direction, message_type, content, sent_by)
                VALUES ($1, $2, $3, $4, $5, $6, $7)`),
            [id, candidateId, channel, direction, messageType, content, sentBy || null]
        );
    }
}

/**
 * Resolve the most relevant job application and upcoming interview for a candidate.
 * Used to pre-populate the default outreach message in the portal.
 */
async function getCandidateMessageContext(candidateId) {
    const appResult = await query(
        adaptQuery(`
            SELECT a.id AS application_id, j.title AS job_title,
                   SUBSTRING(COALESCE(j.description, ''), 1, 300) AS job_description_snippet,
                   a.status AS application_status
            FROM applications a
            JOIN jobs j ON j.id = a.job_id
            WHERE a.candidate_id = $1
              AND LOWER(a.status) NOT IN ('rejected', 'withdrawn')
            ORDER BY COALESCE(a.updated_at, a.applied_at) DESC
            LIMIT 1
        `),
        [candidateId]
    );

    // Prefer next upcoming interview; fall back to most recent past one.
    // Production schema stores interviews in interview_schedules linked via applications.
    const upcomingResult = await query(
        adaptQuery(`
            SELECT iv.id,
                   j.title AS interview_job_title,
                   iv.scheduled_datetime,
                   iv.location,
                   iv.status
            FROM interview_schedules iv
            JOIN applications a ON a.id = iv.application_id
            LEFT JOIN jobs j ON j.id = a.job_id
            WHERE a.candidate_id = $1
              AND iv.scheduled_datetime >= NOW()
              AND iv.status NOT IN ('cancelled', 'rejected')
            ORDER BY iv.scheduled_datetime ASC
            LIMIT 1
        `),
        [candidateId]
    );

    let interview = upcomingResult.rows[0] || null;

    if (!interview) {
        const pastResult = await query(
            adaptQuery(`
                SELECT iv.id,
                       j.title AS interview_job_title,
                       iv.scheduled_datetime,
                       iv.location,
                       iv.status
                FROM interview_schedules iv
                JOIN applications a ON a.id = iv.application_id
                LEFT JOIN jobs j ON j.id = a.job_id
                WHERE a.candidate_id = $1
                ORDER BY iv.scheduled_datetime DESC
                LIMIT 1
            `),
            [candidateId]
        );
        interview = pastResult.rows[0] || null;
    }

    return {
        application: appResult.rows[0] || null,
        interview,
    };
}

function authenticateChatbot(req, res, next) {
    const apiKey = req.headers['x-chatbot-api-key'];
    const expectedKey = process.env.CHATBOT_API_KEY;
    const expectedOldKey = process.env.CHATBOT_API_KEY_OLD;

    if (!expectedKey) {
        logger.error('CHATBOT_API_KEY not set in environment!');
        return res.status(500).json({ error: 'Server misconfiguration: chatbot key not set' });
    }

    if (!apiKey) {
        return res.status(401).json({ error: 'Unauthorized: missing chatbot API key' });
    }

    if (apiKey === expectedKey || (expectedOldKey && apiKey === expectedOldKey)) {
        return next();
    }

    return res.status(401).json({ error: 'Unauthorized: invalid chatbot API key' });
}

// ── GET /api/communications/candidate/:id ─────────────────────────────────────
// Returns the candidate's chronological transcript.
router.get('/candidate/:candidate_id', authenticate, requireSection('communications', 'view'), async (req, res, next) => {
    try {
        const { candidate_id } = req.params;
        const { channel, limit = 5000, date_from, date_to, response_status } = req.query;

        const params = [candidate_id];
        let sql = adaptQuery(
            `SELECT c.*, u.full_name AS agent_name
             FROM communications c
             LEFT JOIN users u ON u.id = c.sent_by
             WHERE c.candidate_id = $1`
        );

        if (channel) {
            params.push(channel);
            sql += adaptQuery(` AND c.channel = $${params.length}`);
        }

        if (date_from) {
            params.push(date_from);
            sql += adaptQuery(` AND c.sent_at >= $${params.length}`);
        }

        if (date_to) {
            params.push(date_to);
            sql += adaptQuery(` AND c.sent_at <= $${params.length}`);
        }

        if (response_status === 'awaiting_candidate') {
            sql += ` AND c.direction = 'outbound'`;
        } else if (response_status === 'awaiting_agent') {
            sql += ` AND c.direction = 'inbound'`;
        }

        sql += ` ORDER BY c.sent_at ASC LIMIT ${Math.min(Math.max(parseInt(limit, 10) || 5000, 1), 5000)}`;

        const result = await query(sql, params);
        res.json(result.rows);
    } catch (error) {
        next(error);
    }
});

// ── GET /api/communications/history/:phone ───────────────────────────────────
// Compatibility endpoint for phone-based transcript loading.
router.get('/history/:phone', authenticate, requireSection('communications', 'view'), async (req, res, next) => {
    try {
        const rawPhone = String(req.params.phone || '').trim();
        if (!rawPhone) {
            return res.status(400).json({ error: 'phone is required' });
        }

        const normalizedPhone = rawPhone.replace(/[\s\-()]/g, '');
        const candidateResult = await query(
            adaptQuery(`
                SELECT id
                FROM candidates
                WHERE phone = $1 OR whatsapp_phone = $1
                ORDER BY updated_at DESC
                LIMIT 1
            `),
            [normalizedPhone]
        );

        if (candidateResult.rows.length === 0) {
            return res.json({ messages: [] });
        }

        const candidateId = candidateResult.rows[0].id;
        const transcript = await query(
            adaptQuery(`
                SELECT id, direction, message_type, content,
                       COALESCE(sender_type, CASE WHEN direction = 'inbound' THEN 'candidate' ELSE 'agent' END) AS sender,
                       sent_at,
                       attachments
                FROM communications
                WHERE candidate_id = $1
                ORDER BY sent_at ASC
                LIMIT 5000
            `),
            [candidateId]
        );

        return res.json({
            candidate_id: candidateId,
            messages: transcript.rows.map((m) => ({
                id: m.id,
                sender: m.sender,
                text: m.content,
                direction: m.direction,
                message_type: m.message_type,
                attachments: m.attachments,
                timestamp: m.sent_at,
            })),
        });
    } catch (error) {
        next(error);
    }
});

// ── GET /api/communications/candidate/:id/notifications ──────────────────────
router.get('/candidate/:candidate_id/notifications', authenticate, requireSection('communications', 'view'), async (req, res, next) => {
    try {
        const { candidate_id } = req.params;
        const result = await query(
            adaptQuery(`
                SELECT *,
                    metadata->>'notification_type' AS notification_type
                FROM communications
                WHERE candidate_id = $1
                  AND direction = 'outbound'
                ORDER BY sent_at DESC
                LIMIT 50
            `),
            [candidate_id]
        );
        res.json(result.rows);
    } catch (error) {
        next(error);
    }
});

// ── GET /api/communications/candidate/:id/context ────────────────────────────
// Returns the latest active application (job title + short description) and
// nearest interview for the candidate. Used by the portal to prefill messages.
router.get('/candidate/:candidate_id/context', authenticate, requireSection('communications', 'view'), async (req, res, next) => {
    try {
        const { candidate_id } = req.params;
        const context = await getCandidateMessageContext(candidate_id);
        res.json(context);
    } catch (error) {
        next(error);
    }
});

// ── GET /api/communications/active-chats ──────────────────────────────────────
// Returns one row per candidate with WhatsApp conversation history,
// sorted by most recent message. Used to populate the chat list panel.
router.get('/active-chats', authenticate, requireSection('communications', 'view'), async (req, res, next) => {
    try {
        const {
            search = '',
            // Default to a screenful-plus rather than the whole table — this is a
            // heavy 9-LEFT-JOIN + DISTINCT ON query and the list is scrolled from
            // the top. HARD-capped at 500 below: the legacy client asks for 5000
            // (~3.4 MB per poll), which — every 30s × every agent on ONE pinned
            // instance — saturated the DB pool and cascaded into 500s. The list is
            // sorted most-recent-first and search/filter is server-side, so 500 is
            // ample for the working set.
            limit = 200,
            date_from,
            date_to,
            status,
            project_id,
            response_status,
            pipeline_stage,
            handoff_state,
            sort_by = 'latest_desc',
        } = req.query;

        const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 500);
        const params = [];
        const filters = [];
        // Effective project/job = the candidate's latest application's project/job,
        // falling back to the CTWA ad they arrived on (ad_tracking) so brand-new
        // leads with no application yet still resolve to the project they asked
        // about. Used in BOTH the SELECT and the WHERE — Postgres can't reference
        // a SELECT alias in WHERE, so these are raw expressions.
        // Project/job/pipeline display expressions for the SELECT. The project-id
        // and pipeline-stage exprs are imported from the shared counts module so
        // the SELECT and the WHERE (built by buildConversationFilters) can't drift.
        const effProjectIdExpr    = EFF_PROJECT_ID_EXPR;
        const effProjectTitleExpr = `COALESCE(NULLIF(la.project_title, ''), adt.project_title)`;
        const effJobTitleExpr      = `COALESCE(NULLIF(la.job_title, ''), adt.job_title)`;
        const effJobIdExpr         = `COALESCE(la.job_id, adt.job_id)`;
        const pipelineStageExpr = PIPELINE_STAGE_EXPR;
        const addParam = (value) => {
            params.push(value);
            return isMySQL ? '?' : `$${params.length}`;
        };

        // All WHERE predicates (search/status-bucket/project/pipeline/handoff/
        // disposition/call/contacted/claim/date/response + the lm.sent_at
        // conversation gate) come from the shared builder so the list, the
        // counts, and the Applications strip count the exact same population.
        filters.push(...buildConversationFilters({
            query: req.query,
            userId: req.user.id,
            addParam,
            includeStatusBucket: true,
        }));

        const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
        const latestOrder = normalizeSortOrder(sort_by);

        const sql = adaptQuery(`
            SELECT
                ca.id            AS candidate_id,
                ca.name,
                ca.phone,
                ca.whatsapp_phone,
                ca.email,
                ca.preferred_language,
                ca.notes,
                ca.tags,
                ca.status        AS candidate_status,
                ca.conversation_stage,
                ca.cv_uploaded,
                ca.cv_status,
                ca.last_interaction,
                ca.ai_status,
                ca.requires_human,
                ca.escalated_at,
                ca.escalation_reason,
                ca.is_human_handoff,
                ca.agent_id,
                ca.call_status,
                ca.call_agent_id,
                ca.call_started_at,
                cu.full_name     AS call_agent_name,
                ca.disposition,
                ca.disposition_at,
                ca.last_contacted_at,
                ca.claimed_by,
                clu.full_name    AS claimer_name,
                COALESCE(la.application_status, '') AS latest_application_status,
                COALESCE(la.job_title, '') AS latest_job_title,
                COALESCE(la.job_category, '') AS latest_job_category,
                COALESCE(la.job_country, '') AS latest_job_country,
                COALESCE(la.project_title, '') AS latest_project_title,
                la.project_id    AS latest_project_id,
                ${effProjectIdExpr}    AS effective_project_id,
                COALESCE(${effProjectTitleExpr}, '') AS effective_project_title,
                COALESCE(${effJobTitleExpr}, '')     AS effective_job_title,
                ${effJobIdExpr}    AS effective_job_id,
                u.full_name      AS agent_name,
                lm.content       AS last_message,
                lm.direction     AS last_direction,
                lm.sender_type   AS last_sender_type,
                lm.detected_language AS last_language,
                lm.chatbot_state AS last_chatbot_state,
                lm.sent_at       AS last_message_at,
                COALESCE(NULLIF(ca.name, ''), NULLIF(ca.whatsapp_phone, ''), ca.phone) AS display_name,
                ${pipelineStageExpr} AS pipeline_stage,
                CASE
                    WHEN lm.direction = 'outbound' THEN 'awaiting_candidate'
                    ELSE 'awaiting_agent'
                END AS response_status
            FROM candidates ca
            LEFT JOIN (
                SELECT DISTINCT ON (candidate_id)
                    candidate_id,
                    content,
                    direction,
                    NULL AS sender_type,
                    NULL AS detected_language,
                    NULL AS chatbot_state,
                    read_at,
                    delivered_at,
                    sent_at
                FROM communications
                WHERE channel = 'whatsapp'
                ORDER BY candidate_id, sent_at DESC
            ) lm ON lm.candidate_id = ca.id
            LEFT JOIN (
                SELECT DISTINCT ON (a.candidate_id)
                    a.candidate_id,
                    a.status AS application_status,
                    a.job_id   AS job_id,
                    j.title    AS job_title,
                    j.category AS job_category,
                    j.country  AS job_country,
                    j.project_id AS project_id,
                    p.title    AS project_title,
                    COALESCE(a.updated_at, a.applied_at) AS last_application_at
                FROM applications a
                LEFT JOIN jobs j ON j.id = a.job_id
                LEFT JOIN projects p ON p.id = j.project_id
                ORDER BY a.candidate_id, COALESCE(a.updated_at, a.applied_at) DESC
            ) la ON la.candidate_id = ca.id
            LEFT JOIN (
                SELECT t.ad_ref, t.project_id, t.job_id, p.title AS project_title, j.title AS job_title
                FROM ad_tracking t
                LEFT JOIN projects p ON p.id = t.project_id
                LEFT JOIN jobs j ON j.id = t.job_id
            ) adt ON adt.ad_ref = ca.ad_ref
            LEFT JOIN users u ON u.id = ca.agent_id
            LEFT JOIN users cu ON cu.id = ca.call_agent_id
            LEFT JOIN users clu ON clu.id = ca.claimed_by
            ${whereClause}
            ORDER BY COALESCE(lm.sent_at, ca.created_at) ${latestOrder}
            LIMIT ${safeLimit}
        `);

        const result = await query(sql, params);
        // The list is HARD-capped at 500 (see safeLimit) to protect the DB pool.
        // When we hit the cap the per-tab badge (from /counts, uncapped) will read
        // higher than the rows returned here — signal that so the UI can show
        // "500+ shown" instead of a silent badge≠list mismatch.
        if (result.rows.length >= safeLimit) {
            res.set('X-List-Truncated', 'true');
        }
        res.json(result.rows);
    } catch (error) {
        next(error);
    }
});

// ── GET /api/communications/active-chats/counts ───────────────────────────────
// Real aggregate counts for the Conversations header pills + per-status tab
// badges. Same FROM/JOIN/WHERE semantics as active-chats, but WITHOUT the 500-row
// cap and WITHOUT the status-bucket filter — so the numbers are TRUE totals
// (the pills used to show the returned array length, which maxed out at the cap)
// and every per-status badge is counted regardless of which tab is active.
router.get('/active-chats/counts', authenticate, requireSection('communications', 'view'), async (req, res, next) => {
    try {
        const params = [];
        const addParam = (value) => { params.push(value); return isMySQL ? '?' : `$${params.length}`; };

        // Same population + filters as the list (minus the single-bucket status
        // filter, since we fan out one count per bucket here) — shared builder so
        // the badges can never diverge from the rows.
        const filters = buildConversationFilters({
            query: req.query,
            userId: req.user.id,
            addParam,
            includeStatusBucket: false,
        });
        const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

        const sql = buildCandidateStatusCountsSql({ whereClause });
        const result = await query(sql, params);
        res.json(shapeCountsRow(result.rows[0]));
    } catch (error) {
        next(error);
    }
});

// ── POST /api/communications/escalate ─────────────────────────────────────────
// Called by Python chatbot when confusion counter reaches escalation threshold.
router.post('/escalate', authenticateChatbot, async (req, res, next) => {
    try {
        const { phone, reason } = req.body || {};
        if (!phone) {
            return res.status(400).json({ error: 'phone is required' });
        }

        const candidateResult = await query(
            adaptQuery(`
                SELECT id, name, phone, whatsapp_phone
                FROM candidates
                WHERE phone = $1 OR whatsapp_phone = $1
                ORDER BY updated_at DESC
                LIMIT 1
            `),
            [phone]
        );

        if (candidateResult.rows.length === 0) {
            return res.status(404).json({ error: 'Candidate not found for phone' });
        }

        const candidate = candidateResult.rows[0];
        await query(
            adaptQuery(`
                UPDATE candidates
                SET ai_status = 'Requires Intervention',
                    requires_human = TRUE,
                    escalated_at = NOW(),
                    escalation_reason = $2,
                    updated_at = NOW()
                WHERE id = $1
            `),
            [candidate.id, reason || 'Persistent unclear inputs']
        );

        const commId = generateUUID();
        const systemMsg = `AI escalation requested: ${reason || 'Persistent unclear inputs'}`;
        await insertCommunicationMessage({
            id: commId,
            candidateId: candidate.id,
            channel: 'whatsapp',
            direction: 'outbound',
            messageType: 'text',
            content: systemMsg,
            sentBy: null,
            senderType: 'system',
            senderName: 'System',
            attachmentsValue: [],
            metadataValue: JSON.stringify({ source: 'escalate' }),
            callRecordingUrl: null,
        });

        try {
            const { getIO } = require('../utils/websocket');
            const io = getIO();
            if (io) {
                const eventPayload = {
                    candidate_id: candidate.id,
                    phone,
                    alert: 'AI Handoff Requested',
                    reason: reason || 'Persistent unclear inputs',
                };
                io.emit('chat_escalated', eventPayload);
                io.emit('chat_activity', {
                    candidate_id: candidate.id,
                    candidate_name: candidate.name,
                    ai_status: 'Requires Intervention',
                    requires_human: true,
                    ts: new Date().toISOString(),
                });
            }
        } catch (wsErr) {
            logger.debug(`escalate WS emit skipped: ${wsErr.message}`);
        }

        logger.info(`Chat escalated for candidate ${candidate.id} (${phone})`);
        return res.status(200).json({ success: true, message: 'Chat escalated to human agents.', candidate_id: candidate.id });
    } catch (error) {
        next(error);
    }
});

// ── POST /api/communications/status-sync ─────────────────────────────────────
// Called by chatbot webhook worker to persist WhatsApp delivery/read updates.
router.post('/status-sync', authenticateChatbot, async (req, res, next) => {
    try {
        const {
            whatsapp_message_id,
            status,
            recipient_id,
            timestamp,
            metadata,
        } = req.body || {};

        if (!whatsapp_message_id || !status) {
            return res.status(400).json({ error: 'whatsapp_message_id and status are required' });
        }

        const normalizedStatus = String(status).toLowerCase();
        if (!['sent', 'delivered', 'read', 'failed'].includes(normalizedStatus)) {
            return res.status(400).json({ error: 'status must be one of: sent, delivered, read, failed' });
        }

        const eventTime = timestamp ? new Date(Number(timestamp) * 1000) : new Date();
        const isValidDate = !Number.isNaN(eventTime.getTime());
        const finalEventTime = isValidDate ? eventTime : new Date();

        const updateBits = [];
        const updateParams = [];
        const addParam = (value) => {
            updateParams.push(value);
            return isMySQL ? '?' : `$${updateParams.length}`;
        };

        if (normalizedStatus === 'sent') {
            const sentAtPlaceholder = addParam(finalEventTime.toISOString());
            updateBits.push(`sent_at = COALESCE(sent_at, ${sentAtPlaceholder})`);
        }
        if (normalizedStatus === 'delivered') {
            const deliveredAtPlaceholder = addParam(finalEventTime.toISOString());
            updateBits.push(`delivered_at = COALESCE(delivered_at, ${deliveredAtPlaceholder})`);
        }
        if (normalizedStatus === 'read') {
            const readAtPlaceholder = addParam(finalEventTime.toISOString());
            updateBits.push(`read_at = COALESCE(read_at, ${readAtPlaceholder})`);
        }

        const metadataPlaceholder = addParam(JSON.stringify({
            latest_status: normalizedStatus,
            status_recipient_id: recipient_id || null,
            status_timestamp: finalEventTime.toISOString(),
            ...(metadata && typeof metadata === 'object' ? metadata : {}),
        }));
        if (isMySQL) {
            updateBits.push(`metadata = ${metadataPlaceholder}`);
        } else {
            updateBits.push(`metadata = COALESCE(metadata, '{}'::jsonb) || ${metadataPlaceholder}::jsonb`);
        }

        const messageIdPlaceholder = addParam(whatsapp_message_id);
        const metadataMessageIdClause = isMySQL
            ? `JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.whatsapp_message_id')) = ${messageIdPlaceholder}`
            : `metadata->>'whatsapp_message_id' = ${messageIdPlaceholder}`;
        const updateSql = adaptQuery(`
            UPDATE communications
            SET ${updateBits.join(', ')}
            WHERE whatsapp_message_id = ${messageIdPlaceholder}
               OR ${metadataMessageIdClause}
        `);

        const updateResult = await query(updateSql, updateParams);
        const updatedRows = Number(updateResult.rowCount || 0);

        return res.json({
            success: true,
            status: normalizedStatus,
            whatsapp_message_id,
            updated_rows: updatedRows,
            matched: updatedRows > 0,
        });
    } catch (error) {
        next(error);
    }
});

// ── GET /api/communications/delivery-audit ──────────────────────────────────
router.get('/delivery-audit', authenticate, requireSection('communications', 'view'), async (req, res, next) => {
    try {
        const {
            date_from,
            date_to,
            channel = 'whatsapp',
        } = req.query;

        const params = [];
        const filters = ["direction = 'outbound'"];
        const addParam = (value) => {
            params.push(value);
            return isMySQL ? '?' : `$${params.length}`;
        };

        if (channel) {
            const channelPlaceholder = addParam(channel);
            filters.push(`channel = ${channelPlaceholder}`);
        }
        if (date_from) {
            const fromPlaceholder = addParam(date_from);
            filters.push(`sent_at >= ${fromPlaceholder}`);
        }
        if (date_to) {
            const toPlaceholder = addParam(date_to);
            filters.push(`sent_at <= ${toPlaceholder}`);
        }

        const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
        const sql = adaptQuery(`
            SELECT
                COUNT(*) AS total_sent,
                SUM(CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS delivered,
                SUM(CASE WHEN read_at IS NOT NULL THEN 1 ELSE 0 END) AS read,
                SUM(CASE WHEN message_type IN ('image', 'audio', 'video', 'document', 'voice') THEN 1 ELSE 0 END) AS media_sent,
                SUM(CASE WHEN message_type IN ('image', 'audio', 'video', 'document', 'voice') AND delivered_at IS NOT NULL THEN 1 ELSE 0 END) AS media_delivered
            FROM communications
            ${whereClause}
        `);

        const result = await query(sql, params);
        const row = result.rows[0] || {};
        const total = Number(row.total_sent || 0);
        const delivered = Number(row.delivered || 0);
        const read = Number(row.read || 0);

        return res.json({
            channel,
            date_from: date_from || null,
            date_to: date_to || null,
            totals: {
                total_sent: total,
                delivered,
                read,
                media_sent: Number(row.media_sent || 0),
                media_delivered: Number(row.media_delivered || 0),
                delivery_rate: total > 0 ? Number(((delivered / total) * 100).toFixed(2)) : 0,
                read_rate: total > 0 ? Number(((read / total) * 100).toFixed(2)) : 0,
            },
        });
    } catch (error) {
        next(error);
    }
});

// ── POST /api/communications/candidate/:id/takeover ───────────────────────────
// Mark candidate as under human control. Bot will stop responding.
router.post('/candidate/:candidate_id/takeover', authenticate, requireSection('communications', 'edit'), async (req, res, next) => {
    try {
        const { candidate_id } = req.params;
        const agentId = req.user.id;

        // Check candidate exists
        const candResult = await query(
            adaptQuery('SELECT id, name, is_human_handoff FROM candidates WHERE id = $1'),
            [candidate_id]
        );
        if (candResult.rows.length === 0) {
            return res.status(404).json({ error: 'Candidate not found' });
        }
        if (candResult.rows[0].is_human_handoff) {
            return res.status(409).json({ error: 'Candidate is already under human control', agent_id: candResult.rows[0].agent_id });
        }

        // Set handoff flag
        await query(
            adaptQuery(`UPDATE candidates SET is_human_handoff = TRUE, agent_id = $1,
                        handoff_at = NOW(), handoff_released_at = NULL, updated_at = NOW()
                        WHERE id = $2`),
            [agentId, candidate_id]
        );

        // Log a system message in the chat
        const commId = generateUUID();
        await insertCommunicationMessage({
            id: commId,
            candidateId: candidate_id,
            channel: 'whatsapp',
            direction: 'outbound',
            messageType: 'text',
            content: `🙋 Agent ${req.user.full_name || req.user.email} has taken over the conversation.`,
            sentBy: req.user.id,
            senderType: 'system',
            senderName: 'System',
            attachmentsValue: [],
            metadataValue: JSON.stringify({ source: 'takeover' }),
            callRecordingUrl: null,
        });

        // Emit WebSocket notification
        try {
            const { getIO } = require('../utils/websocket');
            const io = getIO();
            if (io) {
                io.to(`candidate:${candidate_id}`).emit('handoff_start', {
                    candidate_id,
                    agent_id: agentId,
                    agent_name: req.user.full_name || req.user.email,
                    ts: new Date().toISOString(),
                });
                io.emit('chat_activity', {
                    candidate_id,
                    candidate_name: candResult.rows[0].name,
                    is_human_handoff: true,
                    ts: new Date().toISOString(),
                });
            }
        } catch (wsErr) {
            logger.debug(`takeover WS emit skipped: ${wsErr.message}`);
        }

        logger.info(`Agent ${agentId} took over candidate ${candidate_id}`);
        return res.json({ success: true, candidate_id, agent_id: agentId });
    } catch (error) {
        next(error);
    }
});

// ── POST /api/communications/candidate/:id/release ────────────────────────────
// Release candidate back to bot control.
router.post('/candidate/:candidate_id/release', authenticate, requireSection('communications', 'edit'), async (req, res, next) => {
    try {
        const { candidate_id } = req.params;

        await query(
            adaptQuery(`UPDATE candidates SET is_human_handoff = FALSE, agent_id = NULL,
                        handoff_released_at = NOW(), updated_at = NOW()
                        WHERE id = $1`),
            [candidate_id]
        );

        // System message in the chat
        const commId = generateUUID();
        await insertCommunicationMessage({
            id: commId,
            candidateId: candidate_id,
            channel: 'whatsapp',
            direction: 'outbound',
            messageType: 'text',
            content: '🤖 Bot has resumed control of the conversation.',
            sentBy: req.user.id,
            senderType: 'system',
            senderName: 'System',
            attachmentsValue: [],
            metadataValue: JSON.stringify({ source: 'release' }),
            callRecordingUrl: null,
        });

        // Emit WebSocket notification
        try {
            const { getIO } = require('../utils/websocket');
            const io = getIO();
            if (io) {
                io.to(`candidate:${candidate_id}`).emit('handoff_end', {
                    candidate_id,
                    ts: new Date().toISOString(),
                });
                io.emit('chat_activity', {
                    candidate_id,
                    is_human_handoff: false,
                    ts: new Date().toISOString(),
                });
            }
        } catch (wsErr) {
            logger.debug(`release WS emit skipped: ${wsErr.message}`);
        }

        logger.info(`Candidate ${candidate_id} released back to bot`);
        return res.json({ success: true, candidate_id });
    } catch (error) {
        next(error);
    }
});

// ── In-call presence (multi-agent calling console) ────────────────────────────
// Manual "I'm on a call" toggle for agents using an external dialer (no API).
// Soft presence + warning: starting a call on a candidate another agent is
// already calling returns 409 (the frontend warns and can retry with ?force=1).
// State lives on candidates.call_status/call_agent_id/call_started_at and is
// cleared on socket disconnect (websocket.js) + a TTL sweep (server.js).

function emitCallStatusChanged(payload) {
    try {
        const { getIO } = require('../utils/websocket');
        const io = getIO();
        if (io) io.emit('call_status_changed', { ...payload, ts: new Date().toISOString() });
    } catch (wsErr) {
        logger.debug(`call_status_changed WS emit skipped: ${wsErr.message}`);
    }
}

// ── POST /api/communications/candidate/:id/call-start ─────────────────────────
router.post('/candidate/:candidate_id/call-start', authenticate, requireSection('communications', 'edit'), async (req, res, next) => {
    try {
        const { candidate_id } = req.params;
        const force = String(req.query.force || '') === '1' || req.body?.force === true;
        const agentId = req.user.id;
        const agentName = req.user.full_name || req.user.email;

        const candResult = await query(
            adaptQuery(`SELECT ca.id, ca.name, ca.call_status, ca.call_agent_id, ca.call_started_at,
                               u.full_name AS call_agent_name
                        FROM candidates ca
                        LEFT JOIN users u ON u.id = ca.call_agent_id
                        WHERE ca.id = $1`),
            [candidate_id]
        );
        if (candResult.rows.length === 0) {
            return res.status(404).json({ error: 'Candidate not found' });
        }
        const row = candResult.rows[0];

        // Already on a call by someone else → soft conflict unless forced.
        if (!force && row.call_status === 'on_call' && row.call_agent_id && row.call_agent_id !== agentId) {
            return res.status(409).json({
                error: 'Candidate is already on a call with another agent',
                call_agent_id: row.call_agent_id,
                call_agent_name: row.call_agent_name,
                call_started_at: row.call_started_at,
            });
        }

        await query(
            adaptQuery(`UPDATE candidates SET call_status = 'on_call', call_agent_id = $1,
                        call_started_at = NOW(), updated_at = NOW() WHERE id = $2`),
            [agentId, candidate_id]
        );

        emitCallStatusChanged({
            candidate_id,
            on_call: true,
            call_agent_id: agentId,
            call_agent_name: agentName,
            call_started_at: new Date().toISOString(),
        });

        logger.info(`Agent ${agentId} started a call with candidate ${candidate_id}${force ? ' (forced)' : ''}`);
        return res.json({ success: true, candidate_id, call_agent_id: agentId, call_agent_name: agentName });
    } catch (error) {
        next(error);
    }
});

// ── POST /api/communications/candidate/:id/call-end ───────────────────────────
router.post('/candidate/:candidate_id/call-end', authenticate, requireSection('communications', 'edit'), async (req, res, next) => {
    try {
        const { candidate_id } = req.params;
        const isAdmin = req.user.role === 'admin';

        const candResult = await query(
            adaptQuery('SELECT id, call_agent_id, call_status FROM candidates WHERE id = $1'),
            [candidate_id]
        );
        if (candResult.rows.length === 0) {
            return res.status(404).json({ error: 'Candidate not found' });
        }
        const row = candResult.rows[0];
        // Only the agent on the call (or an admin) may end it.
        if (row.call_status === 'on_call' && row.call_agent_id && row.call_agent_id !== req.user.id && !isAdmin) {
            return res.status(403).json({ error: 'Only the agent on the call can end it' });
        }

        await query(
            adaptQuery(`UPDATE candidates SET call_status = NULL, call_agent_id = NULL,
                        call_started_at = NULL, updated_at = NOW() WHERE id = $1`),
            [candidate_id]
        );

        emitCallStatusChanged({ candidate_id, on_call: false });

        logger.info(`Call ended for candidate ${candidate_id} by ${req.user.id}`);
        return res.json({ success: true, candidate_id });
    } catch (error) {
        next(error);
    }
});

// ── POST /api/communications/calls/heartbeat ──────────────────────────────────
// Frontend pings every ~60s while any local call toggle is ON so the TTL sweep
// (server.js) never reaps a still-active call.
router.post('/calls/heartbeat', authenticate, requireSection('communications', 'edit'), async (req, res, next) => {
    try {
        const ids = Array.isArray(req.body?.candidate_ids) ? req.body.candidate_ids.filter(Boolean) : [];
        if (ids.length === 0) return res.json({ success: true, refreshed: 0 });

        const placeholders = ids.map((_, i) => `$${i + 2}`).join(', ');
        const result = await query(
            adaptQuery(`UPDATE candidates SET call_started_at = NOW()
                        WHERE call_status = 'on_call' AND call_agent_id = $1
                          AND id IN (${placeholders})`),
            [req.user.id, ...ids]
        );
        return res.json({ success: true, refreshed: result.rowCount || 0 });
    } catch (error) {
        next(error);
    }
});

// ── PATCH /api/communications/candidate/:id/disposition ───────────────────────
// Set the agent's call outcome / lead status. Also marks the candidate as
// agent-contacted (last_contacted_at) so the "Uncontacted" smart view shrinks.
router.patch('/candidate/:candidate_id/disposition', authenticate, requireSection('communications', 'edit'), async (req, res, next) => {
    try {
        const { candidate_id } = req.params;
        const disposition = String(req.body?.disposition || '').trim().toLowerCase();
        if (!DISPOSITIONS.includes(disposition)) {
            return res.status(400).json({ error: 'Invalid disposition', allowed: DISPOSITIONS });
        }
        const upd = await query(
            adaptQuery(`UPDATE candidates
                        SET disposition = $1, disposition_at = NOW(), disposition_by = $2,
                            last_contacted_at = NOW(), contacted_by = $2, updated_at = NOW()
                        WHERE id = $3`),
            [disposition, req.user.id, candidate_id]
        );
        if (upd.rowCount === 0) return res.status(404).json({ error: 'Candidate not found' });

        try {
            const { getIO } = require('../utils/websocket');
            const io = getIO();
            if (io) io.emit('disposition_changed', { candidate_id, disposition, ts: new Date().toISOString() });
        } catch (wsErr) {
            logger.debug(`disposition WS emit skipped: ${wsErr.message}`);
        }

        return res.json({ success: true, candidate_id, disposition });
    } catch (error) {
        next(error);
    }
});

// ── POST /api/communications/candidate/:id/claim ──────────────────────────────
// Claim a chat to yourself in the shared pool so other agents see it's taken.
router.post('/candidate/:candidate_id/claim', authenticate, requireSection('communications', 'edit'), async (req, res, next) => {
    try {
        const { candidate_id } = req.params;
        const claimerName = req.user.full_name || req.user.email;
        const upd = await query(
            adaptQuery(`UPDATE candidates SET claimed_by = $1, claimed_at = NOW(), updated_at = NOW() WHERE id = $2`),
            [req.user.id, candidate_id]
        );
        if (upd.rowCount === 0) return res.status(404).json({ error: 'Candidate not found' });
        // Audit window (migration 041): closes any previous holder's session as
        // 'reassigned' — claim transfer stays allowed, but it's recorded.
        await openClaimSession(candidate_id, req.user.id);

        try {
            const { getIO } = require('../utils/websocket');
            const io = getIO();
            if (io) io.emit('claim_changed', { candidate_id, claimed_by: req.user.id, claimer_name: claimerName, ts: new Date().toISOString() });
        } catch (wsErr) {
            logger.debug(`claim WS emit skipped: ${wsErr.message}`);
        }

        return res.json({ success: true, candidate_id, claimed_by: req.user.id, claimer_name: claimerName });
    } catch (error) {
        next(error);
    }
});

// ── POST /api/communications/candidate/:id/unclaim ────────────────────────────
router.post('/candidate/:candidate_id/unclaim', authenticate, requireSection('communications', 'edit'), async (req, res, next) => {
    try {
        const { candidate_id } = req.params;
        const cur = await query(adaptQuery('SELECT claimed_by FROM candidates WHERE id = $1'), [candidate_id]);
        if (cur.rows.length === 0) return res.status(404).json({ error: 'Candidate not found' });
        // Only the agent who claimed it (or an admin) may release the claim.
        if (cur.rows[0].claimed_by && cur.rows[0].claimed_by !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Only the agent who claimed this candidate can release it' });
        }
        await query(
            adaptQuery(`UPDATE candidates SET claimed_by = NULL, claimed_at = NULL, updated_at = NOW() WHERE id = $1`),
            [candidate_id]
        );
        // Close the audit window. 'interview_scheduled' comes from the
        // release-after-interview prompt; an admin releasing someone else's
        // claim is recorded as 'admin'.
        const requestedReason = ['manual', 'interview_scheduled'].includes(req.body?.reason) ? req.body.reason : 'manual';
        const reason = (cur.rows[0].claimed_by && cur.rows[0].claimed_by !== req.user.id && req.user.role === 'admin')
            ? 'admin' : requestedReason;
        await closeClaimSession(candidate_id, { releasedBy: req.user.id, reason });

        try {
            const { getIO } = require('../utils/websocket');
            const io = getIO();
            if (io) io.emit('claim_changed', { candidate_id, claimed_by: null, claimer_name: null, ts: new Date().toISOString() });
        } catch (wsErr) {
            logger.debug(`unclaim WS emit skipped: ${wsErr.message}`);
        }

        return res.json({ success: true, candidate_id });
    } catch (error) {
        next(error);
    }
});

// ── GET /api/communications/candidate/:id/call-logs ───────────────────────────
// The candidate's call/remark engagement history, newest first, with agent name.
router.get('/candidate/:candidate_id/call-logs', authenticate, requireSection('communications', 'view'), async (req, res, next) => {
    try {
        const { candidate_id } = req.params;
        const result = await query(
            adaptQuery(`SELECT cl.id, cl.candidate_id, cl.agent_id, cl.outcome, cl.disposition,
                               cl.remark, cl.reason, cl.duration_seconds, cl.called_at, cl.action_type,
                               cl.job_id, j.title AS job_title, p.title AS project_title,
                               u.full_name AS agent_name
                        FROM call_logs cl
                        LEFT JOIN users u ON u.id = cl.agent_id
                        LEFT JOIN jobs j ON j.id = cl.job_id
                        LEFT JOIN projects p ON p.id = j.project_id
                        WHERE cl.candidate_id = $1
                        ORDER BY cl.called_at DESC
                        LIMIT 200`),
            [candidate_id]
        );
        return res.json(result.rows);
    } catch (error) {
        next(error);
    }
});

// ── POST /api/communications/candidate/:id/call-logs ──────────────────────────
// Record a call outcome/remark and drive the "Done → advance" agent workflow:
//   - set_candidate_status: a forward stage (screening/certified/interview_scheduled)
//     cascades through setCandidateStage() so candidate.status + applications stay in
//     sync; a decline ('future_pool', or legacy alias 'rejected' = Not interested)
//     rejects the active application(s) and moves the candidate to future_pool
//     (CV-gated to New). New→Screening requires a job_id (logged) and passes the CV gate.
//   - create_followup: true (Follow-up / No answer) opens a candidate_tasks due-work
//     item; task_type 'no_answer' powers the per-agent Engagement catch-up list.
//   - reason: structured Not-interested reason, stored on the call log.
router.post('/candidate/:candidate_id/call-logs', authenticate, requireSection('communications', 'edit'), async (req, res, next) => {
    try {
        const { candidate_id } = req.params;
        const outcome = req.body?.outcome ? String(req.body.outcome).trim().toLowerCase() : null;
        const remark = req.body?.remark ? String(req.body.remark).trim() : null;
        const disposition = req.body?.disposition ? String(req.body.disposition).trim().toLowerCase() : null;
        const setStatus = req.body?.set_candidate_status ? String(req.body.set_candidate_status).trim().toLowerCase() : null;
        const reason = req.body?.reason ? String(req.body.reason).trim().slice(0, 48) : null;
        const jobId = req.body?.job_id ? String(req.body.job_id).trim() : null;
        const createFollowup = req.body?.create_followup === true;
        const followupNote = req.body?.followup_note ? String(req.body.followup_note).trim() : null;
        const taskType = FOLLOWUP_TASK_TYPES.includes(String(req.body?.task_type || '').toLowerCase())
            ? String(req.body.task_type).toLowerCase()
            : 'callback';
        const durRaw = req.body?.duration_seconds;
        const durationSeconds = Number.isFinite(Number(durRaw)) && durRaw !== null && durRaw !== '' ? parseInt(durRaw, 10) : null;

        if (!outcome && !remark && !disposition) {
            return res.status(400).json({ error: 'Provide at least an outcome, remark, or disposition' });
        }
        if (outcome && !CALL_OUTCOMES.includes(outcome)) {
            return res.status(400).json({ error: 'Invalid outcome', allowed: CALL_OUTCOMES });
        }
        if (disposition && !DISPOSITIONS.includes(disposition)) {
            return res.status(400).json({ error: 'Invalid disposition', allowed: DISPOSITIONS });
        }
        if (setStatus && !CALL_STATUS_TARGETS.includes(setStatus)) {
            return res.status(400).json({ error: 'Invalid candidate status', allowed: CALL_STATUS_TARGETS });
        }
        if (setStatus === 'screening' && !jobId) {
            return res.status(400).json({ error: 'A job must be selected to move a candidate to Screening', code: 'job_required' });
        }

        const cand = await query(adaptQuery('SELECT id, claimed_by FROM candidates WHERE id = $1'), [candidate_id]);
        if (cand.rows.length === 0) return res.status(404).json({ error: 'Candidate not found' });

        // Claim-aware credit: a log only counts toward the agent's engagement
        // stats while they hold the claim. Logging on an UNCLAIMED chat
        // auto-claims it (agents shouldn't lose credit for forgetting the
        // Claim button); a chat claimed by someone ELSE is never stolen — the
        // log saves with a NULL stamp and counts toward no one.
        let claimSessionId = null;
        const currentClaimer = cand.rows[0].claimed_by;
        if (!currentClaimer) {
            claimSessionId = await openClaimSession(candidate_id, req.user.id);
            if (claimSessionId) {
                await query(
                    adaptQuery(`UPDATE candidates SET claimed_by = $1, claimed_at = NOW(), updated_at = NOW() WHERE id = $2`),
                    [req.user.id, candidate_id]
                );
                try {
                    const { getIO } = require('../utils/websocket');
                    const io = getIO();
                    if (io) io.emit('claim_changed', { candidate_id, claimed_by: req.user.id, claimer_name: req.user.full_name || req.user.email, ts: new Date().toISOString() });
                } catch (wsErr) {
                    logger.debug(`auto-claim WS emit skipped: ${wsErr.message}`);
                }
            }
        } else if (currentClaimer === req.user.id) {
            claimSessionId = await getOpenClaimSessionId(candidate_id, req.user.id);
        }

        // New→Screening: attach the candidate to the chosen job (idempotent, mirrors
        // applications.js) so the assignment is recorded even if the CV gate blocks.
        let applicationId = null;
        if (setStatus === 'screening' && jobId) {
            const jobRes = await query(adaptQuery('SELECT id FROM jobs WHERE id = $1'), [jobId]);
            if (jobRes.rows.length === 0) return res.status(400).json({ error: 'Invalid job_id' });
            const newAppId = generateUUID();
            if (isMySQL) {
                await query(
                    "INSERT INTO applications (id, candidate_id, job_id, status) VALUES (?, ?, ?, 'screening') ON DUPLICATE KEY UPDATE job_id = VALUES(job_id)",
                    [newAppId, candidate_id, jobId]
                );
            } else {
                await query(
                    "INSERT INTO applications (id, candidate_id, job_id, status) VALUES ($1, $2, $3, 'screening') ON CONFLICT (candidate_id, job_id) DO NOTHING",
                    [newAppId, candidate_id, jobId]
                );
            }
            const appRes = await query(
                adaptQuery('SELECT id FROM applications WHERE candidate_id = $1 AND job_id = $2 LIMIT 1'),
                [candidate_id, jobId]
            );
            applicationId = appRes.rows[0]?.id || null;
        }

        // Classify the entry so the engagement log reads as the ACTION taken, not
        // "everything is a call". A genuine logged call stays 'call'.
        let actionType = 'call';
        if (setStatus === 'screening' && jobId) actionType = 'assign';
        else if (setStatus === 'certified') actionType = 'certify';
        else if (setStatus === 'interview_scheduled') actionType = 'interview';
        else if (isDeclineStatus(setStatus)) actionType = 'not_interested';
        else if (createFollowup && taskType === 'no_answer') actionType = 'no_answer';
        else if (createFollowup && taskType === 'callback') actionType = 'follow_up';
        else if (outcome === 'note') actionType = 'note';

        const id = generateUUID();
        await query(
            adaptQuery(`INSERT INTO call_logs (id, candidate_id, agent_id, outcome, disposition, remark, duration_seconds, job_id, application_id, reason, action_type, claim_session_id)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`),
            [id, candidate_id, req.user.id, outcome, disposition, remark, durationSeconds, jobId, applicationId, reason, actionType, claimSessionId]
        );

        // Live Engagement panels: lightweight ping so open scorecards refetch.
        try {
            const { getIO } = require('../utils/websocket');
            const io = getIO();
            if (io) io.emit('engagement_activity', { candidate_id, agent_id: req.user.id, action_type: actionType, ts: new Date().toISOString() });
        } catch (wsErr) {
            logger.debug(`engagement_activity WS emit skipped: ${wsErr.message}`);
        }

        // Logging a call counts as agent contact; carry disposition through. The
        // candidate status itself is NOT written here — forward stages cascade via
        // setCandidateStage() and a decline is handled (apps rejected + future_pool)
        // in the block below.
        const setParts = ['last_contacted_at = NOW()', 'contacted_by = $1', 'updated_at = NOW()'];
        const setVals = [req.user.id];
        if (disposition) {
            setParts.push(`disposition = $${setVals.length + 1}`, 'disposition_at = NOW()', `disposition_by = $1`);
            setVals.push(disposition);
        }
        setVals.push(candidate_id);
        await query(
            adaptQuery(`UPDATE candidates SET ${setParts.join(', ')} WHERE id = $${setVals.length}`),
            setVals
        );

        // CV gate removed (2026-06-08): "Done → advance" works regardless of
        // whether a CV is on file.

        // Forward stage → cascade through applications + re-derive status (emits
        // candidate_stage_changed). Decline (Not interested) → reject the active
        // application(s) and move the candidate to future_pool; setCandidateStage
        // emits the change.
        let appliedStatus = null;
        if (setStatus && FORWARD_STAGE_TARGETS.includes(setStatus)) {
            await setCandidateStage(candidate_id, setStatus);
            appliedStatus = setStatus;
        } else if (isDeclineStatus(setStatus)) {
            await query(
                adaptQuery(`UPDATE applications SET status = 'rejected', rejection_reason = COALESCE($2, rejection_reason), updated_at = NOW()
                            WHERE candidate_id = $1 AND status NOT IN ('rejected','hired')`),
                [candidate_id, reason]
            );
            await setCandidateStage(candidate_id, 'future_pool');
            appliedStatus = 'future_pool';
        }

        // Status changes are NOT silent (user decision 2026-06-11): a Done →
        // Screening advance notifies the candidate their application is received
        // and under review. (Certify / Interview Done paths go through their own
        // dialogs, which notify with full context.)
        if (appliedStatus === 'screening') {
            try {
                const notifications = require('../services/notifications');
                let jobTitle = '';
                try {
                    const appRes = await query(
                        adaptQuery(`SELECT j.title FROM applications a JOIN jobs j ON a.job_id = j.id
                                    WHERE a.candidate_id = $1 ORDER BY a.applied_at DESC LIMIT 1`),
                        [candidate_id]
                    );
                    jobTitle = appRes.rows[0]?.title || '';
                } catch (_e) { /* best-effort */ }
                await notifications.sendNotification({
                    candidateId: candidate_id, type: 'application_complete',
                    data: { job_title: jobTitle }, channels: ['whatsapp'],
                });
            } catch (e) {
                logger.warn(`call-log assign notify failed for ${candidate_id}: ${e.message}`);
            }
        }

        // Advance → resolve pending follow-ups; decline → cancel them.
        if (appliedStatus && appliedStatus !== 'future_pool') {
            await query(adaptQuery(`UPDATE candidate_tasks SET status = 'done', completed_at = NOW()
                                    WHERE candidate_id = $1 AND status = 'pending'`), [candidate_id]);
        } else if (appliedStatus === 'future_pool') {
            await query(adaptQuery(`UPDATE candidate_tasks SET status = 'cancelled'
                                    WHERE candidate_id = $1 AND status = 'pending'`), [candidate_id]);
        }

        // Follow-up / No answer → open a due-work task (shows in Engagement; a
        // 'no_answer' task also surfaces in the per-agent catch-up list).
        let followupTaskId = null;
        if (createFollowup) {
            followupTaskId = generateUUID();
            await query(
                adaptQuery(`INSERT INTO candidate_tasks
                                (id, candidate_id, due_at, note, task_type, status, assigned_to, created_by)
                            VALUES ($1, $2, NOW(), $3, $4, 'pending', $5, $5)`),
                [followupTaskId, candidate_id, followupNote || 'Needs follow-up', taskType, req.user.id]
            );
        }

        try {
            const { getIO } = require('../utils/websocket');
            const io = getIO();
            if (io && disposition) io.emit('disposition_changed', { candidate_id, disposition, ts: new Date().toISOString() });
        } catch (wsErr) {
            logger.debug(`call-log WS emit skipped: ${wsErr.message}`);
        }

        return res.status(201).json({
            success: true,
            candidate_status: appliedStatus || undefined,
            followup_task_id: followupTaskId || undefined,
            call_log: {
                id, candidate_id, agent_id: req.user.id, agent_name: req.user.full_name || req.user.email,
                outcome, disposition, remark, reason, job_id: jobId, application_id: applicationId,
                duration_seconds: durationSeconds, called_at: new Date().toISOString(),
            },
        });
    } catch (error) {
        next(error);
    }
});

// ── POST /api/communications/send ─────────────────────────────────────────────
// Agent manually sends a message to a candidate on one or more channels.
// Accepts `channel` (single: 'whatsapp'|'email'|'sms') OR
//         `channels` (comma-separated / array) to send to multiple channels.
// WhatsApp: supports text + media (image/audio/video/document via GCS)
// Email:    supports text body + the same uploaded file as an attachment
// SMS:      text only
router.post('/send', authenticate, requireSection('communications', 'edit'), upload.single('media'), async (req, res, next) => {
    try {
        const {
            candidate_id,
            phone,
            channel,
            channels: rawChannels,
            message = '',
            text = '',
            msgType,
            sender = 'agent',
            email_subject,
        } = req.body;
        const mediaFile = req.file;
        const normalizedMessage = String(message || text || '').trim();
        const hasText = Boolean(normalizedMessage);

        // Resolve which channels to send on
        let targetChannels;
        if (rawChannels) {
            targetChannels = Array.isArray(rawChannels)
                ? rawChannels
                : String(rawChannels).split(',').map(s => s.trim()).filter(Boolean);
        } else {
            targetChannels = [String(channel || 'whatsapp')];
        }
        // Deduplicate + normalise
        targetChannels = [...new Set(targetChannels.map(c => c.toLowerCase()))];
        const validChannels = new Set(['whatsapp', 'email', 'sms']);
        const badChannels = targetChannels.filter(c => !validChannels.has(c));
        if (badChannels.length > 0) {
            return res.status(400).json({ error: `Unsupported channel(s): ${badChannels.join(', ')}. Supported: whatsapp, email, sms` });
        }

        let resolvedCandidateId = candidate_id;
        if (!resolvedCandidateId && phone) {
            const normalizedPhone = normalizePhone(phone) || String(phone).replace(/[\s\-()]/g, '');
            const foundCandidate = await query(
                adaptQuery(`
                    SELECT id
                    FROM candidates
                    WHERE phone = $1 OR whatsapp_phone = $1
                    ORDER BY updated_at DESC
                    LIMIT 1
                `),
                [normalizedPhone]
            );
            if (foundCandidate.rows.length > 0) {
                resolvedCandidateId = foundCandidate.rows[0].id;
            }
        }

        if (!resolvedCandidateId) {
            return res.status(400).json({ error: 'candidate_id or phone is required' });
        }
        if (!hasText && !mediaFile) {
            return res.status(400).json({ error: 'message or media file is required' });
        }

        const candidateResult = await query(
            adaptQuery('SELECT * FROM candidates WHERE id = $1'),
            [resolvedCandidateId]
        );
        if (candidateResult.rows.length === 0) {
            return res.status(404).json({ error: 'Candidate not found' });
        }
        const candidate = candidateResult.rows[0];

        // ── Upload media to GCS once (reused by both WhatsApp and as email attachment) ──
        let mediaUrl = null;
        let finalMessageType = 'text';
        if (mediaFile) {
            if (!validateMediaMime(mediaFile)) {
                return res.status(400).json({ error: `Unsupported media MIME type: ${mediaFile.mimetype}` });
            }
            mediaUrl = await uploadCommunicationMedia(mediaFile, resolvedCandidateId);
            finalMessageType = detectMediaType(mediaFile.mimetype, msgType);
        }

        // ── Dispatch per channel ─────────────────────────────────────────────
        const channelResults = {};

        for (const ch of targetChannels) {
            channelResults[ch] = { simulated: false };

            if (ch === 'whatsapp') {
                // Route agent WhatsApp sends through the chatbot, which owns the
                // live WhatsApp Business identity. The backend's own Meta token is
                // a different (frequently-expired) credential — sending on it
                // silently dropped takeover replies (the "token split-brain").
                const chatbotNotifier = require('../services/chatbotNotifier');
                const waPhone = candidate.whatsapp_phone || candidate.phone;
                if (!waPhone) {
                    channelResults[ch] = { simulated: true, error: 'Candidate has no phone number', delivery_status: 'failed', reason: 'no_phone' };
                    continue;
                }
                const sendRes = await chatbotNotifier.sendAgentMessage({
                    phone: waPhone.replace(/[^0-9]/g, ''),
                    message: normalizedMessage,
                    messageType: mediaUrl ? finalMessageType : 'text',
                    mediaUrl: mediaUrl || null,
                    filename: mediaFile?.originalname || null,
                });
                if (sendRes.ok) {
                    channelResults[ch].whatsapp_message_id = sendRes.messageId || null;
                    channelResults[ch].delivery_status = 'sent';
                } else if (sendRes.queued) {
                    // Candidate is outside the 24h window: the chatbot (optionally)
                    // sent a re-engagement template and this message is parked in
                    // pending_messages — it auto-delivers on the candidate's next
                    // reply. NOT a failure.
                    channelResults[ch].delivery_status = 'queued';
                    channelResults[ch].reason = 'out_of_window_queued';
                    channelResults[ch].reengage_sent = !!sendRes.reengageSent;
                    logger.info(`Agent WhatsApp send queued (out-of-window) for ${waPhone}${sendRes.reengageSent ? ' — re-engagement template sent' : ''}`);
                } else {
                    // out_of_window means the candidate is silent >24h and free-form
                    // is dropped by Meta — surface it honestly rather than a fake "sent".
                    channelResults[ch].simulated = true;
                    channelResults[ch].error = sendRes.error;
                    channelResults[ch].reason = sendRes.reason || null;
                    channelResults[ch].delivery_status = 'failed';
                    logger.warn(`Agent WhatsApp send not delivered for ${waPhone}: ${sendRes.reason || ''} ${sendRes.error || ''}`);
                }

            } else if (ch === 'email') {
                if (!candidate.email) {
                    channelResults[ch] = { simulated: true, error: 'Candidate has no email address' };
                    continue;
                }
                try {
                    const gmailService = require('../services/gmail');
                    const gmailConnected = await gmailService.isConnected();
                    if (!gmailConnected) {
                        channelResults[ch] = { simulated: true, error: 'Gmail not connected. Complete OAuth flow first.' };
                        continue;
                    }
                    const subject = email_subject
                        ? String(email_subject).trim().slice(0, 200)
                        : 'Message from Dewan Recruitment';
                    const attachments = mediaFile
                        ? [{ buffer: mediaFile.buffer, filename: mediaFile.originalname, mimeType: mediaFile.mimetype }]
                        : [];
                    await gmailService.sendEmail(candidate.email, subject, normalizedMessage, attachments);
                } catch (err) {
                    logger.warn(`Email send failed for ${candidate.email}: ${err.message}`);
                    channelResults[ch].simulated = true;
                    channelResults[ch].error = err.message;
                }

            } else if (ch === 'sms') {
                if (mediaUrl) {
                    channelResults[ch] = { simulated: true, error: 'SMS channel does not support media attachments' };
                    continue;
                }
                try {
                    const { sendSMS } = require('../services/sms');
                    await sendSMS(candidate.phone, normalizedMessage);
                } catch (err) {
                    logger.warn(`SMS send failed: ${err.message}`);
                    channelResults[ch].simulated = true;
                    channelResults[ch].error = err.message;
                }
            }
        }

        // ── Persist one communications row (primary channel is first target) ─
        const primaryChannel = targetChannels[0];
        const commId = generateUUID();
        const agentName = req.user?.name || req.user?.email || 'Agent';
        const attachmentsValue = mediaUrl ? [mediaUrl] : [];
        const primaryWaId = channelResults['whatsapp']?.whatsapp_message_id || null;
        // Honest initial delivery state for the primary channel (later upgraded to
        // delivered/read by the /status-sync receipts webhook). 'failed' carries a
        // coarse reason (out_of_window / no_whatsapp / token_expired / …) so the UI
        // can tell the agent the message did NOT reach the candidate.
        const primaryResult = channelResults[primaryChannel] || {};
        const primaryDelivery = primaryResult.delivery_status
            || (primaryResult.simulated ? 'failed' : 'sent');
        const primaryReason = primaryResult.reason || primaryResult.error || null;
        const metadataValue = JSON.stringify({
            source: 'agent_dashboard',
            channels: targetChannels,
            channel_results: channelResults,
            whatsapp_message_id: primaryWaId,
            delivery_status: primaryDelivery,
            delivery_reason: (primaryDelivery === 'failed' || primaryDelivery === 'queued') ? primaryReason : null,
            reengage_sent: channelResults['whatsapp']?.reengage_sent || false,
            upload_mime_type: mediaFile?.mimetype || null,
            upload_original_name: mediaFile?.originalname || null,
            upload_size: mediaFile?.size || null,
        });
        await insertCommunicationMessage({
            id: commId,
            candidateId: resolvedCandidateId,
            channel: primaryChannel,
            direction: 'outbound',
            messageType: finalMessageType,
            content: normalizedMessage,
            sentBy: req.user.id,
            senderType: 'agent',
            senderName: agentName,
            attachmentsValue,
            metadataValue,
            callRecordingUrl: finalMessageType === 'audio' ? mediaUrl : null,
            whatsappMessageId: primaryWaId,
            // Claim-aware credit: stamped only if this agent holds the claim
            // right now — unstamped messages don't count in engagement stats.
            claimSessionId: await getOpenClaimSessionId(resolvedCandidateId, req.user.id),
        });

        // Out-of-window WhatsApp send: park the message so it auto-delivers on
        // the candidate's next reply. communication_id links back to the row we
        // just inserted, so the flush upgrades the SAME bubble from "queued" to
        // real delivery ticks.
        if (channelResults['whatsapp']?.delivery_status === 'queued') {
            const { queuePendingMessage } = require('../services/pendingMessages');
            await queuePendingMessage({
                candidateId: resolvedCandidateId,
                communicationId: commId,
                kind: 'agent',
                message: normalizedMessage,
                messageType: mediaUrl ? finalMessageType : 'text',
                mediaUrl: mediaUrl || null,
                filename: mediaFile?.originalname || null,
                createdBy: req.user.id,
            });
        }

        // Clear intervention flag now that an agent has responded.
        // Keep backward compatibility across older/newer candidate schemas.
        try {
            await query(
                adaptQuery(`
                    UPDATE candidates
                    SET intervention_needed = FALSE,
                        intervention_reason = NULL,
                        updated_at = NOW()
                    WHERE id = $1
                `),
                [resolvedCandidateId]
            );
        } catch (clearErr) {
            const msg = String(clearErr?.message || '').toLowerCase();
            const schemaMismatch = msg.includes('column') || msg.includes('does not exist') || msg.includes('unknown column');
            if (!schemaMismatch) {
                throw clearErr;
            }

            await query(
                adaptQuery(`
                    UPDATE candidates
                    SET requires_human = FALSE,
                        escalation_reason = NULL,
                        updated_at = NOW()
                    WHERE id = $1
                `),
                [resolvedCandidateId]
            );
        }

        // Broadcast via WebSocket
        try {
            const { getIO } = require('../utils/websocket');
            const io = getIO();
            if (io) {
                const msgPayload = {
                    id: commId,
                    candidate_id: resolvedCandidateId,
                    channel: primaryChannel,
                    direction: 'outbound',
                    message_type: finalMessageType,
                    content: normalizedMessage,
                    attachments: attachmentsValue,
                    sender_type: sender || 'agent',
                    sender_name: agentName,
                    sent_at: new Date().toISOString(),
                };
                io.to(`candidate:${resolvedCandidateId}`).emit('new_message', msgPayload);
                io.to(`candidate:${resolvedCandidateId}`).emit('receive_message', {
                    id: commId,
                    candidate_id: resolvedCandidateId,
                    phone: candidate.phone || candidate.whatsapp_phone,
                    sender: sender || 'agent',
                    text: normalizedMessage,
                    timestamp: new Date().toISOString(),
                    message_type: finalMessageType,
                    attachments: attachmentsValue,
                });
                const chatPreview = normalizedMessage
                    || (mediaUrl ? `[${finalMessageType.toUpperCase()}]` : '');
                io.emit('chat_activity', { candidate_id: resolvedCandidateId, last_message: chatPreview.slice(0, 80), ts: new Date().toISOString() });
                // Live Engagement panels: agent message sent → message counts move.
                io.emit('engagement_activity', { candidate_id: resolvedCandidateId, agent_id: req.user.id, action_type: 'message', ts: new Date().toISOString() });
            }
        } catch (wsErr) {
            logger.debug(`send WS emit skipped: ${wsErr.message}`);
        }

        // Build per-channel simulated/error summary for the UI
        const anySimulated = Object.values(channelResults).some(r => r.simulated);
        const deliveryErrors = Object.fromEntries(
            Object.entries(channelResults)
                .filter(([, r]) => r.error)
                .map(([ch, r]) => [ch, r.error])
        );

        return res.status(201).json({
            id: commId,
            direction: 'outbound',
            content: normalizedMessage,
            message_type: finalMessageType,
            attachments: attachmentsValue,
            candidate_id: resolvedCandidateId,
            channels: targetChannels,
            channel_results: channelResults,
            simulated: anySimulated,
            ...(Object.keys(deliveryErrors).length > 0 && { delivery_errors: deliveryErrors }),
            whatsapp_message_id: primaryWaId,
        });
    } catch (error) {
        next(error);
    }
});

// ── POST /api/communications/send-bulk ────────────────────────────────────────
router.post('/send-bulk', authenticate, requireSection('communications', 'edit'), async (req, res, next) => {
    try {
        const { candidate_ids, channel, message } = req.body;
        if (!candidate_ids || !Array.isArray(candidate_ids) || candidate_ids.length === 0) {
            return res.status(400).json({ error: 'candidate_ids array is required' });
        }
        if (!channel || !message) {
            return res.status(400).json({ error: 'Channel and message are required' });
        }

        const results = { success: [], failed: [] };
        for (const candidateId of candidate_ids) {
            try {
                const candidateResult = await query(
                    adaptQuery('SELECT * FROM candidates WHERE id = $1'),
                    [candidateId]
                );
                if (candidateResult.rows.length === 0) {
                    results.failed.push({ candidate_id: candidateId, error: 'Not found' });
                    continue;
                }
                const candidate = candidateResult.rows[0];
                if (channel === 'whatsapp' && candidate.phone) {
                    const { sendTextMessage } = require('../services/whatsapp');
                    try { await sendTextMessage(candidate.phone, message); }
                    catch (err) { logger.warn(`WA send failed: ${err.message}`); }
                } else if (channel === 'sms' && candidate.phone) {
                    const { sendSMS } = require('../services/sms');
                    await sendSMS(candidate.phone, message);
                }
                const commId = generateUUID();
                await insertCommunicationMessage({
                    id: commId,
                    candidateId,
                    channel,
                    direction: 'outbound',
                    messageType: 'text',
                    content: message,
                    sentBy: req.user.id,
                    senderType: 'agent',
                    senderName: req.user?.name || req.user?.email || 'Agent',
                    attachmentsValue: [],
                    metadataValue: JSON.stringify({ source: 'bulk_send' }),
                    callRecordingUrl: null,
                    claimSessionId: await getOpenClaimSessionId(candidateId, req.user.id),
                });
                results.success.push({ candidate_id: candidateId, name: candidate.name });
            } catch (err) {
                results.failed.push({ candidate_id: candidateId, error: err.message });
            }
        }

        return res.json({ total: candidate_ids.length, sent: results.success.length, failed: results.failed.length, results });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
