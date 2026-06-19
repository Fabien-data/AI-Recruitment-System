/**
 * Campaigns Route  (mounted at /api/communications/campaigns)
 * ===========================================================
 * Bulk WhatsApp template blast to "every candidate minus excluded projects",
 * with a paced, resumable server-side runner (services/campaignRunner.js).
 *
 *   POST /api/communications/campaigns/preview  — dry-run recipient count (no send)
 *   POST /api/communications/campaigns          — create + start a campaign
 *   GET  /api/communications/campaigns/:id       — live status for the progress UI
 *   POST /api/communications/campaigns/:id/pause  — pause the runner
 *   POST /api/communications/campaigns/:id/resume — resume the runner
 *
 * Gated on control_tower (admin + sourcing_department) — a mass marketing send.
 */

const express = require('express');
const router = express.Router();
const { query, generateUUID } = require('../config/database');
const { adaptQuery } = require('../utils/query-adapter');
const { authenticate } = require('../middleware/auth');
const { requireSection } = require('../middleware/sections');
const logger = require('../utils/logger');
const campaignRunner = require('../services/campaignRunner');

const DEFAULT_DAILY_CAP = parseInt(process.env.CAMPAIGN_DAILY_CAP, 10) || 1000;

// The recipient universe: every candidate with a usable WhatsApp number, deduped
// by phone, reachable, not removed/merged/hired, and NOT in any excluded project
// (a candidate is "in" a project if they have an application to a job in it).
// $1 = excluded project id array (uuid[]); empty array keeps everyone. Raw
// Postgres (prod is Cloud SQL/PG): DISTINCT ON + ANY(array) have no MySQL adapt.
const RECIPIENT_SQL = `
    SELECT DISTINCT ON (COALESCE(c.whatsapp_phone, c.phone))
           c.id, COALESCE(c.whatsapp_phone, c.phone) AS phone
    FROM candidates c
    WHERE c.removed_at IS NULL
      AND COALESCE(c.whatsapp_unreachable, FALSE) = FALSE
      AND COALESCE(c.whatsapp_phone, c.phone) IS NOT NULL
      AND COALESCE(c.status, '') NOT IN ('merged', 'hired')
      AND NOT EXISTS (
          SELECT 1 FROM applications a JOIN jobs j ON a.job_id = j.id
          WHERE a.candidate_id = c.id AND j.project_id = ANY($1::uuid[])
      )
    ORDER BY COALESCE(c.whatsapp_phone, c.phone), c.created_at ASC
`;

function cleanIdArray(v) {
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : [];
}

// ── POST /preview — dry-run recipient count + sample, no sends ────────────────
router.post('/preview', authenticate, requireSection('control_tower', 'edit'), async (req, res, next) => {
    try {
        const excluded = cleanIdArray(req.body?.excluded_project_ids);
        const countRes = await query(`SELECT COUNT(*)::int AS n FROM (${RECIPIENT_SQL}) t`, [excluded]);
        const sampleRes = await query(`
            SELECT t.id, t.phone, c.name
            FROM (${RECIPIENT_SQL}) t JOIN candidates c ON c.id = t.id
            LIMIT 8
        `, [excluded]);
        res.json({ count: countRes.rows[0].n, sample: sampleRes.rows });
    } catch (err) { next(err); }
});

// ── POST / — create the campaign, snapshot recipients, kick the runner ───────
router.post('/', authenticate, requireSection('control_tower', 'edit'), async (req, res, next) => {
    try {
        const {
            name,
            template_name,
            language = 'en',
            excluded_project_ids,
            target_project_id = null,
            target_job_id = null,
            target_job_id_female = null,
            daily_cap,
        } = req.body || {};

        if (!template_name) return res.status(400).json({ error: 'template_name is required' });

        const excluded = cleanIdArray(excluded_project_ids);
        const cap = Number.isFinite(Number(daily_cap)) && Number(daily_cap) > 0
            ? Math.floor(Number(daily_cap)) : DEFAULT_DAILY_CAP;

        const id = generateUUID();
        await query(adaptQuery(`
            INSERT INTO campaigns
                (id, name, template_name, language, target_project_id, target_job_id,
                 target_job_id_female, excluded_project_ids, status, daily_cap, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'sending', $9, $10)
        `), [
            id, name || 'Bulk campaign', template_name, language || 'en',
            target_project_id || null, target_job_id || null, target_job_id_female || null,
            JSON.stringify(excluded), cap, req.user.id,
        ]);

        // Snapshot the recipient set into the ledger (one statement, no 7k-row
        // round-trip). ON CONFLICT keeps re-creates idempotent.
        const ins = await query(`
            INSERT INTO campaign_recipients (campaign_id, candidate_id, phone, status)
            SELECT $2, t.id, t.phone, 'pending' FROM (${RECIPIENT_SQL}) t
            ON CONFLICT (campaign_id, candidate_id) DO NOTHING
        `, [excluded, id]);

        const total = ins.rowCount || 0;
        await query(adaptQuery('UPDATE campaigns SET total = $1, updated_at = NOW() WHERE id = $2'), [total, id]);

        if (total === 0) {
            await query(adaptQuery("UPDATE campaigns SET status = 'done' WHERE id = $1"), [id]);
        } else {
            campaignRunner.kickCampaign(id);
        }
        logger.info(`campaign ${id} created by ${req.user.id}: ${total} recipients, cap ${cap}, template ${template_name}`);
        res.status(201).json({ campaign_id: id, total, daily_cap: cap });
    } catch (err) { next(err); }
});

// ── GET /:id — live status (recompute rollup so the UI is always current) ─────
router.get('/:id', authenticate, requireSection('control_tower', 'view'), async (req, res, next) => {
    try {
        await campaignRunner.rollup(req.params.id);
        const r = await query(adaptQuery('SELECT * FROM campaigns WHERE id = $1'), [req.params.id]);
        if (r.rows.length === 0) return res.status(404).json({ error: 'Campaign not found' });
        res.json(r.rows[0]);
    } catch (err) { next(err); }
});

// ── POST /:id/pause + /:id/resume ────────────────────────────────────────────
router.post('/:id/pause', authenticate, requireSection('control_tower', 'edit'), async (req, res, next) => {
    try {
        await query(adaptQuery(
            "UPDATE campaigns SET status = 'paused', updated_at = NOW() WHERE id = $1 AND status = 'sending'"
        ), [req.params.id]);
        res.json({ ok: true });
    } catch (err) { next(err); }
});

router.post('/:id/resume', authenticate, requireSection('control_tower', 'edit'), async (req, res, next) => {
    try {
        await query(adaptQuery(
            "UPDATE campaigns SET status = 'sending', last_error = NULL, updated_at = NOW() WHERE id = $1 AND status = 'paused'"
        ), [req.params.id]);
        campaignRunner.kickCampaign(req.params.id);
        res.json({ ok: true });
    } catch (err) { next(err); }
});

module.exports = router;
