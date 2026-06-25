/**
 * Pending Messages — deliver-on-reply queue
 * =========================================
 *
 * WhatsApp drops free-form messages sent outside the 24h customer-service
 * window. Send paths that hit that wall park the message here (status
 * 'pending', usually after a re-engagement template went out) instead of
 * hard-failing. The inbound sync hook (routes/chatbot-intake.js /sync-message)
 * calls flushPendingForCandidate() on every candidate reply — at that moment
 * the window is open, so the parked messages go out free-form.
 *
 * Each row may carry communication_id, the original transcript row: on a
 * successful flush we stamp the real whatsapp_message_id onto it and upgrade
 * metadata.delivery_status to 'sent', so the SAME bubble the agent saw as
 * "Queued" picks up real delivery ticks (Meta receipts then upgrade it via
 * /api/communications/status-sync, which matches on whatsapp_message_id).
 */

const { pool } = require('../config/database');
const chatbotNotifier = require('./chatbotNotifier');
const logger = require('../utils/logger');

const MAX_ATTEMPTS = 3;

async function queuePendingMessage({
    candidateId,
    communicationId = null,
    kind = 'agent',
    message,
    messageType = 'text',
    mediaUrl = null,
    filename = null,
    createdBy = null,
}) {
    try {
        const r = await pool.query(
            `INSERT INTO pending_messages
                (candidate_id, communication_id, kind, message, message_type, media_url, filename, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id`,
            [candidateId, communicationId, kind, message || '', messageType, mediaUrl, filename, createdBy]
        );
        return r.rows[0]?.id || null;
    } catch (err) {
        logger.error(`pendingMessages: queue failed for ${candidateId}: ${err.message}`);
        return null;
    }
}

// A row marked 'sending' but never finalized this long ago was orphaned by a
// process crash/redeploy mid-send — reclaim it so the message isn't lost.
const STALE_SENDING_MINUTES = 10;

/**
 * Claim due pending rows for a candidate (FOR UPDATE SKIP LOCKED so two rapid
 * inbound messages can't double-flush), mark them 'sending' with a sending_at
 * stamp, and return them. Also reclaims rows orphaned in 'sending' by a crash.
 */
async function claimPending(candidateId) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Sweep anything past its expiry first so it never flushes stale.
        await client.query(
            `UPDATE pending_messages SET status = 'expired'
             WHERE candidate_id = $1 AND status IN ('pending', 'sending') AND expires_at <= NOW()`,
            [candidateId]
        );
        const r = await client.query(
            `SELECT id, communication_id, kind, message, message_type, media_url, filename
             FROM pending_messages
             WHERE candidate_id = $1 AND expires_at > NOW()
               AND (
                    status = 'pending'
                    OR (status = 'sending' AND sending_at < NOW() - INTERVAL '${STALE_SENDING_MINUTES} minutes')
               )
             ORDER BY created_at ASC
             FOR UPDATE SKIP LOCKED`,
            [candidateId]
        );
        if (r.rows.length > 0) {
            await client.query(
                `UPDATE pending_messages SET status = 'sending', sending_at = NOW(), attempts = attempts + 1
                 WHERE id = ANY($1::uuid[])`,
                [r.rows.map((row) => row.id)]
            );
        }
        await client.query('COMMIT');
        return r.rows;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        logger.error(`pendingMessages: claim failed for ${candidateId}: ${err.message}`);
        return [];
    } finally {
        client.release();
    }
}

async function finalizeRow(row, { ok, messageId }) {
    if (ok) {
        await pool.query(
            `UPDATE pending_messages SET status = 'sent', sent_at = NOW() WHERE id = $1`,
            [row.id]
        );
        if (row.communication_id) {
            await pool.query(
                `UPDATE communications
                 SET whatsapp_message_id = COALESCE($1, whatsapp_message_id),
                     sent_at = NOW(),
                     metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb
                 WHERE id = $3`,
                [
                    messageId || null,
                    JSON.stringify({
                        delivery_status: 'sent',
                        delivery_reason: null,
                        flushed_at: new Date().toISOString(),
                    }),
                    row.communication_id,
                ]
            );
        }
        return true;
    }
    // Failed attempt: back to pending for the next inbound, dead after MAX_ATTEMPTS.
    await pool.query(
        `UPDATE pending_messages SET status = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'pending' END
         WHERE id = $1`,
        [row.id, MAX_ATTEMPTS]
    );
    return false;
}

/**
 * Send every due pending message for a candidate. Called fire-and-forget from
 * the inbound sync hook — never throws.
 */
async function flushPendingForCandidate(candidateId, phone) {
    if (!candidateId || !phone) return { flushed: 0 };
    let rows;
    try {
        rows = await claimPending(candidateId);
    } catch {
        return { flushed: 0 };
    }
    if (!rows.length) return { flushed: 0 };

    let flushed = 0;
    for (const row of rows) {
        try {
            const result = await chatbotNotifier.sendAgentMessage({
                phone,
                message: row.message,
                messageType: row.message_type || 'text',
                mediaUrl: row.media_url,
                filename: row.filename,
            });
            const done = await finalizeRow(row, { ok: !!result.ok, messageId: result.messageId });
            if (done) {
                flushed += 1;
                emitMessageUpdated(candidateId, row.communication_id, result.messageId);
            }
        } catch (err) {
            logger.error(`pendingMessages: flush send failed for ${candidateId}/${row.id}: ${err.message}`);
            await finalizeRow(row, { ok: false }).catch(() => {});
        }
    }
    if (flushed > 0) {
        logger.info(`pendingMessages: flushed ${flushed}/${rows.length} queued message(s) to ${phone}`);
    }
    return { flushed };
}

// Live-update the open conversation: the transcript row that was shown as
// "Queued" now carries a real message id and 'sent' status.
function emitMessageUpdated(candidateId, communicationId, whatsappMessageId) {
    try {
        const { getIO } = require('../utils/websocket');
        const io = getIO();
        if (io && communicationId) {
            io.to(`candidate:${candidateId}`).emit('message_updated', {
                candidate_id: candidateId,
                id: communicationId,
                whatsapp_message_id: whatsappMessageId || null,
                metadata: { delivery_status: 'sent', delivery_reason: null },
                ts: new Date().toISOString(),
            });
        }
    } catch {
        // best-effort only
    }
}

module.exports = { queuePendingMessage, flushPendingForCandidate };
