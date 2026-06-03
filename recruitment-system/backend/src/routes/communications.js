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
const { normalizePhone } = require('../utils/phone');
const logger = require('../utils/logger');
const { uploadToGCS } = require('../utils/gcs-upload');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 },
});

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
}) {
    try {
        await query(
            adaptQuery(`INSERT INTO communications
                (id, candidate_id, channel, direction, message_type, content,
                 attachments, metadata, call_recording_url,
                 sent_by, sender_type, sender_name, whatsapp_message_id)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`),
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
router.get('/candidate/:candidate_id', authenticate, async (req, res, next) => {
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
router.get('/history/:phone', authenticate, async (req, res, next) => {
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
router.get('/candidate/:candidate_id/notifications', authenticate, async (req, res, next) => {
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
router.get('/candidate/:candidate_id/context', authenticate, async (req, res, next) => {
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
router.get('/active-chats', authenticate, async (req, res, next) => {
    try {
        const {
            search = '',
            limit = 5000,
            date_from,
            date_to,
            conversation_stage,
            response_status,
            pipeline_stage,
            handoff_state,
            sort_by = 'latest_desc',
        } = req.query;

        const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 5000, 1), 5000);
        const params = [];
        const filters = [];
        const pipelineStageExpr = `
            CASE
                WHEN COALESCE(ca.is_human_handoff, FALSE) = TRUE THEN 'human_takeover_active'
                WHEN COALESCE(ca.requires_human, FALSE) = TRUE THEN 'pending_human_review'
                WHEN LOWER(COALESCE(ca.cv_status, '')) = 'parsed' THEN 'cv_parsed'
                WHEN COALESCE(ca.cv_uploaded, FALSE) = TRUE THEN 'cv_uploaded'
                WHEN LOWER(COALESCE(la.application_status, '')) IN ('shortlisted', 'selected', 'hired', 'placed', 'rejected')
                     OR LOWER(COALESCE(ca.status, '')) IN ('hired', 'rejected') THEN 'shortlisted_or_rejected'
                ELSE 'bot_engaging'
            END
        `;
        const addParam = (value) => {
            params.push(value);
            return isMySQL ? '?' : `$${params.length}`;
        };

        if (search) {
            const searchPlaceholder = addParam(`%${search}%`);
            if (isMySQL) {
                filters.push(`(ca.name LIKE ${searchPlaceholder} OR ca.phone LIKE ${searchPlaceholder} OR ca.whatsapp_phone LIKE ${searchPlaceholder})`);
            } else {
                filters.push(`(ca.name ILIKE ${searchPlaceholder} OR ca.phone ILIKE ${searchPlaceholder} OR ca.whatsapp_phone ILIKE ${searchPlaceholder})`);
            }
        }

        if (conversation_stage) {
            const stagePlaceholder = addParam(conversation_stage);
            filters.push(`ca.conversation_stage = ${stagePlaceholder}`);
        }

        if (pipeline_stage) {
            const pipelinePlaceholder = addParam(pipeline_stage);
            filters.push(`${pipelineStageExpr} = ${pipelinePlaceholder}`);
        }

        if (handoff_state === 'human') {
            filters.push(`ca.is_human_handoff = TRUE`);
        } else if (handoff_state === 'bot') {
            filters.push(`COALESCE(ca.is_human_handoff, FALSE) = FALSE`);
        }

        if (date_from) {
            const fromPlaceholder = addParam(date_from);
            filters.push(`lm.sent_at >= ${fromPlaceholder}`);
        }

        if (date_to) {
            const toPlaceholder = addParam(date_to);
            filters.push(`lm.sent_at <= ${toPlaceholder}`);
        }

        if (response_status === 'awaiting_candidate') {
            filters.push(`lm.direction = 'outbound'`);
        } else if (response_status === 'awaiting_agent') {
            filters.push(`lm.direction = 'inbound'`);
        } else if (response_status === 'unread') {
            filters.push(`lm.direction = 'inbound'`);
            filters.push(`(lm.read_at IS NULL)`);
        } else if (response_status === 'replied') {
            filters.push(`lm.direction = 'outbound'`);
            filters.push(`(lm.read_at IS NOT NULL OR lm.delivered_at IS NOT NULL)`);
        }

        // Show all conversation threads (ongoing + previous) by default.
        filters.push(`lm.sent_at IS NOT NULL`);

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
                COALESCE(la.application_status, '') AS latest_application_status,
                COALESCE(la.job_title, '') AS latest_job_title,
                COALESCE(la.job_category, '') AS latest_job_category,
                COALESCE(la.job_country, '') AS latest_job_country,
                COALESCE(la.project_title, '') AS latest_project_title,
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
                    j.title    AS job_title,
                    j.category AS job_category,
                    j.country  AS job_country,
                    p.title    AS project_title,
                    COALESCE(a.updated_at, a.applied_at) AS last_application_at
                FROM applications a
                LEFT JOIN jobs j ON j.id = a.job_id
                LEFT JOIN projects p ON p.id = j.project_id
                ORDER BY a.candidate_id, COALESCE(a.updated_at, a.applied_at) DESC
            ) la ON la.candidate_id = ca.id
            LEFT JOIN users u ON u.id = ca.agent_id
            ${whereClause}
            ORDER BY COALESCE(lm.sent_at, ca.created_at) ${latestOrder}
            LIMIT ${safeLimit}
        `);

        const result = await query(sql, params);
        res.json(result.rows);
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
router.get('/delivery-audit', authenticate, async (req, res, next) => {
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
router.post('/candidate/:candidate_id/takeover', authenticate, async (req, res, next) => {
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
            content: `🙋 Agent ${req.user.name || req.user.email} has taken over the conversation.`,
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
                    agent_name: req.user.name || req.user.email,
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
router.post('/candidate/:candidate_id/release', authenticate, async (req, res, next) => {
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

// ── POST /api/communications/send ─────────────────────────────────────────────
// Agent manually sends a message to a candidate on one or more channels.
// Accepts `channel` (single: 'whatsapp'|'email'|'sms') OR
//         `channels` (comma-separated / array) to send to multiple channels.
// WhatsApp: supports text + media (image/audio/video/document via GCS)
// Email:    supports text body + the same uploaded file as an attachment
// SMS:      text only
router.post('/send', authenticate, upload.single('media'), async (req, res, next) => {
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
                const { sendTextMessage, sendMediaMessage } = require('../services/whatsapp');
                const waPhone = candidate.whatsapp_phone || candidate.phone;
                if (!waPhone) {
                    channelResults[ch] = { simulated: true, error: 'Candidate has no phone number' };
                    continue;
                }
                try {
                    let waResult;
                    if (mediaUrl) {
                        waResult = await sendMediaMessage(waPhone.replace(/[^0-9]/g, ''), finalMessageType, mediaUrl, normalizedMessage);
                    } else {
                        waResult = await sendTextMessage(waPhone.replace(/[^0-9]/g, ''), normalizedMessage);
                    }
                    channelResults[ch].messages = waResult?.messages;
                    channelResults[ch].whatsapp_message_id = waResult?.messages?.[0]?.id || null;
                } catch (err) {
                    const metaError = err.response?.data?.error;
                    const waError = metaError
                        ? `${metaError.message}${metaError.code ? ` (Meta code ${metaError.code})` : ''}`
                        : err.message;
                    logger.warn(
                        `WhatsApp send failed for ${waPhone}: ${waError}` +
                        (metaError?.fbtrace_id ? ` [fbtrace_id=${metaError.fbtrace_id}]` : '')
                    );
                    if (metaError?.code === 190) {
                        logger.error('WhatsApp token invalid/expired (code 190) — rotate WHATSAPP_ACCESS_TOKEN and redeploy.');
                    }
                    channelResults[ch].simulated = true;
                    channelResults[ch].error = waError;
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
        const metadataValue = JSON.stringify({
            source: 'agent_dashboard',
            channels: targetChannels,
            channel_results: channelResults,
            whatsapp_message_id: primaryWaId,
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
        });

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
router.post('/send-bulk', authenticate, async (req, res, next) => {
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
