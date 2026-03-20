/**
 * Communications Route
 * ====================
 * Full chat transcript, agent send, and live handoff/release endpoints.
 *
 * Routes:
 *   GET  /api/communications/candidate/:id              — full transcript
 *   GET  /api/communications/candidate/:id/notifications— outbound notifications
 *   GET  /api/communications/active-chats               — list of active whatsapp convos
 *   POST /api/communications/send                       — agent sends a message
 *   POST /api/communications/candidate/:id/takeover     — agent takes over from bot
 *   POST /api/communications/candidate/:id/release      — release back to bot
 *   POST /api/communications/send-bulk                  — bulk notification
 */

const express = require('express');
const router = express.Router();
const { query, generateUUID } = require('../config/database');
const { adaptQuery } = require('../utils/query-adapter');
const { isMySQL } = require('../utils/query-adapter');
const { authenticate } = require('../middleware/auth');
const logger = require('../utils/logger');

// ── GET /api/communications/candidate/:id ─────────────────────────────────────
// Returns full chronological transcript for this candidate.
router.get('/candidate/:candidate_id', authenticate, async (req, res, next) => {
    try {
        const { candidate_id } = req.params;
        const { channel, limit = 200 } = req.query;

        const params = [candidate_id];
        let sql = adaptQuery(
            `SELECT c.*, u.name AS agent_name
             FROM communications c
             LEFT JOIN users u ON u.id = c.sent_by
             WHERE c.candidate_id = $1`
        );

        if (channel) {
            params.push(channel);
            sql += adaptQuery(` AND c.channel = $${params.length}`);
        }

        sql += ` ORDER BY c.sent_at ASC LIMIT ${parseInt(limit, 10)}`;

        const result = await query(sql, params);
        res.json(result.rows);
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
// Returns one row per candidate who has a WhatsApp conversation,
// sorted by most recent message. Used to populate the chat list panel.
router.get('/active-chats', authenticate, async (req, res, next) => {
    try {
        const { search = '', limit = 100 } = req.query;
        const params = [];
        let whereClause = '';

        if (search) {
            params.push(`%${search}%`);
            whereClause = adaptQuery(`WHERE (ca.name ILIKE $1 OR ca.phone ILIKE $1 OR ca.whatsapp_phone ILIKE $1)`);
        }

        const sql = adaptQuery(`
            SELECT
                ca.id            AS candidate_id,
                ca.name,
                ca.phone,
                ca.whatsapp_phone,
                ca.status        AS candidate_status,
                ca.is_human_handoff,
                ca.agent_id,
                u.name           AS agent_name,
                lm.content       AS last_message,
                lm.direction     AS last_direction,
                lm.sender_type   AS last_sender_type,
                lm.detected_language AS last_language,
                lm.chatbot_state AS last_chatbot_state,
                lm.sent_at       AS last_message_at
            FROM candidates ca
            INNER JOIN (
                SELECT DISTINCT ON (candidate_id)
                    candidate_id, content, direction, sender_type,
                    detected_language, chatbot_state, sent_at
                FROM communications
                WHERE channel = 'whatsapp'
                ORDER BY candidate_id, sent_at DESC
            ) lm ON lm.candidate_id = ca.id
            LEFT JOIN users u ON u.id = ca.agent_id
            ${whereClause}
            ORDER BY lm.sent_at DESC
            LIMIT ${parseInt(limit, 10)}
        `);

        const result = await query(sql, params);
        res.json(result.rows);
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
        await query(
            adaptQuery(`INSERT INTO communications
                (id, candidate_id, channel, direction, message_type, content,
                 sender_type, sender_name, sent_at)
                VALUES ($1, $2, 'whatsapp', 'outbound', 'text',
                 $3, 'system', 'System', NOW())`),
            [commId, candidate_id,
                `🙋 Agent ${req.user.name || req.user.email} has taken over the conversation.`]
        );

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
        await query(
            adaptQuery(`INSERT INTO communications
                (id, candidate_id, channel, direction, message_type, content,
                 sender_type, sender_name, sent_at)
                VALUES ($1, $2, 'whatsapp', 'outbound', 'text',
                 $3, 'system', 'System', NOW())`),
            [commId, candidate_id,
                `🤖 Bot has resumed control of the conversation.`]
        );

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
router.post('/send', authenticate, async (req, res, next) => {
    try {
        const { candidate_id, channel = 'whatsapp', message } = req.body;

        if (!candidate_id || !message) {
            return res.status(400).json({ error: 'candidate_id and message are required' });
        }

        const candidateResult = await query(
            adaptQuery('SELECT * FROM candidates WHERE id = $1'),
            [candidate_id]
        );
        if (candidateResult.rows.length === 0) {
            return res.status(404).json({ error: 'Candidate not found' });
        }

        const candidate = candidateResult.rows[0];
        let sendResult = { simulated: false };

        if (channel === 'whatsapp') {
            const { sendTextMessage } = require('../services/whatsapp');
            try {
                await sendTextMessage(candidate.phone || candidate.whatsapp_phone, message);
            } catch (err) {
                logger.warn(`WhatsApp send failed (simulating): ${err.message}`);
                sendResult.simulated = true;
            }
        } else if (channel === 'sms') {
            const { sendSMS } = require('../services/sms');
            sendResult = await sendSMS(candidate.phone, message);
        } else if (channel === 'email') {
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
        await query(
            adaptQuery(`INSERT INTO communications
                (id, candidate_id, channel, direction, message_type, content,
                 sent_by, sender_type, sender_name)
                VALUES ($1, $2, $3, 'outbound', 'text', $4, $5, 'agent', $6)`),
            [commId, candidate_id, channel, message, req.user.id, agentName]
        );

        // Broadcast via WebSocket
        try {
            const { getIO } = require('../utils/websocket');
            const io = getIO();
            if (io) {
                const msgPayload = {
                    id: commId,
                    candidate_id,
                    channel,
                    direction: 'outbound',
                    message_type: 'text',
                    content: message,
                    sender_type: 'agent',
                    sender_name: agentName,
                    sent_at: new Date().toISOString(),
                };
                io.to(`candidate:${candidate_id}`).emit('new_message', msgPayload);
                io.emit('chat_activity', { candidate_id, last_message: message.slice(0, 80), ts: new Date().toISOString() });
            }
        } catch (wsErr) {
            logger.debug(`send WS emit skipped: ${wsErr.message}`);
        }

        return res.status(201).json({ ...{ id: commId, direction: 'outbound', content: message }, simulated: sendResult.simulated || false });
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
                await query(
                    adaptQuery(`INSERT INTO communications
                        (id, candidate_id, channel, direction, message_type, content, sent_by, sender_type)
                        VALUES ($1, $2, $3, 'outbound', 'text', $4, $5, 'agent')`),
                    [commId, candidateId, channel, message, req.user.id]
                );
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
