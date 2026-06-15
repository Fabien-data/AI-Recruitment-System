/**
 * 3CX Webhook Routes
 * ==================
 * Receives call-event payloads from the 3CX PBX (ringing, answered, ended) via
 * the 3CX CRM "Call Journaling" template and turns them into first-class entries
 * in the recruitment calling console:
 *
 *   1. Every event is persisted raw to `lead_call_events` (audit sink).
 *   2. On call-END, if the caller number matches a CANDIDATE we insert ONE
 *      `call_logs` row (source='3cx'), attributed to the agent whose 3CX
 *      extension handled the call (users.pbx_extension → users.id). This is the
 *      same table the manual console writes, so 3CX calls show up in the
 *      candidate timeline and feed the engagement leaderboard automatically.
 *   3. On inbound RINGING we emit a socket `incoming_call` so the responsible
 *      agent's console screen-pops the candidate (frontend listener wired in a
 *      later phase).
 *
 * Caller→candidate matching reuses phoneVariants() (+94/94/0 forms) so it lines
 * up with how chatbot-intake stores numbers. See docs/3cx-integration-plan.md.
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
const { query, generateUUID } = require('../config/database');
const { phoneVariants } = require('../utils/phone');
const { getOpenClaimSessionId } = require('../services/claim-sessions');
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

// Event-type buckets. 3CX templates name the call-end scenario differently
// across versions, so we match a family of aliases rather than one literal.
const ENDED_EVENTS = ['ended', 'hangup', 'completed', 'end', 'finished', 'terminated', 'reportcall'];
const RINGING_EVENTS = ['ringing', 'incoming', 'ring', 'offered', 'alerting', 'inbound'];

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
    const direction =
        body.direction ?? body.Direction ?? body.call_direction ?? null;
    // answered / missed / busy hint, used to derive the call_logs outcome
    const statusRaw =
        body.status ?? body.Status ?? body.disposition ?? body.result ?? body.CallType ?? '';

    const eventType = String(eventTypeRaw).toLowerCase().trim() || 'unknown';

    return {
        callId: callId != null ? String(callId).trim() : null,
        eventType,
        callerNumber: callerNumber ? String(callerNumber).trim() : null,
        agentExtension: agentExtension ? String(agentExtension).trim() : null,
        durationSeconds: durationSeconds != null && durationSeconds !== '' ? Number(durationSeconds) : null,
        recordingUrl: recordingUrl || null,
        occurredAt: occurredAt || null,
        direction: direction ? String(direction).toLowerCase().trim() : null,
        status: statusRaw ? String(statusRaw).toLowerCase().trim() : '',
    };
}

// Derive a call_logs.outcome the engagement queries understand
// (answered / no_answer / busy) from the 3CX status hint, falling back to
// duration when the template doesn't send an explicit result.
function deriveOutcome(evt) {
    const s = evt.status || '';
    if (s.includes('busy')) return 'busy';
    if (s.includes('miss') || s.includes('no answer') || s.includes('noanswer') ||
        s.includes('unanswered') || s.includes('fail') || s.includes('reject') ||
        s.includes('cancel') || s.includes('abandon')) return 'no_answer';
    if (s.includes('answer') || s.includes('connect') || s.includes('complet')) return 'answered';
    return evt.durationSeconds && evt.durationSeconds > 0 ? 'answered' : 'no_answer';
}

// Match a caller number to a candidate across every stored form (+94 / 94 / 0).
async function findCandidateByCaller(callerNumber) {
    const variants = phoneVariants(callerNumber);
    if (!variants.length) return null;
    const res = await query(
        `SELECT id, name, status, claimed_by
           FROM candidates
          WHERE phone = ANY($1) OR whatsapp_phone = ANY($1)
          LIMIT 1`,
        [variants]
    );
    return res.rows[0] || null;
}

// Resolve a 3CX extension to the agent (user) who owns it.
async function resolveAgentByExtension(extension) {
    if (!extension) return null;
    try {
        const res = await query(
            `SELECT id, full_name FROM users WHERE pbx_extension = $1 LIMIT 1`,
            [String(extension).trim()]
        );
        return res.rows[0] || null;
    } catch (err) {
        // pbx_extension missing (migration not yet applied) must never break logging.
        logger.debug(`3CX extension resolve skipped: ${err.message}`);
        return null;
    }
}

function emit(event, payload, rooms = []) {
    try {
        const { getIO } = require('../utils/websocket');
        const io = getIO();
        if (!io) return;
        if (!rooms.length) {
            io.emit(event, payload);
            return;
        }
        for (const room of rooms) if (room) io.to(room).emit(event, payload);
    } catch (err) {
        logger.debug(`3CX socket emit skipped (${event}): ${err.message}`);
    }
}

// ── POST /webhooks/3cx/call-event ──────────────────────────────────────────
router.post('/call-event', callEventLimiter, authenticate3cx, async (req, res) => {
    const body = req.body || {};
    const evt = normalizeEventPayload(body);

    if (!evt.callId) {
        return res.status(400).json({ error: 'call_id_required' });
    }

    try {
        const candidate = evt.callerNumber ? await findCandidateByCaller(evt.callerNumber) : null;
        const agent = await resolveAgentByExtension(evt.agentExtension);
        const agentId = agent?.id || null;

        // 1. Raw audit sink. lead_id stays NULL (the Marketing Hub is retired);
        //    the candidate-facing row below is what the console reads. Idempotent
        //    on (call_id, event_type) so 3CX retries can't double-log.
        await query(
            `INSERT INTO lead_call_events
                (lead_id, call_id, event_type, caller_number, agent_extension, agent_user_id,
                 duration_seconds, recording_url, raw_payload, occurred_at)
             VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, NOW()))
             ON CONFLICT (call_id, event_type) DO NOTHING`,
            [
                evt.callId,
                evt.eventType,
                evt.callerNumber,
                evt.agentExtension,
                agentId,
                evt.durationSeconds,
                evt.recordingUrl,
                JSON.stringify(body),
                evt.occurredAt,
            ]
        );

        const isEnd = ENDED_EVENTS.includes(evt.eventType);
        const isRinging = RINGING_EVENTS.includes(evt.eventType);
        const isOutbound = evt.direction ? evt.direction.includes('out') : false;

        // 2. Screen-pop on inbound ringing (skip clearly-outbound legs — the agent
        //    placed that call, no need to pop). Routed to the agent who holds the
        //    chat claim, else the extension's agent, else broadcast.
        if (isRinging && !isOutbound && candidate) {
            const payload = {
                candidate_id: candidate.id,
                candidate_name: candidate.name,
                caller_number: evt.callerNumber,
                ts: new Date().toISOString(),
            };
            const targetAgent = candidate.claimed_by || agentId;
            emit('incoming_call', payload, targetAgent
                ? [`agent:${targetAgent}`, `candidate:${candidate.id}`]
                : ['global', `candidate:${candidate.id}`]);
        }

        // 3. On call-end, write ONE attributed call_logs row (idempotent via
        //    external_call_id) so the call lands in the candidate timeline + the
        //    engagement leaderboard (which credits agent_id).
        let logged = false;
        let duplicateLog = false;
        if (isEnd && candidate && evt.callId) {
            const existing = await query(
                `SELECT id FROM call_logs WHERE external_call_id = $1 LIMIT 1`,
                [evt.callId]
            );
            if (existing.rows.length) {
                duplicateLog = true;
            } else {
                // Stamp the open claim window if this agent currently holds it
                // (NULL otherwise — engagement still credits agent_id).
                const claimSessionId = agentId
                    ? await getOpenClaimSessionId(candidate.id, agentId)
                    : null;
                const logId = generateUUID();
                await query(
                    `INSERT INTO call_logs
                        (id, candidate_id, agent_id, outcome, duration_seconds, recording_url,
                         external_call_id, source, action_type, claim_session_id, called_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, '3cx', 'call', $8, COALESCE($9::timestamptz, NOW()))`,
                    [
                        logId,
                        candidate.id,
                        agentId,
                        deriveOutcome(evt),
                        evt.durationSeconds,
                        evt.recordingUrl,
                        evt.callId,
                        claimSessionId,
                        evt.occurredAt,
                    ]
                );
                logged = true;

                // Bump last-contact so the chat list shows fresh activity.
                await query(
                    `UPDATE candidates SET last_contacted_at = NOW(), updated_at = NOW() WHERE id = $1`,
                    [candidate.id]
                );

                // Live updates: engagement scorecards refetch; the open chat's
                // call-log timeline refetches (frontend listeners reuse the same
                // events the manual flow emits).
                const ts = new Date().toISOString();
                emit('engagement_activity', {
                    candidate_id: candidate.id, agent_id: agentId, action_type: 'call', source: '3cx', ts,
                });
                emit('call_logged', {
                    candidate_id: candidate.id, source: '3cx', ts,
                }, [`candidate:${candidate.id}`, 'global']);
            }
        }

        return res.status(202).json({
            ok: true,
            event_type: evt.eventType,
            candidate_id: candidate?.id || null,
            agent_id: agentId,
            logged,
            duplicate: duplicateLog,
        });
    } catch (err) {
        logger.error(`3CX webhook error: ${err.message}`);
        return res.status(500).json({ error: 'internal_error' });
    }
});

// ── GET /webhooks/3cx/contact-lookup ───────────────────────────────────────
// 3CX CRM "Contact Lookup" template hits this with the caller number so the PBX
// shows the candidate's name as the caller ID (screen-pop). Same shared-secret
// auth as the call-event route. Returns 404 when no candidate matches.
router.get('/contact-lookup', authenticate3cx, async (req, res) => {
    const number = req.query.number || req.query.Number || req.query.phone;
    if (!number) return res.status(400).json({ error: 'number_required' });
    try {
        const candidate = await findCandidateByCaller(String(number));
        if (!candidate) return res.status(404).json({ error: 'not_found' });
        return res.json({
            candidate_id: candidate.id,
            name: candidate.name,
            stage: candidate.status,
        });
    } catch (err) {
        logger.error(`3CX contact-lookup error: ${err.message}`);
        return res.status(500).json({ error: 'internal_error' });
    }
});

// Healthcheck so the 3CX admin can confirm reachability without authenticating.
router.get('/ping', (_req, res) => {
    res.json({ ok: true, service: '3cx-webhook' });
});

module.exports = router;
