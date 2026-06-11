/**
 * Engagement & Re-engagement (agent visibility)
 * =============================================
 *   GET /api/engagement/stuck            — candidates stalled in the early
 *                                          pipeline (no progress for N days)
 *   GET /api/engagement/candidates/:id/timeline
 *                                        — proactive-message history for a candidate
 *   GET /api/engagement/analytics        — re-engagement funnel + reminder mix
 *
 * Read-only. Sources recruitment_db (candidates, applications, communications).
 * NOTE: chatbot-side stuck-candidate nudges (F1) live in chatbot_db; the
 * backend timeline/analytics here cover backend-originated proactive messages
 * (interview reminders, job re-engagement, reschedule/cancel) plus any chat
 * synced into `communications`.
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { query } = require('../config/database');
const { adaptQuery } = require('../utils/query-adapter');
const { authenticate } = require('../middleware/auth');
const { requireSection } = require('../middleware/sections');
const { hasCvSql } = require('../services/candidate-stage');
const logger = require('../utils/logger');

/**
 * Next-best-action recommendation for a stalled candidate. Deterministic rules
 * over the candidate's stage/signals — the single highest-impact step an agent
 * (or the bot) should take next.
 */
function nextBestAction(c) {
    const days = Number(c.days_since_contact || 0);
    if (c.requires_human) {
        return { action: 'human_follow_up', label: 'Needs human follow-up', priority: 'high' };
    }
    if (!c.cv_uploaded) {
        return { action: 'request_cv', label: 'Request CV to proceed', priority: 'high' };
    }
    if (c.status === 'screening') {
        return { action: 'review_certify', label: 'Review & certify profile', priority: 'medium' };
    }
    if (c.status === 'certified') {
        return { action: 'schedule_interview', label: 'Schedule interview', priority: 'medium' };
    }
    if (days >= 7) {
        return { action: 'reengage_or_pool', label: 'Re-engage or move to General Pool', priority: 'medium' };
    }
    return { action: 'nudge', label: 'Send a follow-up nudge', priority: 'low' };
}

// Proactive message types we report on (metadata.notification_type).
const PROACTIVE_TYPES = [
    'interview_reminder', 'interview_day_reminder', 'interview_scheduled',
    'job_now_available', 'interview_rescheduled', 'interview_cancelled',
    'application_complete', 'certified', 'prescreening_certified',
];

// ── Stuck candidates ──────────────────────────────────────────────────────────
// Candidates whose furthest stage is early (new/screening/certified) and who
// have had no interaction for `days`. Returns a per-stage summary + the list.
router.get('/stuck', authenticate, requireSection('communications', 'view'), async (req, res, next) => {
    try {
        const days = String(Math.max(0, parseInt(req.query.days, 10) || 2));
        const stages = ['new', 'screening', 'certified'];

        const listSql = adaptQuery(`
            SELECT c.id, c.name, c.phone, c.status, c.conversation_stage,
                   c.cv_uploaded, c.requires_human, c.agent_id,
                   c.last_interaction, c.created_at,
                   EXTRACT(EPOCH FROM (NOW() - COALESCE(c.last_interaction, c.created_at)))
                       / 86400.0 AS days_since_contact
            FROM candidates c
            WHERE c.status = ANY($1)
              AND COALESCE(c.requires_human, FALSE) = FALSE
              AND COALESCE(c.last_interaction, c.created_at) < NOW() - ($2 || ' days')::interval
            ORDER BY COALESCE(c.last_interaction, c.created_at) ASC
            LIMIT 500
        `);
        const summarySql = adaptQuery(`
            SELECT c.status, COUNT(*)::int AS n
            FROM candidates c
            WHERE c.status = ANY($1)
              AND COALESCE(c.requires_human, FALSE) = FALSE
              AND COALESCE(c.last_interaction, c.created_at) < NOW() - ($2 || ' days')::interval
            GROUP BY c.status
        `);

        const [list, summary] = await Promise.all([
            query(listSql, [stages, days]),
            query(summarySql, [stages, days]),
        ]);

        const byStage = {};
        for (const row of summary.rows) byStage[row.status] = row.n;

        res.json({
            days: Number(days),
            total: list.rows.length,
            by_stage: byStage,
            candidates: list.rows.map((r) => {
                const row = { ...r, days_since_contact: Math.round(Number(r.days_since_contact) * 10) / 10 };
                return { ...row, next_action: nextBestAction(row) };
            }),
        });
    } catch (err) { next(err); }
});

// ── Awaiting CV — the #1 conversion leak (#7) ────────────────────────────────
// New leads with NO CV on file: they started intake but never sent a CV, so the
// pipeline can't move (CV is the hard gate, #5). Surface them so an agent chases.
// Pure read over recruitment_db — works regardless of the chatbot nudge engine's
// state, so the agent list is useful even before automated nudging is switched on.
router.get('/awaiting-cv', authenticate, requireSection('communications', 'view'), async (req, res, next) => {
    try {
        const listSql = adaptQuery(`
            SELECT c.id, c.name, c.phone, c.status, c.agent_id,
                   c.last_interaction, c.created_at,
                   EXTRACT(EPOCH FROM (NOW() - c.created_at)) / 86400.0 AS days_since_created
            FROM candidates c
            WHERE c.status = 'new'
              AND NOT ${hasCvSql('c')}
            ORDER BY c.created_at DESC
            LIMIT 500
        `);
        const list = await query(listSql, []);
        res.json({
            total: list.rows.length,
            candidates: list.rows.map((r) => ({
                ...r,
                days_since_created: Math.round(Number(r.days_since_created) * 10) / 10,
            })),
        });
    } catch (err) { next(err); }
});

// ── Per-candidate proactive timeline ─────────────────────────────────────────
router.get('/candidates/:id/timeline', authenticate, requireSection('communications', 'view'), async (req, res, next) => {
    try {
        const result = await query(
            adaptQuery(`
                SELECT id, channel, direction, message_type, content,
                       metadata, whatsapp_message_id, sent_at,
                       (metadata->>'notification_type') AS notification_type,
                       (metadata->>'delivery_status')   AS delivery_status
                FROM communications
                WHERE candidate_id = $1
                ORDER BY sent_at DESC
                LIMIT 300
            `),
            [req.params.id]
        );
        const rows = result.rows;
        const proactive = rows.filter(
            (r) => r.direction === 'outbound' && r.notification_type && PROACTIVE_TYPES.includes(r.notification_type)
        );
        res.json({
            candidate_id: req.params.id,
            total: rows.length,
            proactive_count: proactive.length,
            timeline: rows,
        });
    } catch (err) { next(err); }
});

// ── Next-best-action for a single candidate ──────────────────────────────────
router.get('/candidates/:id/next-action', authenticate, requireSection('communications', 'view'), async (req, res, next) => {
    try {
        const r = await query(
            adaptQuery(`
                SELECT c.id, c.status, c.cv_uploaded, c.requires_human,
                       EXTRACT(EPOCH FROM (NOW() - COALESCE(c.last_interaction, c.created_at))) / 86400.0 AS days_since_contact
                FROM candidates c WHERE c.id = $1
            `),
            [req.params.id]
        );
        if (r.rows.length === 0) return res.status(404).json({ error: 'Candidate not found' });
        res.json({ candidate_id: req.params.id, next_action: nextBestAction(r.rows[0]) });
    } catch (err) { next(err); }
});

// ── Re-engagement analytics ───────────────────────────────────────────────────
router.get('/analytics', authenticate, requireSection('communications', 'view'), async (req, res, next) => {
    try {
        const days = String(Math.max(1, parseInt(req.query.days, 10) || 30));

        const byTypeSql = adaptQuery(`
            SELECT metadata->>'notification_type' AS type, COUNT(*)::int AS sent
            FROM communications
            WHERE direction = 'outbound'
              AND sent_at >= NOW() - ($1 || ' days')::interval
              AND metadata->>'notification_type' = ANY($2)
            GROUP BY 1
            ORDER BY sent DESC
        `);

        // Funnel: candidates who got a proactive message, and of those, how many
        // sent any inbound message afterwards (re-engaged).
        const funnelSql = adaptQuery(`
            WITH proactive AS (
                SELECT candidate_id, MIN(sent_at) AS first_proactive
                FROM communications
                WHERE direction = 'outbound'
                  AND sent_at >= NOW() - ($1 || ' days')::interval
                  AND metadata->>'notification_type' = ANY($2)
                GROUP BY candidate_id
            )
            SELECT
                (SELECT COUNT(*) FROM proactive)::int AS candidates_nudged,
                (SELECT COUNT(DISTINCT p.candidate_id)
                   FROM proactive p
                   JOIN communications c ON c.candidate_id = p.candidate_id
                  WHERE c.direction = 'inbound' AND c.sent_at > p.first_proactive)::int AS candidates_replied
        `);

        const [byType, funnel] = await Promise.all([
            query(byTypeSql, [days, PROACTIVE_TYPES]),
            query(funnelSql, [days, PROACTIVE_TYPES]),
        ]);

        const f = funnel.rows[0] || { candidates_nudged: 0, candidates_replied: 0 };
        const replyRate = f.candidates_nudged > 0
            ? Math.round((f.candidates_replied / f.candidates_nudged) * 1000) / 10
            : 0;

        res.json({
            period_days: Number(days),
            sent_by_type: byType.rows,
            total_sent: byType.rows.reduce((s, r) => s + r.sent, 0),
            funnel: { ...f, reply_rate_pct: replyRate },
        });
    } catch (err) { next(err); }
});

// ── Bulk re-engagement campaign (#8) ─────────────────────────────────────────
// Agent selects a cohort of candidates → nudge them all now via the chatbot.
// Each send still respects opt-out / completion / quiet hours / the 3-nudge cap.
router.post('/bulk-nudge', authenticate, requireSection('communications', 'edit'), async (req, res, next) => {
    try {
        const { candidate_ids } = req.body || {};
        if (!Array.isArray(candidate_ids) || candidate_ids.length === 0) {
            return res.status(400).json({ error: 'candidate_ids (non-empty array) is required' });
        }
        if (candidate_ids.length > 500) {
            return res.status(400).json({ error: 'Cannot nudge more than 500 candidates at once' });
        }
        const r = await query(
            adaptQuery('SELECT phone FROM candidates WHERE id = ANY($1::uuid[]) AND phone IS NOT NULL'),
            [candidate_ids]
        );
        const phones = r.rows.map((x) => x.phone).filter(Boolean);
        if (phones.length === 0) return res.json({ requested: candidate_ids.length, dispatched: 0 });

        const base = process.env.CHATBOT_API_URL;
        const key = process.env.CHATBOT_API_KEY;
        if (!base || !key) return res.status(500).json({ error: 'CHATBOT_API_URL / CHATBOT_API_KEY not configured' });

        const resp = await axios.post(
            `${base.replace(/\/$/, '')}/webhook/internal/nudge-candidates`,
            { phones },
            { headers: { 'x-chatbot-api-key': key, 'Content-Type': 'application/json' }, timeout: 60000 }
        );
        res.json({ requested: candidate_ids.length, resolved_phones: phones.length, ...(resp.data || {}) });
    } catch (err) {
        logger.error(`bulk-nudge error: ${err.message}`);
        res.status(502).json({ error: 'chatbot bulk-nudge failed', detail: err.message });
    }
});

// ── Daily digest snapshot (dashboard widget) ─────────────────────────────────
router.get('/daily-digest', authenticate, requireSection('communications', 'view'), async (req, res, next) => {
    try {
        const { gatherDigest } = require('../services/daily-digest');
        res.json(await gatherDigest());
    } catch (err) { next(err); }
});

// ── Agent call activity (calling-console engagement rollup) ──────────────────
// Per-agent engagement from call_logs over a window: calls logged, distinct
// candidates contacted, answered / no-answer / callback counts, leads, call
// duration, remarks — plus a recent activity feed (the full end-to-end log).
// Powers the Engagement page: each agent sees their own day; admin sees everyone.
router.get('/call-logs', authenticate, requireSection('communications', 'view'), async (req, res, next) => {
    try {
        const { date_from, date_to } = req.query;
        // Non-admins only ever see their own numbers — the agent_id param is
        // honored for admins (team table + drill-down).
        const agent_id = req.user.role === 'admin' ? req.query.agent_id : req.user.id;
        const params = [];
        const where = [];
        const p = (v) => { params.push(v); return `$${params.length}`; };
        if (agent_id) where.push(`cl.agent_id = ${p(agent_id)}`);
        if (date_from) where.push(`cl.called_at >= ${p(date_from)}`);
        if (date_to) where.push(`cl.called_at <= ${p(date_to)}`);
        const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

        // Breakdown by action_type (migration 040): a genuine phone CALL
        // (action_type='call' or legacy NULL) vs each ACTION (assign / certify /
        // interview / follow-up). This is what lets admins see "X calls, Y
        // screenings, Z certifications, W interviews" per agent instead of one
        // inflated "calls" number.
        // Claim-aware (migration 042): a CALL only counts while the agent held
        // the chat claim (claim_session_id stamped at insert). Unstamped calls
        // are surfaced separately as calls_unclaimed, never silently dropped.
        // Screenings/certifications/interviews stay un-gated by design — they
        // are verifiable pipeline outcomes (user decision 2026-06-11).
        const perAgentSql = adaptQuery(`
            SELECT cl.agent_id,
                   COALESCE(u.full_name, 'Unknown') AS agent_name,
                   COUNT(*)                                   AS entries_logged,
                   COUNT(*) FILTER (WHERE (cl.action_type = 'call' OR cl.action_type IS NULL) AND cl.claim_session_id IS NOT NULL) AS calls_logged,
                   COUNT(*) FILTER (WHERE (cl.action_type = 'call' OR cl.action_type IS NULL) AND cl.claim_session_id IS NULL)     AS calls_unclaimed,
                   COUNT(*) FILTER (WHERE cl.action_type = 'assign')    AS screenings,
                   COUNT(*) FILTER (WHERE cl.action_type = 'certify')   AS certifications,
                   COUNT(*) FILTER (WHERE cl.action_type = 'interview') AS interviews_scheduled,
                   COUNT(*) FILTER (WHERE cl.action_type = 'follow_up') AS follow_ups,
                   COUNT(*) FILTER (WHERE cl.action_type IN ('assign','certify','interview','not_interested','follow_up','note')) AS actions_total,
                   COUNT(DISTINCT cl.candidate_id)            AS candidates_contacted,
                   COUNT(*) FILTER (WHERE cl.remark IS NOT NULL AND cl.remark <> '') AS remarks_made,
                   COUNT(*) FILTER (WHERE cl.outcome = 'answered')       AS answered,
                   COUNT(*) FILTER (WHERE cl.outcome = 'no_answer')      AS no_answer,
                   COUNT(*) FILTER (WHERE cl.outcome = 'callback')       AS callbacks,
                   COUNT(*) FILTER (WHERE cl.action_type = 'not_interested' OR cl.outcome = 'not_interested') AS not_interested,
                   COUNT(DISTINCT cl.candidate_id) FILTER (WHERE cl.disposition IN ('interested','qualified')) AS leads,
                   COALESCE(SUM(cl.duration_seconds), 0)      AS total_duration_seconds,
                   ROUND(AVG(cl.duration_seconds) FILTER (WHERE cl.duration_seconds IS NOT NULL))::int AS avg_duration_seconds,
                   MAX(cl.called_at)                          AS last_activity_at
            FROM call_logs cl
            LEFT JOIN users u ON u.id = cl.agent_id
            ${whereClause}
            GROUP BY cl.agent_id, u.full_name
            ORDER BY entries_logged DESC
        `);

        // Outbound messages each agent sent WHILE HOLDING THE CLAIM (stamped at
        // send time). sender_type='agent' also excludes system takeover/release
        // rows that previously inflated the count.
        const msgParams = [];
        const msgWhere = [
            `cm.direction = 'outbound'`,
            `cm.sent_by IS NOT NULL`,
            `cm.sender_type = 'agent'`,
            `cm.claim_session_id IS NOT NULL`,
        ];
        const mp = (v) => { msgParams.push(v); return `$${msgParams.length}`; };
        if (agent_id) msgWhere.push(`cm.sent_by = ${mp(agent_id)}`);
        if (date_from) msgWhere.push(`cm.sent_at >= ${mp(date_from)}`);
        if (date_to) msgWhere.push(`cm.sent_at <= ${mp(date_to)}`);
        const messagesSql = adaptQuery(`
            SELECT cm.sent_by AS agent_id, COUNT(*) AS messages_sent
            FROM communications cm
            WHERE ${msgWhere.join(' AND ')}
            GROUP BY cm.sent_by
        `);

        const byDispositionSql = adaptQuery(`
            SELECT COALESCE(cl.disposition, 'none') AS disposition, COUNT(*) AS count
            FROM call_logs cl
            ${whereClause}
            GROUP BY cl.disposition
            ORDER BY count DESC
        `);

        const recentSql = adaptQuery(`
            SELECT cl.id, cl.candidate_id, c.name AS candidate_name, cl.agent_id,
                   COALESCE(u.full_name, 'Unknown') AS agent_name,
                   cl.outcome, cl.disposition, cl.remark, cl.duration_seconds, cl.called_at,
                   cl.action_type, cl.job_id, j.title AS job_title
            FROM call_logs cl
            LEFT JOIN users u ON u.id = cl.agent_id
            LEFT JOIN candidates c ON c.id = cl.candidate_id
            LEFT JOIN jobs j ON j.id = cl.job_id
            ${whereClause}
            ORDER BY cl.called_at DESC
            LIMIT 100
        `);

        // Chats each agent currently holds — the "open claims" workload column.
        const claimsSql = adaptQuery(`
            SELECT claimed_by AS agent_id, COUNT(*) AS open_claims
            FROM candidates
            WHERE claimed_by IS NOT NULL
            GROUP BY claimed_by
        `);

        const [perAgent, byDisposition, recent, messages, claims] = await Promise.all([
            query(perAgentSql, params),
            query(byDispositionSql, params),
            query(recentSql, params),
            query(messagesSql, msgParams),
            query(claimsSql, []),
        ]);

        // Merge per-agent message + open-claim counts onto the rollup rows.
        const msgByAgent = new Map(messages.rows.map((m) => [String(m.agent_id), Number(m.messages_sent || 0)]));
        const claimsByAgent = new Map(claims.rows.map((c) => [String(c.agent_id), Number(c.open_claims || 0)]));
        const perAgentRows = perAgent.rows.map((r) => ({
            ...r,
            messages_sent: msgByAgent.get(String(r.agent_id)) || 0,
            open_claims: claimsByAgent.get(String(r.agent_id)) || 0,
        }));

        const totals = perAgentRows.reduce((acc, r) => {
            acc.calls_logged += Number(r.calls_logged || 0);
            acc.calls_unclaimed += Number(r.calls_unclaimed || 0);
            acc.screenings += Number(r.screenings || 0);
            acc.certifications += Number(r.certifications || 0);
            acc.interviews_scheduled += Number(r.interviews_scheduled || 0);
            acc.actions_total += Number(r.actions_total || 0);
            acc.messages_sent += Number(r.messages_sent || 0);
            acc.remarks_made += Number(r.remarks_made || 0);
            acc.answered += Number(r.answered || 0);
            acc.no_answer += Number(r.no_answer || 0);
            acc.leads += Number(r.leads || 0);
            acc.open_claims += Number(r.open_claims || 0);
            return acc;
        }, { calls_logged: 0, calls_unclaimed: 0, screenings: 0, certifications: 0, interviews_scheduled: 0, actions_total: 0, messages_sent: 0, remarks_made: 0, answered: 0, no_answer: 0, leads: 0, open_claims: 0 });

        res.json({
            per_agent: perAgentRows,
            by_disposition: byDisposition.rows,
            recent: recent.rows,
            totals,
        });
    } catch (err) { next(err); }
});

// ── Personal scorecard (agent growth view + admin drill-down) ────────────────
// One agent's claim-aware stats for the current window AND the previous window
// of the same length (the frontend renders trend deltas from the pair), plus
// their leftover claimed chats — the "go continue the work" list. Non-admins
// are always scoped to themselves; admins may pass agent_id for the drill-down.
router.get('/my-scorecard', authenticate, requireSection('communications', 'view'), async (req, res, next) => {
    try {
        const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 7));
        const agentId = (req.user.role === 'admin' && req.query.agent_id) ? req.query.agent_id : req.user.id;

        // Aggregate one window [from, to). Calls/messages claim-gated (042);
        // screenings/certifications/interviews counted as-is — same policy as
        // the team rollup above.
        const windowAgg = async (fromExpr, toExpr) => {
            const callsSql = adaptQuery(`
                SELECT COUNT(*) FILTER (WHERE (cl.action_type = 'call' OR cl.action_type IS NULL) AND cl.claim_session_id IS NOT NULL) AS calls_logged,
                       COUNT(*) FILTER (WHERE (cl.action_type = 'call' OR cl.action_type IS NULL) AND cl.claim_session_id IS NULL)     AS calls_unclaimed,
                       COUNT(*) FILTER (WHERE cl.action_type = 'assign')    AS screenings,
                       COUNT(*) FILTER (WHERE cl.action_type = 'certify')   AS certifications,
                       COUNT(*) FILTER (WHERE cl.action_type = 'interview') AS interviews_scheduled,
                       COUNT(*) FILTER (WHERE cl.action_type = 'follow_up') AS follow_ups,
                       COUNT(*) FILTER (WHERE cl.action_type IN ('assign','certify','interview','not_interested','follow_up','note')) AS actions_total,
                       COUNT(*) FILTER (WHERE cl.outcome = 'answered')  AS answered,
                       COUNT(*) FILTER (WHERE cl.outcome = 'no_answer') AS no_answer,
                       COUNT(DISTINCT cl.candidate_id) AS candidates_contacted,
                       ROUND(AVG(cl.duration_seconds) FILTER (WHERE cl.duration_seconds IS NOT NULL))::int AS avg_duration_seconds
                FROM call_logs cl
                WHERE cl.agent_id = $1 AND cl.called_at >= ${fromExpr} AND cl.called_at < ${toExpr}
            `);
            const msgSql = adaptQuery(`
                SELECT COUNT(*) AS messages_sent
                FROM communications cm
                WHERE cm.sent_by = $1 AND cm.direction = 'outbound'
                  AND cm.sender_type = 'agent' AND cm.claim_session_id IS NOT NULL
                  AND cm.sent_at >= ${fromExpr} AND cm.sent_at < ${toExpr}
            `);
            const [calls, msgs] = await Promise.all([
                query(callsSql, [agentId]),
                query(msgSql, [agentId]),
            ]);
            return { ...calls.rows[0], messages_sent: Number(msgs.rows[0]?.messages_sent || 0) };
        };

        const d = String(days);
        const [current, previous, leftovers] = await Promise.all([
            windowAgg(`NOW() - INTERVAL '${d} days'`, `NOW() + INTERVAL '1 minute'`),
            windowAgg(`NOW() - INTERVAL '${2 * days} days'`, `NOW() - INTERVAL '${d} days'`),
            query(
                adaptQuery(`
                    SELECT c.id, c.name, c.phone, c.status, c.claimed_at, c.last_interaction,
                           EXTRACT(EPOCH FROM (NOW() - COALESCE(c.claimed_at, NOW()))) / 86400.0 AS days_held
                    FROM candidates c
                    WHERE c.claimed_by = $1
                    ORDER BY c.claimed_at ASC NULLS LAST
                    LIMIT 100
                `),
                [agentId]
            ),
        ]);

        res.json({
            agent_id: agentId,
            days,
            current,
            previous,
            leftovers: {
                open_claims: leftovers.rows.map((r) => ({
                    ...r,
                    days_held: Math.round(Number(r.days_held) * 10) / 10,
                    // Interview already scheduled → the claim is finishable;
                    // the UI nudges the agent to release it.
                    suggest_release: r.status === 'interview_scheduled',
                })),
            },
        });
    } catch (err) { next(err); }
});

// ── Admin → agent engagement nudge ───────────────────────────────────────────
// Persists a user_notifications row (migration 043) and pings the agent's
// private socket room so the nudge lands live. Throttled to one nudge per
// agent per 24h so it stays a signal, not spam.
router.post('/nudge', authenticate, async (req, res, next) => {
    try {
        if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
        const { user_id, message } = req.body || {};
        if (!user_id) return res.status(400).json({ error: 'user_id is required' });

        const target = await query(adaptQuery('SELECT id, full_name FROM users WHERE id = $1 AND is_active = TRUE'), [user_id]);
        if (target.rows.length === 0) return res.status(404).json({ error: 'User not found' });

        const recent = await query(
            adaptQuery(`SELECT 1 FROM user_notifications
                        WHERE user_id = $1 AND type = 'nudge' AND created_at > NOW() - INTERVAL '24 hours'
                        LIMIT 1`),
            [user_id]
        );
        if (recent.rows.length > 0) {
            return res.status(409).json({ error: 'This user was already nudged in the last 24 hours' });
        }

        const title = 'Engagement check-in';
        const body = (message && String(message).trim().slice(0, 1000))
            || 'Your engagement is below the team\'s pace this week — let\'s pick it up.';
        const ins = await query(
            adaptQuery(`INSERT INTO user_notifications (user_id, type, title, body, link, created_by)
                        VALUES ($1, 'nudge', $2, $3, '/engagement', $4)
                        RETURNING id, created_at`),
            [user_id, title, body, req.user.id]
        );

        try {
            const { getIO } = require('../utils/websocket');
            const io = getIO();
            if (io) {
                io.to(`agent:${user_id}`).emit('user_notification', {
                    id: ins.rows[0]?.id,
                    type: 'nudge',
                    title,
                    body,
                    link: '/engagement',
                    created_at: ins.rows[0]?.created_at || new Date().toISOString(),
                });
            }
        } catch (wsErr) {
            logger.debug(`nudge WS emit skipped: ${wsErr.message}`);
        }

        res.status(201).json({ success: true, user_id, notification_id: ins.rows[0]?.id });
    } catch (err) { next(err); }
});

module.exports = router;
