/**
 * Analytics API Routes
 *
 * GET /api/analytics/overview              — Dashboard KPIs with real period-over-period
 * GET /api/analytics/jobs/:id/pipeline     — Funnel for a specific job
 * GET /api/analytics/recruiter-performance — Per-recruiter stats
 * GET /api/analytics/ad-performance        — Ad tracking conversions
 * GET /api/analytics/export                — CSV download
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { adaptQuery, isMySQL } = require('../utils/query-adapter');
const { authenticate } = require('../middleware/auth');
const logger = require('../utils/logger');

const PIPELINE_STATUS_ORDER = [
    'applied', 'reviewing', 'screening', 'certified',
    'interview_scheduled', 'interviewed', 'selected', 'placed',
    'rejected', 'transferred'
];

function formatStatusLabel(status = '') {
    return status
        .split('_')
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

// ── Overview KPIs ─────────────────────────────────────────────────────────────
router.get('/overview', authenticate, async (req, res, next) => {
    try {
        const { period = '30' } = req.query; // days
        const days = parseInt(period, 10) || 30;
        const prevDays = days * 2;
        const currentFrom = isMySQL
            ? `DATE_SUB(NOW(), INTERVAL ${days} DAY)`
            : `NOW() - INTERVAL '${days} days'`;
        const prevFrom = isMySQL
            ? `DATE_SUB(NOW(), INTERVAL ${prevDays} DAY)`
            : `NOW() - INTERVAL '${prevDays} days'`;
        const prevTo = currentFrom;
        const trendFrom = isMySQL
            ? 'DATE_SUB(NOW(), INTERVAL 56 DAY)'
            : "NOW() - INTERVAL '56 days'";
        const weeklyBucketExpr = isMySQL
            ? 'DATE_SUB(DATE(applied_at), INTERVAL WEEKDAY(applied_at) DAY)'
            : "date_trunc('week', applied_at)::date";
        const calendarFrom = isMySQL
            ? 'DATE_SUB(NOW(), INTERVAL 1 DAY)'
            : "NOW() - INTERVAL '1 day'";
        const calendarTo = isMySQL
            ? 'DATE_ADD(NOW(), INTERVAL 30 DAY)'
            : "NOW() + INTERVAL '30 days'";

        const [summary, prevSummary, funnel, recent, headlineStats, urgentProjects, interviewCalendar, recruiterSnapshot] = await Promise.all([
            // Current period
            query(adaptQuery(`
                SELECT
                    SUM(CASE WHEN status NOT IN ('rejected', 'transferred') THEN 1 ELSE 0 END) AS total_applications,
                    SUM(CASE WHEN status IN ('certified','interview_scheduled','interviewed','selected','placed') THEN 1 ELSE 0 END) AS certified,
                    SUM(CASE WHEN status IN ('selected', 'placed') THEN 1 ELSE 0 END) AS selected,
                    COUNT(DISTINCT candidate_id) AS unique_candidates
                FROM applications
                WHERE applied_at >= ${currentFrom}
            `)),
            // Previous period (for % change)
            query(adaptQuery(`
                SELECT
                    SUM(CASE WHEN status NOT IN ('rejected', 'transferred') THEN 1 ELSE 0 END) AS total_applications,
                    SUM(CASE WHEN status IN ('certified','interview_scheduled','interviewed','selected','placed') THEN 1 ELSE 0 END) AS certified,
                    SUM(CASE WHEN status IN ('selected', 'placed') THEN 1 ELSE 0 END) AS selected,
                    COUNT(DISTINCT candidate_id) AS unique_candidates
                FROM applications
                WHERE applied_at >= ${prevFrom}
                  AND applied_at < ${prevTo}
            `)),
            // Pipeline funnel (all time)
            query(adaptQuery(`
                SELECT status, COUNT(*) AS count
                FROM applications
                GROUP BY status
                ORDER BY count DESC
            `)),
            // Weekly trend (last 8 weeks)
            query(adaptQuery(`
                SELECT
                    ${weeklyBucketExpr} AS week,
                    COUNT(*) AS applications,
                    SUM(CASE WHEN status IN ('certified','interview_scheduled','interviewed','selected','placed') THEN 1 ELSE 0 END) AS certified
                FROM applications
                WHERE applied_at >= ${trendFrom}
                GROUP BY week
                ORDER BY week ASC
            `)),
            // Headline cards for dashboard
            query(adaptQuery(`
                SELECT
                    (SELECT COUNT(*) FROM jobs WHERE status = 'active') AS total_jobs,
                    (SELECT COUNT(*) FROM candidates) AS total_candidates,
                    (SELECT COUNT(*)
                     FROM interview_schedules
                     WHERE status IN ('scheduled','confirmed')
                       AND DATE(scheduled_datetime) = CURRENT_DATE) AS interviews_today
            `)),
            // Highest-priority projects for urgent dashboard widget
            query(adaptQuery(`
                SELECT
                    p.id,
                    p.title,
                    p.client_name,
                    p.status,
                    p.priority,
                    p.interview_date,
                    COUNT(DISTINCT j.id) AS total_jobs,
                    COUNT(DISTINCT a.id) AS total_applications,
                    COUNT(DISTINCT CASE WHEN a.status IN ('certified','interview_scheduled','interviewed') THEN a.id END) AS active_pipeline
                FROM projects p
                LEFT JOIN jobs j ON j.project_id = p.id
                LEFT JOIN applications a ON a.job_id = j.id
                WHERE p.status IN ('planning','active','on_hold')
                GROUP BY p.id
                ORDER BY
                    CASE WHEN p.priority = 'urgent' THEN 0 ELSE 1 END,
                    CASE WHEN p.interview_date IS NULL THEN 1 ELSE 0 END,
                    p.interview_date ASC,
                    p.created_at DESC
                LIMIT 6
            `)),
            // Interview calendar event list (next 30 days)
            query(adaptQuery(`
                SELECT
                    iv.id,
                    iv.scheduled_datetime,
                    iv.location,
                    iv.status,
                    c.id AS candidate_id,
                    c.name AS candidate_name,
                    j.id AS job_id,
                    j.title AS job_title,
                    p.id AS project_id,
                    p.title AS project_title
                FROM interview_schedules iv
                JOIN applications a ON iv.application_id = a.id
                JOIN candidates c ON a.candidate_id = c.id
                JOIN jobs j ON a.job_id = j.id
                LEFT JOIN projects p ON j.project_id = p.id
                WHERE iv.status IN ('scheduled','confirmed')
                                    AND iv.scheduled_datetime BETWEEN ${calendarFrom} AND ${calendarTo}
                ORDER BY iv.scheduled_datetime ASC
                LIMIT 120
            `)),
            // Recruiter mini snapshot
            query(adaptQuery(`
                SELECT
                    u.id AS user_id,
                    u.full_name,
                                        SUM(CASE WHEN a.certified_at >= ${currentFrom} THEN 1 ELSE 0 END) AS certified_count,
                                        SUM(CASE WHEN iv.created_at >= ${currentFrom} THEN 1 ELSE 0 END) AS interviews_created
                FROM users u
                LEFT JOIN applications a ON a.certified_by = u.id
                LEFT JOIN interview_schedules iv ON iv.created_by = u.id
                GROUP BY u.id, u.full_name
                ORDER BY certified_count DESC, interviews_created DESC
                LIMIT 5
            `))
        ]);

        const cur = summary.rows[0];
        const prev = prevSummary.rows[0];

        const pctChange = (curVal, prevVal) => {
            const c = parseInt(curVal || 0, 10);
            const p = parseInt(prevVal || 0, 10);
            if (p === 0) return c > 0 ? 100 : 0;
            return Math.round(((c - p) / p) * 100);
        };

        const totalApps = parseInt(cur.total_applications || 0, 10);
        const certifiedCount = parseInt(cur.certified || 0, 10);
        const conversionRate = totalApps > 0 ? Math.round((certifiedCount / totalApps) * 100) : 0;
        const cards = headlineStats.rows[0] || {};

        const prevTotalApps = parseInt(prev.total_applications || 0, 10);
        const prevCertified = parseInt(prev.certified || 0, 10);
        const prevConvRate = prevTotalApps > 0 ? Math.round((prevCertified / prevTotalApps) * 100) : 0;

        const funnelMap = {};
        funnel.rows.forEach((row) => {
            funnelMap[row.status] = parseInt(row.count || 0, 10);
        });

        const orderedPipeline = PIPELINE_STATUS_ORDER.map((status) => ({
            status,
            name: formatStatusLabel(status),
            count: funnelMap[status] || 0,
        }));

        res.json({
            period_days: days,
            stats: {
                totalApplications: totalApps,
                totalCandidates: parseInt(cards.total_candidates || 0, 10),
                totalJobs: parseInt(cards.total_jobs || 0, 10),
                activeInterviews: parseInt(cards.interviews_today || 0, 10)
            },
            applications: {
                value: totalApps,
                change_pct: pctChange(cur.total_applications, prev.total_applications)
            },
            certified: {
                value: certifiedCount,
                change_pct: pctChange(cur.certified, prev.certified)
            },
            selected: {
                value: parseInt(cur.selected || 0, 10),
                change_pct: pctChange(cur.selected, prev.selected)
            },
            unique_candidates: {
                value: parseInt(cur.unique_candidates || 0, 10),
                change_pct: pctChange(cur.unique_candidates, prev.unique_candidates)
            },
            conversion_rate: {
                value: conversionRate,
                change_pct: conversionRate - prevConvRate
            },
            pipeline: orderedPipeline,
            funnel: funnel.rows,
            weekly_trend: recent.rows,
            urgent_projects: urgentProjects.rows,
            interview_calendar: interviewCalendar.rows,
            recruiter_snapshot: recruiterSnapshot.rows
        });
    } catch (err) { next(err); }
});

// ── Job pipeline funnel ───────────────────────────────────────────────────────
router.get('/jobs/:id/pipeline', authenticate, async (req, res, next) => {
    try {
        const result = await query(
            adaptQuery(`
                SELECT status, COUNT(*) AS count
                FROM applications
                WHERE job_id = $1
                GROUP BY status
                ORDER BY count DESC
            `),
            [req.params.id]
        );

        const ORDER = ['applied','reviewing','screening','certified','interview_scheduled','interviewed','selected','placed','rejected','transferred'];
        const map = {};
        result.rows.forEach(r => { map[r.status] = parseInt(r.count, 10); });
        const funnel = ORDER.map(s => ({ status: s, count: map[s] || 0 }));

        res.json({ job_id: req.params.id, funnel });
    } catch (err) { next(err); }
});

// ── Recruiter performance ─────────────────────────────────────────────────────
router.get('/recruiter-performance', authenticate, async (req, res, next) => {
    try {
        const { period = '30' } = req.query;
        const days = parseInt(period, 10) || 30;

        const result = await query(adaptQuery(`
            SELECT
                u.id AS user_id,
                u.full_name,
                COUNT(a.id) AS total_certified,
                ROUND(AVG(EXTRACT(EPOCH FROM (a.certified_at - a.applied_at)) / 3600), 1) AS avg_hours_to_certify
            FROM users u
            LEFT JOIN applications a ON a.certified_by = u.id
                AND a.certified_at >= NOW() - INTERVAL '${days} days'
            GROUP BY u.id, u.full_name
            ORDER BY total_certified DESC
        `));

        res.json(result.rows);
    } catch (err) { next(err); }
});

// ── Ad performance ────────────────────────────────────────────────────────────
router.get('/ad-performance', authenticate, async (req, res, next) => {
    try {
        const result = await query(adaptQuery(`
            SELECT
                at2.id, at2.ad_ref, at2.campaign_name,
                j.title AS job_title,
                at2.clicks, at2.conversions,
                CASE WHEN at2.clicks > 0
                    THEN ROUND((at2.conversions::numeric / at2.clicks) * 100, 1)
                    ELSE 0
                END AS conversion_rate_pct,
                at2.is_active,
                at2.created_at
            FROM ad_tracking at2
            LEFT JOIN jobs j ON at2.job_id = j.id
            ORDER BY at2.conversions DESC, at2.clicks DESC
        `));
        res.json(result.rows);
    } catch (err) { next(err); }
});

// ── CSV export ────────────────────────────────────────────────────────────────
router.get('/export', authenticate, async (req, res, next) => {
    try {
        const { status, job_id, date_from, date_to } = req.query;
        const params = [];
        const conditions = ['1=1'];

        if (status) { params.push(status); conditions.push(`a.status = $${params.length}`); }
        if (job_id) { params.push(job_id); conditions.push(`a.job_id = $${params.length}`); }
        if (date_from) { params.push(date_from); conditions.push(`a.applied_at >= $${params.length}`); }
        if (date_to) { params.push(date_to); conditions.push(`a.applied_at <= $${params.length}`); }

        const result = await query(
            `SELECT
                c.name, c.phone, c.email, c.preferred_language,
                j.title AS job_title, p.title AS project_title, p.client_name,
                a.status, a.match_score,
                a.applied_at, a.certified_at,
                a.interview_datetime, a.interview_location,
                a.rejection_reason
            FROM applications a
            JOIN candidates c ON a.candidate_id = c.id
            JOIN jobs j ON a.job_id = j.id
            LEFT JOIN projects p ON j.project_id = p.id
            WHERE ${conditions.join(' AND ')}
            ORDER BY a.applied_at DESC
            LIMIT 5000`,
            params
        );

        const rows = result.rows;
        if (rows.length === 0) {
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename=recruitment_export.csv');
            return res.send('No data found\n');
        }

        const headers = Object.keys(rows[0]);
        const escape = (v) => {
            if (v == null) return '';
            const s = String(v).replace(/"/g, '""');
            return s.includes(',') || s.includes('\n') || s.includes('"') ? `"${s}"` : s;
        };
        const csv = [
            headers.join(','),
            ...rows.map(row => headers.map(h => escape(row[h])).join(','))
        ].join('\n');

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=recruitment_export.csv');
        res.send(csv);
    } catch (err) { next(err); }
});

module.exports = router;
