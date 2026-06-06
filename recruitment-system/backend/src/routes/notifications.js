/**
 * Notifications Route
 * ===================
 * Live, read-only aggregation of actionable signals for the header bell.
 * No dedicated notifications table — everything is derived on the fly from
 * data we already store, so there is nothing to backfill or keep in sync:
 *   1. Candidates flagged for human handoff / intervention
 *   2. New applications in the last 48 hours
 *   3. Interviews scheduled for today
 *
 * GET /api/notifications  →  { items: [...], unread_count }
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { authenticate } = require('../middleware/auth');
const logger = require('../utils/logger');

router.get('/', authenticate, async (req, res, next) => {
    try {
        // 1) Candidates needing a human. The prod candidates table tracks this
        // with requires_human / is_human_handoff (+ escalation_reason) — there
        // is no intervention_needed column here.
        const interventions = await pool.query(
            `SELECT id, name, escalation_reason, updated_at
               FROM candidates
              WHERE requires_human IS TRUE OR is_human_handoff IS TRUE
              ORDER BY updated_at DESC NULLS LAST
              LIMIT 10`
        );

        // 2) Recent applications (last 48h).
        const recentApps = await pool.query(
            `SELECT a.id, a.applied_at, c.id AS candidate_id, c.name, j.title AS job_title
               FROM applications a
               JOIN candidates c ON a.candidate_id = c.id
               LEFT JOIN jobs j ON a.job_id = j.id
              WHERE a.applied_at >= NOW() - INTERVAL '48 hours'
              ORDER BY a.applied_at DESC
              LIMIT 10`
        );

        // 3) Interviews scheduled for today.
        const todayInterviews = await pool.query(
            `SELECT a.id, a.interview_datetime, c.id AS candidate_id, c.name, j.title AS job_title
               FROM applications a
               JOIN candidates c ON a.candidate_id = c.id
               LEFT JOIN jobs j ON a.job_id = j.id
              WHERE a.interview_datetime IS NOT NULL
                AND a.interview_datetime::date = CURRENT_DATE
              ORDER BY a.interview_datetime ASC
              LIMIT 10`
        );

        // 4) Pending certifications — how many candidates sit in an entry state
        //    awaiting a certify decision (summary, so it never floods the bell).
        const pendingCert = await pool.query(
            `SELECT COUNT(*)::int AS n, MAX(updated_at) AS latest
               FROM applications
              WHERE status = 'screening'`
        );

        // 5) Matches the auto-assign scorer flagged for manual verification
        //    (e.g. candidate gender unknown for a gendered vacancy — B013).
        const flagged = await pool.query(
            `SELECT a.id, a.updated_at, c.id AS candidate_id, c.name
               FROM applications a
               JOIN candidates c ON a.candidate_id = c.id
              WHERE a.screening_details::text ILIKE '%verify manually%'
              ORDER BY a.updated_at DESC NULLS LAST
              LIMIT 5`
        );

        // 6) CVs still stuck syncing from the chatbot (placeholder URLs).
        const stuckCvs = await pool.query(
            `SELECT cv.id, cv.uploaded_at, c.id AS candidate_id, c.name
               FROM cv_files cv
               JOIN candidates c ON cv.candidate_id = c.id
              WHERE cv.file_url LIKE 'chatbot://%'
              ORDER BY cv.uploaded_at DESC NULLS LAST
              LIMIT 5`
        );

        const items = [];
        for (const c of interventions.rows) {
            items.push({
                type: 'intervention',
                title: `${c.name || 'A candidate'} needs attention`,
                subtitle: c.escalation_reason || 'Human handoff requested',
                link: `/candidates/${c.id}`,
                at: c.updated_at,
            });
        }
        for (const a of recentApps.rows) {
            items.push({
                type: 'application',
                title: `${a.name || 'A candidate'} applied`,
                subtitle: a.job_title ? `for ${a.job_title}` : 'New application',
                link: `/candidates/${a.candidate_id}`,
                at: a.applied_at,
            });
        }
        for (const i of todayInterviews.rows) {
            items.push({
                type: 'interview',
                title: `Interview today — ${i.name || 'a candidate'}`,
                subtitle: i.job_title || 'Scheduled interview',
                link: `/candidates/${i.candidate_id}`,
                at: i.interview_datetime,
            });
        }
        const pc = pendingCert.rows[0];
        if (pc && pc.n > 0) {
            items.push({
                type: 'certification',
                title: `${pc.n} candidate${pc.n === 1 ? '' : 's'} awaiting certification`,
                subtitle: 'Review and certify',
                link: '/applications',
                at: pc.latest,
            });
        }
        for (const a of flagged.rows) {
            items.push({
                type: 'flag',
                title: `Verify ${a.name || 'a candidate'}`,
                subtitle: 'Auto-match flagged — confirm details (e.g. gender)',
                link: `/candidates/${a.candidate_id}`,
                at: a.updated_at,
            });
        }
        for (const cv of stuckCvs.rows) {
            items.push({
                type: 'cv_stuck',
                title: `CV still processing — ${cv.name || 'a candidate'}`,
                subtitle: 'Chatbot upload not yet synced',
                link: `/cv-manager?candidate=${cv.candidate_id}`,
                at: cv.uploaded_at,
            });
        }

        // Newest first across all signal types.
        items.sort((x, y) => new Date(y.at || 0) - new Date(x.at || 0));

        return res.json({ items, unread_count: items.length });
    } catch (error) {
        logger.error('Notifications fetch error:', error);
        return next(error);
    }
});

module.exports = router;
