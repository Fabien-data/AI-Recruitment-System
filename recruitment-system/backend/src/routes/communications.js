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
}) {
    try {
        await query(
            adaptQuery(`INSERT INTO communications
                (id, candidate_id, channel, direction, message_type, content,
                 attachments, metadata, call_recording_url,
                 sent_by, sender_type, sender_name)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`),
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
        } = req.query;

        const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 5000, 1), 5000);
        const params = [];
        const filters = [];
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
        }

        const whereClause = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';

        const sql = adaptQuery(`
            SELECT
                ca.id            AS candidate_id,
                ca.name,
                ca.phone,
                ca.whatsapp_phone,
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
                u.full_name      AS agent_name,
                lm.content       AS last_message,
                lm.direction     AS last_direction,
                lm.sender_type   AS last_sender_type,
                lm.detected_language AS last_language,
                lm.chatbot_state AS last_chatbot_state,
                lm.sent_at       AS last_message_at,
                COALESCE(NULLIF(ca.name, ''), NULLIF(ca.whatsapp_phone, ''), ca.phone, 'Unknown') AS display_name,
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
                    sent_at
                FROM communications
                WHERE channel = 'whatsapp'
                ORDER BY candidate_id, sent_at DESC
            ) lm ON lm.candidate_id = ca.id
            LEFT JOIN users u ON u.id = ca.agent_id
            ${whereClause}
            ORDER BY COALESCE(lm.sent_at, ca.created_at) DESC
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
// Agent manually sends a WhatsApp message to a candidate.
// If not already in handoff, automatically triggers takeover first.
router.post('/send', authenticate, upload.single('media'), async (req, res, next) => {
    try {
        const { candidate_id, phone, channel = 'whatsapp', message = '', text = '', msgType, sender = 'agent' } = req.body;
        const mediaFile = req.file;
        const normalizedMessage = String(message || text || '').trim();
        const hasText = Boolean(normalizedMessage);

        let resolvedCandidateId = candidate_id;

        if (!resolvedCandidateId && phone) {
            const normalizedPhone = String(phone).replace(/[\s\-()]/g, '');
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
        let sendResult = { simulated: false };
        let mediaUrl = null;
        let finalMessageType = 'text';

        if (mediaFile) {
            if (!validateMediaMime(mediaFile)) {
                return res.status(400).json({ error: `Unsupported media MIME type: ${mediaFile.mimetype}` });
            }
            mediaUrl = await uploadCommunicationMedia(mediaFile, candidate_id);
            finalMessageType = detectMediaType(mediaFile.mimetype, msgType);
        }

        if (channel === 'whatsapp') {
            const { sendTextMessage, sendMediaMessage } = require('../services/whatsapp');
            const phone = candidate.phone || candidate.whatsapp_phone;
            if (!phone) {
                return res.status(400).json({ error: 'Candidate has no phone number. Cannot send WhatsApp message.' });
            }
            try {
                if (mediaUrl) {
                    await sendMediaMessage(phone, finalMessageType, mediaUrl, normalizedMessage);
                } else {
                    await sendTextMessage(phone, normalizedMessage);
                }
            } catch (err) {
                const waError = err.response?.data?.error?.message || err.message;
                logger.warn(`WhatsApp send failed for ${phone}: ${waError}`);
                sendResult.simulated = true;
                sendResult.error = waError;
            }
        } else if (channel === 'sms') {
            if (mediaUrl) {
                return res.status(400).json({ error: 'SMS channel does not support media attachments in this endpoint' });
            }
            const { sendSMS } = require('../services/sms');
            sendResult = await sendSMS(candidate.phone, message);
        } else if (channel === 'email') {
            if (mediaUrl) {
                return res.status(400).json({ error: 'Email media attachments are not supported by this endpoint yet' });
            }
            if (candidate.email) {
                try {
                    const gmailService = require('../services/gmail');
                    const isConnected = await gmailService.isConnected();
                    if (isConnected) {
                        await gmailService.sendAutoReply(candidate.email, 'Message from Dewan Recruitment', candidate.name);
                    } else {
                        sendResult.simulated = true;
                    }
                } catch (err) {
                    sendResult.simulated = true;
                }
            } else {
                return res.status(400).json({ error: 'Candidate has no email address' });
            }
        } else {
            return res.status(400).json({ error: 'Invalid channel. Supported: whatsapp, sms, email' });
        }

        // Store the message in communications
        const commId = generateUUID();
        const agentName = req.user?.name || req.user?.email || 'Agent';
        const messageText = normalizedMessage;
        const attachmentsValue = mediaUrl ? [mediaUrl] : [];
        const metadataValue = JSON.stringify({
            source: 'agent_dashboard',
            upload_mime_type: mediaFile?.mimetype || null,
            upload_original_name: mediaFile?.originalname || null,
            upload_size: mediaFile?.size || null,
        });
        await insertCommunicationMessage({
            id: commId,
            candidateId: resolvedCandidateId,
            channel,
            direction: 'outbound',
            messageType: finalMessageType,
            content: messageText,
            sentBy: req.user.id,
            senderType: 'agent',
            senderName: agentName,
            attachmentsValue,
            metadataValue,
            callRecordingUrl: finalMessageType === 'audio' ? mediaUrl : null,
        });

        // If a human agent responded, consider intervention resolved.
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

        // Broadcast via WebSocket
        try {
            const { getIO } = require('../utils/websocket');
            const io = getIO();
            if (io) {
                const msgPayload = {
                    id: commId,
                    candidate_id: resolvedCandidateId,
                    channel,
                    direction: 'outbound',
                    message_type: finalMessageType,
                    content: messageText,
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
                    text: messageText,
                    timestamp: new Date().toISOString(),
                    message_type: finalMessageType,
                    attachments: attachmentsValue,
                });
                const chatPreview = messageText
                    || (mediaUrl ? `[${finalMessageType.toUpperCase()}]` : '');
                io.emit('chat_activity', { candidate_id: resolvedCandidateId, last_message: chatPreview.slice(0, 80), ts: new Date().toISOString() });
            }
        } catch (wsErr) {
            logger.debug(`send WS emit skipped: ${wsErr.message}`);
        }

        return res.status(201).json({
            id: commId,
            direction: 'outbound',
            content: messageText,
            message_type: finalMessageType,
            attachments: attachmentsValue,
            candidate_id: resolvedCandidateId,
            simulated: sendResult.simulated || false,
            ...(sendResult.error && { delivery_error: sendResult.error }),
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
