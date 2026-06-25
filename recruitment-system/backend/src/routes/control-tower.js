/**
 * Sourcing control tower — cross-project pipeline health (UPGRADES.md #3.3)
 * ========================================================================
 * One aggregated call (no N+1) returning every project's pipeline counts plus a
 * stuck-candidate SLA count (idle > N days), so sourcing can spot bottlenecks at
 * a glance. Gated on projects:view (sourcing + handler + admin; marketing is out).
 *
 *   GET /api/control-tower?days=<N>
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { adaptQuery } = require('../utils/query-adapter');
const { authenticate } = require('../middleware/auth');
const { requireSection } = require('../middleware/sections');

router.get('/', authenticate, requireSection('control_tower', 'view'), async (req, res, next) => {
    try {
        const days = String(Math.max(0, parseInt(req.query.days, 10) || 2));

        // Per-project pipeline counts (canonical application statuses).
        // Candidate-centric (COUNT(DISTINCT candidate_id)) so a candidate applying
        // to two jobs in the same project counts ONCE — keeps these numbers identical
        // to projects.js, conversation-counts.js and analytics.
        const projectsSql = adaptQuery(`
            SELECT p.id, p.title, p.status,
                   COUNT(DISTINCT j.id)                                                                AS job_count,
                   COUNT(DISTINCT a.candidate_id)                                                      AS total_applications,
                   COUNT(DISTINCT CASE WHEN a.status='screening'           THEN a.candidate_id END)    AS screening_count,
                   COUNT(DISTINCT CASE WHEN a.status='certified'           THEN a.candidate_id END)    AS certified_count,
                   COUNT(DISTINCT CASE WHEN a.status='interview_scheduled' THEN a.candidate_id END)    AS interview_count,
                   COUNT(DISTINCT CASE WHEN a.status='hired'               THEN a.candidate_id END)    AS hired_count
            FROM projects p
            LEFT JOIN jobs j         ON j.project_id = p.id
            LEFT JOIN applications a  ON a.job_id = j.id
            GROUP BY p.id, p.title, p.status
            ORDER BY COUNT(DISTINCT a.candidate_id) DESC, p.title ASC
        `);

        // Stuck candidates per project (idle > N days, early pipeline, no human flag).
        const stuckSql = adaptQuery(`
            SELECT j.project_id AS project_id, COUNT(DISTINCT c.id)::int AS stuck_count
            FROM candidates c
            JOIN applications a ON a.candidate_id = c.id
            JOIN jobs j         ON j.id = a.job_id
            WHERE c.status IN ('new','screening','certified')
              AND COALESCE(c.requires_human, FALSE) = FALSE
              AND COALESCE(c.last_interaction, c.created_at) < NOW() - ($1 || ' days')::interval
            GROUP BY j.project_id
        `);

        // Overall candidate pipeline summary.
        const pipelineSql = adaptQuery(`
            SELECT c.status, COUNT(*)::int AS n FROM candidates c
            WHERE c.status IN ('new','screening','certified','interview_scheduled','future_pool')
            GROUP BY c.status
        `);

        const [projectsR, stuckR, pipelineR] = await Promise.all([
            query(projectsSql, []),
            query(stuckSql, [days]),
            query(pipelineSql, []),
        ]);

        const stuckByProject = {};
        for (const row of stuckR.rows) stuckByProject[row.project_id] = row.stuck_count;
        const pipeline = pipelineR.rows.reduce((acc, x) => { acc[x.status] = x.n; return acc; }, {});

        const projects = projectsR.rows.map((p) => ({
            ...p,
            job_count: Number(p.job_count) || 0,
            total_applications: Number(p.total_applications) || 0,
            screening_count: Number(p.screening_count) || 0,
            certified_count: Number(p.certified_count) || 0,
            interview_count: Number(p.interview_count) || 0,
            hired_count: Number(p.hired_count) || 0,
            stuck_count: stuckByProject[p.id] || 0,
        }));

        res.json({
            days: Number(days),
            projects,
            pipeline,
            total_stuck: Object.values(stuckByProject).reduce((a, b) => a + b, 0),
            generated_at: new Date().toISOString(),
        });
    } catch (err) {
        next(err);
    }
});

module.exports = router;
