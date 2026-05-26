/**
 * 3CX Webhook Routes
 * ==================
 * Receives call-event payloads from the 3CX PBX (ringing, pickup, ended)
 * and persists them to `lead_call_events`. When the caller number matches
 * an existing marketing lead, the row is linked and the lead's
 * `last_contacted_at` is bumped so the screen-pop and analytics stay
 * accurate.
 *
 * Auth: shared-secret via the `X-3cx-Token` header (THREECX_WEBHOOK_TOKEN).
 *       Optional IP allowlist via THREECX_ALLOWED_IPS (comma-separated).
 *
 * Mounted at /webhooks/3cx (no /api prefix, matching the existing
 * webhooks.js convention and the audit-middleware skip list).
 */

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { query } = require('../config/database');
const { normalizePhone } = require('../utils/phone');
const logger = require('../utils/logger');

// 60 events/min/IP is more than enough for a single PBX even at peak.
const callEventLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    message: { error: 'rate_limited' },
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: false },
});

function clientIp(req) {
    return (
        req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
        req.connection?.remoteAddress ||
        req.ip ||
        ''
    );
}

function authenticate3cx(req, res, next) {
    const expectedToken = process.env.THREECX_WEBHOOK_TOKEN;
    if (!expectedToken) {
        logger.error('THREECX_WEBHOOK_TOKEN not set — refusing to accept 3CX events.');
        return res.status(503).json({ error: 'webhook_disabled' });
    }

    const presented = req.headers['x-3cx-token'];
    if (presented !== expectedToken) {
        logger.warn(`3CX webhook: rejected request from ${clientIp(req)} (bad token)`);
        return res.status(401).json({ error: 'unauthorized' });
    }

    const allowList = (process.env.THREECX_ALLOWED_IPS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    if (allowList.length > 0) {
        const ip = clientIp(req);
        if (!allowList.includes(ip)) {
            logger.warn(`3CX webhook: rejected request from non-allowlisted IP ${ip}`);
            return res.status(403).json({ error: 'ip_not_allowed' });
        }
    }

    next();
}

// Map a flexible incoming payload onto our schema. 3CX's outbound webhook
// shape varies by template/version, so we accept several common aliases
// rather than locking in a single field set.
function normalizeEventPayload(body) {
    const callId =
        body.call_id ?? body.CallId ?? body.callId ?? body.id ?? null;
    const eventTypeRaw =
        body.event_type ?? body.Type ?? body.eventType ?? body.event ?? '';
    const callerNumber =
        body.caller_number ?? body.Caller ?? body.From ?? body.caller ?? null;
    const agentExtension =
        body.agent_extension ?? body.Agent ?? body.extension ?? body.To ?? null;
    const durationSeconds =
        body.duration_seconds ?? body.Duration ?? body.duration ?? null;
    const recordingUrl =
        body.recording_url ?? body.RecordingUrl ?? body.recording ?? null;
    const occurredAt =
        body.occurred_at ?? body.Timestamp ?? body.timestamp ?? null;

    const eventType = String(eventTypeRaw).toLowerCase().trim() || 'unknown';

    return {
        callId,
        eventType,
        callerNumber: callerNumber ? String(callerNumber).trim() : null,
        agentExtension: agentExtension ? String(agentExtension).trim() : null,
        durationSeconds: durationSeconds != null ? Number(durationSeconds) : null,
        recordingUrl: recordingUrl || null,
        occurredAt: occurredAt || null,
    };
}

// ── POST /webhooks/3cx/call-event ──────────────────────────────────────────
router.post('/call-event', callEventLimiter, authenticate3cx, async (req, res) => {
    const body = req.body || {};
    const evt = normalizeEventPayload(body);

    if (!evt.callId) {
        return res.status(400).json({ error: 'call_id_required' });
    }

    try {
        // Match caller to an existing lead so the row is queryable from the UI.
        let leadId = null;
        if (evt.callerNumber) {
            const normalized = normalizePhone(evt.callerNumber) || evt.callerNumber;
            const leadMatch = await query(
                `SELECT id FROM marketing_leads WHERE phone = $1 LIMIT 1`,
                [normalized]
            );
            if (leadMatch.rows.length) {
                leadId = leadMatch.rows[0].id;
            }
        }

        // Idempotent insert — the unique index on (call_id, event_type) from
        // migration 019 ensures retried webhook deliveries don't double-log.
        const insertResult = await query(
            `INSERT INTO lead_call_events
                (lead_id, call_id, event_type, caller_number, agent_extension,
                 duration_seconds, recording_url, raw_payload, occurred_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, NOW()))
             ON CONFLICT (call_id, event_type) DO NOTHING
             RETURNING id, lead_id, event_type`,
            [
                leadId,
                evt.callId,
                evt.eventType,
                evt.callerNumber,
                evt.agentExtension,
                evt.durationSeconds,
                evt.recordingUrl,
                JSON.stringify(body),
                evt.occurredAt,
            ]
        );

        // When the call ended, bump the lead's last-contact timestamp so the
        // list view shows fresh activity and follow-up queues stay accurate.
        if (leadId && (evt.eventType === 'ended' || evt.eventType === 'incoming' || evt.eventType === 'hangup')) {
            await query(
                `UPDATE marketing_leads
                 SET last_contacted_at = NOW(), updated_at = NOW()
                 WHERE id = $1`,
                [leadId]
            );
        }

        return res.status(202).json({
            ok: true,
            duplicate: insertResult.rows.length === 0,
            lead_id: leadId,
            event_type: evt.eventType,
        });
    } catch (err) {
        logger.error(`3CX webhook error: ${err.message}`);
        return res.status(500).json({ error: 'internal_error' });
    }
});

// Healthcheck so the 3CX admin can confirm reachability without authenticating.
router.get('/ping', (_req, res) => {
    res.json({ ok: true, service: '3cx-webhook' });
});

module.exports = router;
