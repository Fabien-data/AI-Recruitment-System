/**
 * "My Work Today" — per-role landing queue (UPGRADES.md #3.0 / #3.1–3.4)
 * =====================================================================
 * One role-shaped payload of what needs action right now, backed by real data
 * (no cosmetic counts). Each role gets only the queues it works:
 *   project_handler    → new applicants · screenings due · interviews today
 *   marketing_agent    → needs-your-reply · no-answer catch-ups · new leads today
 *   sourcing_department→ stuck candidates (SLA) · screenings due · interviews today · pipeline
 *   admin              → pipeline summary (admin keeps the rich Dashboard on the FE)
 *
 *   GET /api/me/work-today
 *
 * Gated by requireSection('dashboard','view') — dashboard is universal, so every
 * role passes; the per-role SHAPE is what differs. Uses the canonical status
 * vocabulary + the shared CV-present test (hasCvSql) from Phase 0.
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { adaptQuery } = require('../utils/query-adapter');
const { authenticate } = require('../middleware/auth');
const { requireSection } = require('../middleware/sections');
const { hasCvSql } = require('../services/candidate-stage');

const rows = async (sql, params = []) => (await query(adaptQuery(sql), params)).rows;
const count = async (sql, params = []) => {
    const r = await query(adaptQuery(sql), params);
    return parseInt(r.rows[0]?.n, 10) || 0;
};

// ── Shared building blocks ──────────────────────────────────────────────────
const interviewsToday = () => rows(`
    SELECT iv.id, iv.scheduled_datetime,
           c.id AS candidate_id, c.name AS candidate_name,
           j.title AS job_title
    FROM interview_schedules iv
    JOIN applications a ON iv.application_id = a.id
    JOIN candidates  c ON a.candidate_id = c.id
    JOIN jobs        j ON a.job_id = j.id
    WHERE iv.status IN ('scheduled','confirmed')
      AND iv.scheduled_datetime::date = CURRENT_DATE
    ORDER BY iv.scheduled_datetime ASC
    LIMIT 25
`);

const newApplicants = () => rows(`
    SELECT a.id AS application_id, COALESCE(a.updated_at, a.applied_at) AS at,
           c.id AS candidate_id, c.name AS candidate_name,
           j.title AS job_title, p.title AS project_title
    FROM applications a
    JOIN candidates c ON c.id = a.candidate_id
    JOIN jobs       j ON j.id = a.job_id
    LEFT JOIN projects p ON p.id = j.project_id
    WHERE a.status = 'screening'
      AND ${hasCvSql('c')}
    ORDER BY COALESCE(a.updated_at, a.applied_at) DESC NULLS LAST
    LIMIT 10
`);

const screeningsDueCount = () => count(`
    SELECT COUNT(*)::int AS n FROM candidates c
    WHERE c.status = 'screening' AND ${hasCvSql('c')}
`);

// New leads with no CV on file — the conversion leak (#7).
const awaitingCvCount = () => count(`
    SELECT COUNT(*)::int AS n FROM candidates c
    WHERE c.status = 'new' AND NOT ${hasCvSql('c')}
`);

const pipelineSummary = async () => {
    const r = await rows(`
        SELECT c.status, COUNT(*)::int AS n
        FROM candidates c
        WHERE c.status IN ('new','screening','certified','interview_scheduled','future_pool')
        GROUP BY c.status
    `);
    return r.reduce((acc, x) => { acc[x.status] = x.n; return acc; }, {});
};

router.get('/work-today', authenticate, requireSection('dashboard', 'view'), async (req, res, next) => {
    try {
        const role = req.user.role;
        const me = req.user.id;
        let queues = {};

        if (role === 'project_handler') {
            const [newApps, screeningsDue, interviews, awaitingCv] = await Promise.all([
                newApplicants(), screeningsDueCount(), interviewsToday(), awaitingCvCount(),
            ]);
            queues = { new_applicants: newApps, screenings_due: screeningsDue, interviews_today: interviews, awaiting_cv: awaitingCv };

        } else if (role === 'marketing_agent') {
            const [needsReply, catchups, newLeads, awaitingCv] = await Promise.all([
                rows(`
                    SELECT c.id, c.name, c.phone, c.status, c.last_interaction
                    FROM candidates c
                    WHERE (COALESCE(c.requires_human, FALSE) = TRUE OR COALESCE(c.is_human_handoff, FALSE) = TRUE)
                    ORDER BY c.last_interaction DESC NULLS LAST
                    LIMIT 15
                `),
                rows(`
                    SELECT t.id, t.candidate_id, t.due_at, c.name AS candidate_name, c.phone
                    FROM candidate_tasks t
                    JOIN candidates c ON c.id = t.candidate_id
                    WHERE t.task_type = 'no_answer' AND t.status = 'pending' AND t.due_at <= NOW()
                      AND (t.assigned_to = $1 OR t.assigned_to IS NULL)
                    ORDER BY t.due_at ASC
                    LIMIT 15
                `, [me]),
                rows(`
                    SELECT c.id, c.name, c.phone, c.status, c.created_at
                    FROM candidates c
                    WHERE c.created_at::date = CURRENT_DATE
                    ORDER BY c.created_at DESC
                    LIMIT 15
                `),
                awaitingCvCount(),
            ]);
            queues = { needs_reply: needsReply, no_answer_catchups: catchups, new_leads_today: newLeads, awaiting_cv: awaitingCv };

        } else if (role === 'sourcing_department') {
            const [stuck, screeningsDue, interviews, pipeline, awaitingCv] = await Promise.all([
                rows(`
                    SELECT c.id, c.name, c.status, c.last_interaction, c.created_at,
                           EXTRACT(EPOCH FROM (NOW() - COALESCE(c.last_interaction, c.created_at))) / 86400.0 AS days_idle
                    FROM candidates c
                    WHERE c.status IN ('new','screening','certified')
                      AND COALESCE(c.requires_human, FALSE) = FALSE
                      AND COALESCE(c.last_interaction, c.created_at) < NOW() - INTERVAL '2 days'
                    ORDER BY COALESCE(c.last_interaction, c.created_at) ASC
                    LIMIT 15
                `),
                screeningsDueCount(), interviewsToday(), pipelineSummary(), awaitingCvCount(),
            ]);
            queues = { stuck_candidates: stuck, screenings_due: screeningsDue, interviews_today: interviews, pipeline, awaiting_cv: awaitingCv };

        } else { // admin (FE renders the existing Dashboard) — return a harmless summary
            queues = { pipeline: await pipelineSummary() };
        }

        res.json({ role, queues, generated_at: new Date().toISOString() });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
