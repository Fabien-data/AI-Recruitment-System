/**
 * Marketing Hub Analytics Routes
 * ==============================
 * Lead funnel, source/agent breakdowns, time-series, cohort retention,
 * time-to-stage histograms, and CSV export. Restricted to admin +
 * sourcing_department; marketing agents are deliberately excluded so
 * their workspace stays focused on lead-handling.
 *
 * Mounted at /api/marketing-hub/analytics BEFORE the broader marketing-hub
 * router so the prefix wins.
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const logger = require('../utils/logger');

const ANALYTICS_ROLES = ['admin', 'sourcing_department'];

function rangeToDays(range) {
    if (range === '7d') return 7;
    if (range === '90d') return 90;
    if (range === '180d') return 180;
    return 30;
}

// ── GET /overview ──────────────────────────────────────────────────────────
// KPI cards. Returns counts for the requested range and the previous range
// of the same length so the UI can render % deltas.
router.get('/overview', authenticate, authorize(...ANALYTICS_ROLES), async (req, res, next) => {
    try {
        const days = rangeToDays(req.query.range);

        const stats = await query(
            `WITH
              current_period AS (
                SELECT * FROM marketing_leads
                WHERE created_at >= NOW() - ($1 || ' days')::interval
              ),
              previous_period AS (
                SELECT * FROM marketing_leads
                WHERE created_at >= NOW() - ($1 * 2 || ' days')::interval
                  AND created_at <  NOW() - ($1 || ' days')::interval
              )
             SELECT
               (SELECT COUNT(*) FROM current_period)                                                   AS new_leads,
               (SELECT COUNT(*) FROM current_period WHERE stage IN ('contacted','qualified','converted')) AS contacted,
               (SELECT COUNT(*) FROM current_period WHERE stage IN ('qualified','converted'))            AS qualified,
               (SELECT COUNT(*) FROM current_period WHERE stage = 'converted')                          AS converted,
               (SELECT COUNT(*) FROM current_period WHERE stage = 'lost')                               AS lost,
               (SELECT COUNT(*) FROM previous_period)                                                  AS prev_new_leads,
               (SELECT COUNT(*) FROM previous_period WHERE stage = 'converted')                        AS prev_converted,
               (SELECT AVG(EXTRACT(EPOCH FROM (converted_at - created_at)) / 3600)
                  FROM current_period WHERE converted_at IS NOT NULL)                                  AS avg_hours_to_convert,
               (SELECT COUNT(DISTINCT call_id) FROM lead_call_events
                  WHERE occurred_at >= NOW() - ($1 || ' days')::interval)                              AS calls_handled
            `,
            [days]
        );

        const r = stats.rows[0] || {};
        const newLeads = Number(r.new_leads) || 0;
        const converted = Number(r.converted) || 0;
        const prevNewLeads = Number(r.prev_new_leads) || 0;
        const prevConverted = Number(r.prev_converted) || 0;

        const conversion_rate = newLeads ? converted / newLeads : 0;
        const prev_conversion_rate = prevNewLeads ? prevConverted / prevNewLeads : 0;

        res.json({
            range_days: days,
            new_leads: newLeads,
            contacted: Number(r.contacted) || 0,
            qualified: Number(r.qualified) || 0,
            converted,
            lost: Number(r.lost) || 0,
            conversion_rate,
            avg_hours_to_convert: r.avg_hours_to_convert != null ? Number(r.avg_hours_to_convert) : null,
            calls_handled: Number(r.calls_handled) || 0,
            previous: {
                new_leads: prevNewLeads,
                converted: prevConverted,
                conversion_rate: prev_conversion_rate,
            },
            deltas: {
                new_leads_pct: prevNewLeads ? ((newLeads - prevNewLeads) / prevNewLeads) : null,
                converted_pct: prevConverted ? ((converted - prevConverted) / prevConverted) : null,
                conversion_rate_pp: conversion_rate - prev_conversion_rate,
            },
        });
    } catch (err) {
        logger.error(`marketing analytics overview error: ${err.message}`);
        next(err);
    }
});

// ── GET /funnel ────────────────────────────────────────────────────────────
// Snapshot funnel across the requested range (or all-time if range omitted).
router.get('/funnel', authenticate, authorize(...ANALYTICS_ROLES), async (req, res, next) => {
    try {
        const days = rangeToDays(req.query.range);
        const result = await query(
            `SELECT stage, COUNT(*)::int AS count
             FROM marketing_leads
             WHERE created_at >= NOW() - ($1 || ' days')::interval
             GROUP BY stage`,
            [days]
        );

        const order = ['new', 'contacted', 'qualified', 'converted', 'lost'];
        const map = Object.fromEntries(result.rows.map((r) => [r.stage, r.count]));
        res.json(order.map((stage) => ({ stage, count: map[stage] || 0 })));
    } catch (err) {
        next(err);
    }
});

// ── GET /by-source ─────────────────────────────────────────────────────────
router.get('/by-source', authenticate, authorize(...ANALYTICS_ROLES), async (req, res, next) => {
    try {
        const days = rangeToDays(req.query.range);
        const result = await query(
            `SELECT
                COALESCE(ls.label, '— Unknown —')                          AS source_label,
                ls.slug                                                    AS source_slug,
                COUNT(*)::int                                              AS total,
                COUNT(*) FILTER (WHERE ml.stage = 'converted')::int        AS converted,
                COUNT(*) FILTER (WHERE ml.stage IN ('qualified','converted'))::int AS qualified
             FROM marketing_leads ml
             LEFT JOIN lead_sources ls ON ml.source_id = ls.id
             WHERE ml.created_at >= NOW() - ($1 || ' days')::interval
             GROUP BY ls.label, ls.slug
             ORDER BY total DESC`,
            [days]
        );
        const rows = result.rows.map((r) => ({
            ...r,
            conversion_rate: r.total ? r.converted / r.total : 0,
        }));
        res.json(rows);
    } catch (err) {
        next(err);
    }
});

// ── GET /by-agent ──────────────────────────────────────────────────────────
router.get('/by-agent', authenticate, authorize(...ANALYTICS_ROLES), async (req, res, next) => {
    try {
        const days = rangeToDays(req.query.range);
        const result = await query(
            `WITH agent_leads AS (
                SELECT
                    u.id   AS agent_id,
                    u.full_name AS agent_name,
                    COUNT(ml.id)::int                                          AS leads_assigned,
                    COUNT(ml.id) FILTER (WHERE ml.stage = 'converted')::int    AS converted
                FROM users u
                LEFT JOIN marketing_leads ml
                    ON ml.assigned_agent_id = u.id
                   AND ml.created_at >= NOW() - ($1 || ' days')::interval
                WHERE u.role IN ('marketing_agent','admin','sourcing_department')
                GROUP BY u.id, u.full_name
             ),
             agent_calls AS (
                SELECT
                    agent_user_id                                         AS agent_id,
                    COUNT(DISTINCT call_id)::int                          AS calls_handled,
                    AVG(duration_seconds)::int                            AS avg_call_seconds
                FROM lead_call_events
                WHERE occurred_at >= NOW() - ($1 || ' days')::interval
                  AND agent_user_id IS NOT NULL
                GROUP BY agent_user_id
             )
             SELECT
                al.agent_id, al.agent_name, al.leads_assigned, al.converted,
                COALESCE(ac.calls_handled, 0)  AS calls_handled,
                COALESCE(ac.avg_call_seconds, 0) AS avg_call_seconds
             FROM agent_leads al
             LEFT JOIN agent_calls ac ON ac.agent_id = al.agent_id
             WHERE al.leads_assigned > 0 OR COALESCE(ac.calls_handled, 0) > 0
             ORDER BY al.converted DESC, al.leads_assigned DESC`,
            [days]
        );
        res.json(result.rows.map((r) => ({
            ...r,
            conversion_rate: r.leads_assigned ? r.converted / r.leads_assigned : 0,
        })));
    } catch (err) {
        next(err);
    }
});

// ── GET /timeseries?metric=… ───────────────────────────────────────────────
router.get('/timeseries', authenticate, authorize(...ANALYTICS_ROLES), async (req, res, next) => {
    try {
        const days = rangeToDays(req.query.range);
        const result = await query(
            `WITH days AS (
                SELECT generate_series(
                    (NOW() - ($1 || ' days')::interval)::date,
                    NOW()::date,
                    INTERVAL '1 day'
                )::date AS day
             )
             SELECT
                d.day,
                COUNT(ml.id) FILTER (WHERE ml.created_at::date = d.day)::int                          AS new_leads,
                COUNT(ml.id) FILTER (WHERE ml.converted_at IS NOT NULL AND ml.converted_at::date = d.day)::int AS converted,
                COUNT(ce.call_id) FILTER (WHERE ce.occurred_at::date = d.day)::int                    AS calls
             FROM days d
             LEFT JOIN marketing_leads ml ON ml.created_at::date = d.day OR ml.converted_at::date = d.day
             LEFT JOIN lead_call_events ce ON ce.occurred_at::date = d.day
             GROUP BY d.day
             ORDER BY d.day ASC`,
            [days]
        );
        res.json(result.rows);
    } catch (err) {
        next(err);
    }
});

// ── GET /cohort ────────────────────────────────────────────────────────────
// Weekly cohort retention: for each week of created_at, what % of leads
// reached each downstream stage. Surfaces slow-converting cohorts.
router.get('/cohort', authenticate, authorize(...ANALYTICS_ROLES), async (req, res, next) => {
    try {
        const days = rangeToDays(req.query.range);
        const result = await query(
            `SELECT
                DATE_TRUNC('week', created_at)::date                            AS week,
                COUNT(*)::int                                                   AS total,
                COUNT(*) FILTER (WHERE stage IN ('contacted','qualified','converted'))::int AS contacted,
                COUNT(*) FILTER (WHERE stage IN ('qualified','converted'))::int             AS qualified,
                COUNT(*) FILTER (WHERE stage = 'converted')::int                            AS converted
             FROM marketing_leads
             WHERE created_at >= NOW() - ($1 || ' days')::interval
             GROUP BY DATE_TRUNC('week', created_at)
             ORDER BY week DESC`,
            [days]
        );
        res.json(result.rows);
    } catch (err) {
        next(err);
    }
});

// ── GET /time-to-stage ────────────────────────────────────────────────────
// Distribution of hours from new → converted. Histogram bucket counts.
router.get('/time-to-stage', authenticate, authorize(...ANALYTICS_ROLES), async (req, res, next) => {
    try {
        const days = rangeToDays(req.query.range);
        const result = await query(
            `WITH conv AS (
                SELECT EXTRACT(EPOCH FROM (converted_at - created_at)) / 3600 AS hours
                FROM marketing_leads
                WHERE converted_at IS NOT NULL
                  AND created_at >= NOW() - ($1 || ' days')::interval
             )
             SELECT bucket, COUNT(*)::int AS count FROM (
                SELECT CASE
                    WHEN hours <  1   THEN '<1h'
                    WHEN hours <  4   THEN '1-4h'
                    WHEN hours <  24  THEN '4-24h'
                    WHEN hours <  72  THEN '1-3d'
                    WHEN hours < 168  THEN '3-7d'
                    ELSE '7d+'
                END AS bucket
                FROM conv
             ) b
             GROUP BY bucket
             ORDER BY CASE bucket
                WHEN '<1h'  THEN 1
                WHEN '1-4h' THEN 2
                WHEN '4-24h' THEN 3
                WHEN '1-3d' THEN 4
                WHEN '3-7d' THEN 5
                ELSE 6
             END`,
            [days]
        );
        res.json(result.rows);
    } catch (err) {
        next(err);
    }
});

// ── GET /export.csv ───────────────────────────────────────────────────────
router.get('/export.csv', authenticate, authorize(...ANALYTICS_ROLES), async (req, res, next) => {
    try {
        const days = rangeToDays(req.query.range);
        const result = await query(
            `SELECT
                ml.id, ml.full_name, ml.phone, ml.nic, ml.country, ml.stage,
                ml.preferred_job_text,
                j.title              AS preferred_job_title,
                ls.label             AS source_label,
                ml.campaign_ref,
                u.full_name          AS assigned_agent,
                ml.converted_candidate_id,
                ml.created_at, ml.converted_at, ml.last_contacted_at
             FROM marketing_leads ml
             LEFT JOIN jobs j ON ml.preferred_job_id = j.id
             LEFT JOIN lead_sources ls ON ml.source_id = ls.id
             LEFT JOIN users u ON ml.assigned_agent_id = u.id
             WHERE ml.created_at >= NOW() - ($1 || ' days')::interval
             ORDER BY ml.created_at DESC`,
            [days]
        );

        const rows = result.rows;
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=marketing_leads_${days}d.csv`);

        if (rows.length === 0) {
            return res.send('No data found\n');
        }

        const headers = Object.keys(rows[0]);
        const escape = (v) => {
            if (v == null) return '';
            const s = String(v);
            return s.includes(',') || s.includes('\n') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const csv = [
            headers.join(','),
            ...rows.map((row) => headers.map((h) => escape(row[h])).join(',')),
        ].join('\n');

        res.send(csv);
    } catch (err) {
        next(err);
    }
});

module.exports = router;
