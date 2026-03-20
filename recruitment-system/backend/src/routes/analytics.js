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
const { adaptQuery } = require('../utils/query-adapter');
const { authenticate } = require('../middleware/auth');
const logger = require('../utils/logger');

// ── Overview KPIs ─────────────────────────────────────────────────────────────
router.get('/overview', authenticate, async (req, res, next) => {
    try {
        const { period = '30' } = req.query; // days
        const days = parseInt(period, 10) || 30;
        const prevDays = days * 2;

        const [summary, prevSummary, funnel, recent] = await Promise.all([
            // Current period
            query(adaptQuery(`
                SELECT
                    COUNT(*) FILTER (WHERE status != 'rejected' AND status != 'transferred') AS total_applications,
                    COUNT(*) FILTER (WHERE status IN ('certified','interview_scheduled','interviewed','selected','placed')) AS certified,
                    COUNT(*) FILTER (WHERE status = 'selected' OR status = 'placed') AS selected,
                    COUNT(DISTINCT candidate_id) AS unique_candidates
                FROM applications
                WHERE applied_at >= NOW() - INTERVAL '${days} days'
            `)),
            // Previous period (for % change)
            query(adaptQuery(`
                SELECT
                    COUNT(*) FILTER (WHERE status != 'rejected' AND status != 'transferred') AS total_applications,
                    COUNT(*) FILTER (WHERE status IN ('certified','interview_scheduled','interviewed','selected','placed')) AS certified,
                    COUNT(*) FILTER (WHERE status = 'selected' OR status = 'placed') AS selected,
                    COUNT(DISTINCT candidate_id) AS unique_candidates
                FROM applications
                WHERE applied_at >= NOW() - INTERVAL '${prevDays} days'
                  AND applied_at < NOW() - INTERVAL '${days} days'
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
                    date_trunc('week', applied_at) AS week,
                    COUNT(*) AS applications,
                    COUNT(*) FILTER (WHERE status IN ('certified','interview_scheduled','interviewed','selected','placed')) AS certified
                FROM applications
                WHERE applied_at >= NOW() - INTERVAL '56 days'
                GROUP BY week
                ORDER BY week ASC
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

        const prevTotalApps = parseInt(prev.total_applications || 0, 10);
        const prevCertified = parseInt(prev.certified || 0, 10);
        const prevConvRate = prevTotalApps > 0 ? Math.round((prevCertified / prevTotalApps) * 100) : 0;

        res.json({
            period_days: days,
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
            funnel: funnel.rows,
            weekly_trend: recent.rows
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
