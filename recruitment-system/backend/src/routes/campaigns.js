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
const axios = require('axios');
const router = express.Router();
const { query, generateUUID } = require('../config/database');
const { adaptQuery } = require('../utils/query-adapter');
const { authenticate } = require('../middleware/auth');
const { requireSection } = require('../middleware/sections');
const { parseLoosePhone } = require('../utils/phone');
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

// ═══════════════════════════════════════════════════════════════════════════
// CSV BULK BLAST — upload arbitrary phone numbers, pick an approved Meta template,
// send to every number. Recipients are raw phones (candidate_id NULL); delivery
// receipts land on each recipient via /status-sync (migration 065).
// ═══════════════════════════════════════════════════════════════════════════

// Normalise + de-dupe a raw phone list. Returns { valid:[E.164…], invalid, duplicates }.
function classifyPhones(rawPhones) {
    const seen = new Set();
    const valid = [];
    let invalid = 0;
    let duplicates = 0;
    for (const raw of rawPhones) {
        const norm = parseLoosePhone(raw);
        if (!norm) { invalid += 1; continue; }
        if (seen.has(norm)) { duplicates += 1; continue; }
        seen.add(norm);
        valid.push(norm);
    }
    return { valid, invalid, duplicates };
}

// ── GET /templates — approved, ZERO-VARIABLE templates for the blast dropdown ─
// Proxies the chatbot (which holds the working Meta token + WABA id). Static-only
// blasts: a template with body variables can't be filled from a bare phone list.
router.get('/templates', authenticate, requireSection('control_tower', 'view'), async (req, res, next) => {
    try {
        const base = process.env.CHATBOT_API_URL;
        const key = process.env.CHATBOT_API_KEY;
        if (!base || !key) return res.status(503).json({ error: 'chatbot not configured', templates: [] });
        const resp = await axios.get(`${base.replace(/\/$/, '')}/webhook/templates`, {
            headers: { 'x-chatbot-api-key': key },
            timeout: 15000,
        });
        const all = (resp.data && resp.data.templates) || [];
        const usable = all.filter((t) => String(t.status).toUpperCase() === 'APPROVED' && Number(t.variable_count || 0) === 0);
        res.json({ templates: usable, all });
    } catch (err) {
        logger.warn(`campaign templates fetch failed: ${err.message}`);
        res.status(502).json({ error: 'could not fetch templates from chatbot', templates: [] });
    }
});

// ── POST /preview-numbers — dry-run classify a phone list (no writes) ─────────
router.post('/preview-numbers', authenticate, requireSection('control_tower', 'edit'), async (req, res, next) => {
    try {
        const phones = Array.isArray(req.body?.phones) ? req.body.phones : [];
        const { valid, invalid, duplicates } = classifyPhones(phones);
        res.json({ total: phones.length, valid: valid.length, invalid, duplicates, sample: valid.slice(0, 8) });
    } catch (err) { next(err); }
});

// ── POST /from-csv — create a CSV blast, snapshot numbers, kick the runner ────
router.post('/from-csv', authenticate, requireSection('control_tower', 'edit'), async (req, res, next) => {
    try {
        const { name, template_name, language = 'en', daily_cap, phones } = req.body || {};
        if (!template_name) return res.status(400).json({ error: 'template_name is required' });
        const list = Array.isArray(phones) ? phones : [];
        if (list.length === 0) return res.status(400).json({ error: 'phones array is required' });
        if (list.length > 60000) return res.status(413).json({ error: 'too many numbers in one blast (max 60000)' });

        const { valid, invalid, duplicates } = classifyPhones(list);
        if (valid.length === 0) return res.status(400).json({ error: 'no valid phone numbers found', invalid_count: invalid });

        const cap = Number.isFinite(Number(daily_cap)) && Number(daily_cap) > 0
            ? Math.floor(Number(daily_cap)) : DEFAULT_DAILY_CAP;

        const id = generateUUID();
        await query(adaptQuery(`
            INSERT INTO campaigns (id, name, template_name, language, status, daily_cap, source, created_by)
            VALUES ($1, $2, $3, $4, 'sending', $5, 'csv', $6)
        `), [id, name || 'CSV blast', template_name, language || 'en', cap, req.user.id]);

        // De-duped `valid` + a fresh campaign_id → one UNNEST insert, no ON CONFLICT.
        await query(
            `INSERT INTO campaign_recipients (campaign_id, phone, status)
             SELECT $1, p, 'pending' FROM unnest($2::text[]) AS p`,
            [id, valid]
        );
        await query(adaptQuery('UPDATE campaigns SET total = $1, updated_at = NOW() WHERE id = $2'), [valid.length, id]);
        campaignRunner.kickCampaign(id);

        logger.info(`CSV campaign ${id} by ${req.user.id}: ${valid.length} numbers (invalid ${invalid}, dup ${duplicates}), cap ${cap}, template ${template_name}`);
        res.status(201).json({ campaign_id: id, total: valid.length, invalid_count: invalid, duplicate_count: duplicates, daily_cap: cap });
    } catch (err) { next(err); }
});

// ── GET /:id/delivery — true receipt breakdown (sent/delivered/read/failed) ───
router.get('/:id/delivery', authenticate, requireSection('control_tower', 'view'), async (req, res, next) => {
    try {
        const r = await query(adaptQuery(`
            SELECT
              COUNT(*)::int AS total,
              SUM(CASE WHEN status='pending'  THEN 1 ELSE 0 END)::int AS pending,
              SUM(CASE WHEN status='sent'     THEN 1 ELSE 0 END)::int AS sent,
              SUM(CASE WHEN status='failed'   THEN 1 ELSE 0 END)::int AS failed,
              SUM(CASE WHEN status='skipped'  THEN 1 ELSE 0 END)::int AS skipped,
              SUM(CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END)::int AS delivered,
              SUM(CASE WHEN read_at IS NOT NULL THEN 1 ELSE 0 END)::int AS read
            FROM campaign_recipients WHERE campaign_id = $1
        `), [req.params.id]);
        res.json(r.rows[0] || {});
    } catch (err) { next(err); }
});

// ── GET /:id/failures — rows that failed / weren't delivered (for a CSV export)
router.get('/:id/failures', authenticate, requireSection('control_tower', 'view'), async (req, res, next) => {
    try {
        const r = await query(adaptQuery(`
            SELECT phone, status, reason, sent_at, delivered_at
            FROM campaign_recipients
            WHERE campaign_id = $1
              AND (status IN ('failed','skipped') OR (status='sent' AND delivered_at IS NULL))
            ORDER BY status, phone
            LIMIT 50000
        `), [req.params.id]);
        res.json({ rows: r.rows });
    } catch (err) { next(err); }
});

// ── POST /:id/retry-failed — re-queue transient failures (bounded by attempts) ─
router.post('/:id/retry-failed', authenticate, requireSection('control_tower', 'edit'), async (req, res, next) => {
    try {
        const r = await query(adaptQuery(`
            UPDATE campaign_recipients
            SET status = 'pending', reason = NULL
            WHERE campaign_id = $1 AND status = 'failed'
              AND COALESCE(reason,'other') IN ('rate_limited','token_expired','other')
              AND attempts < 3
        `), [req.params.id]);
        const requeued = Number(r.rowCount || 0);
        if (requeued > 0) {
            await query(adaptQuery("UPDATE campaigns SET status = 'sending', last_error = NULL, updated_at = NOW() WHERE id = $1 AND status IN ('done','paused')"), [req.params.id]);
            campaignRunner.kickCampaign(req.params.id);
        }
        res.json({ requeued });
    } catch (err) { next(err); }
});

module.exports = router;
