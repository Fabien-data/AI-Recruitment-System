/**
 * Ad Links Route
 * ==============
 * Generate and manage Meta Click-to-WhatsApp ad links per job.
 * Each link encodes a unique ad_ref that the chatbot uses to load
 * job context and track where the candidate came from.
 *
 * Auth: JWT (recruiter must be logged in)
 *
 * POST   /api/ad-links/generate        — Generate new link for a job
 * GET    /api/ad-links                 — List all links (with stats)
 * GET    /api/ad-links/:ad_ref         — Get single link details
 * PATCH  /api/ad-links/:ad_ref/toggle  — Enable/disable a link
 * DELETE /api/ad-links/:ad_ref         — Delete a link
 */

const express = require('express');
const router = express.Router();
const { query, generateUUID } = require('../config/database');
const { isMySQL } = require('../utils/query-adapter');
const { authenticate, authorize } = require('../middleware/auth');
const { syncJobAsync, syncJobDeleteAsync } = require('./chatbot-sync');
const logger = require('../utils/logger');
const crypto = require('crypto');

// Keep the chatbot's "advertised jobs" view in sync with ad-campaign changes.
// A job is visible to the bot's cold-path / cross-suggestion logic only while
// it has >=1 active ad_tracking row. Pushing/deleting the job to the chatbot
// here makes that reflect within seconds instead of waiting for the 5-min
// bootstrap reconcile.
async function _resyncJobAdVisibility(jobId) {
    if (!jobId) return;
    try {
        const countSQL = isMySQL
            ? 'SELECT COUNT(*) AS n FROM ad_tracking WHERE job_id = ? AND is_active = 1'
            : 'SELECT COUNT(*)::int AS n FROM ad_tracking WHERE job_id::uuid = $1::uuid AND is_active = TRUE';
        const r = await query(countSQL, [jobId]);
        const activeAds = parseInt((r.rows[0] && r.rows[0].n) || 0, 10);
        if (activeAds > 0) {
            await syncJobAsync(jobId);
        } else {
            await syncJobDeleteAsync(jobId);
        }
    } catch (err) {
        logger.warn(`Ad-visibility chatbot resync failed for job ${jobId}: ${err.message}`);
    }
}

// ── Helper: generate a short unique ad_ref ────────────────────────────────────
// Format: "job_" + 8 random hex chars → e.g. "job_3f9a12b4"
function generateAdRef(jobTitle = '') {
    const slug = jobTitle
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 12);
    const randomSuffix = crypto.randomBytes(4).toString('hex');
    return slug ? `${slug}_${randomSuffix}` : `job_${randomSuffix}`;
}

// ── Helper: build WhatsApp deep links ────────────────────────────────────────
function buildWhatsAppLink(phoneNumber, adRef) {
    const encodedMessage = encodeURIComponent(`START:${adRef}`);
    return `https://wa.me/${phoneNumber.replace(/\+/g, '')}?text=${encodedMessage}`;
}

function buildMetaAdUrl(phoneNumber, adRef) {
    // Meta Click-to-WhatsApp ads use this format in the ad destination URL
    return `https://wa.me/${phoneNumber.replace(/\+/g, '')}?text=START%3A${adRef}`;
}

// ── POST /api/ad-links/generate ───────────────────────────────────────────────
router.post(
    '/generate',
    authenticate,
    authorize('admin', 'sourcing_department'),
    async (req, res) => {
        const { job_id, project_id, campaign_name, ad_ref: customAdRef } = req.body;

        if (!job_id || !project_id) {
            return res.status(400).json({ error: 'job_id and project_id are required' });
        }

        try {
            // Verify job exists and belongs to project
            const jobSQL = isMySQL
                ? `SELECT j.id, j.title, j.status, p.id as p_id, p.title as project_title
                   FROM jobs j JOIN projects p ON j.project_id = p.id
                   WHERE j.id = ? AND j.project_id = ?`
                : `SELECT j.id, j.title, j.status, p.id as p_id, p.title as project_title
                   FROM jobs j JOIN projects p ON j.project_id = p.id
                   WHERE j.id = $1 AND j.project_id = $2`;

            const jobResult = await query(jobSQL, [job_id, project_id]);

            if (jobResult.rows.length === 0) {
                return res.status(404).json({
                    error: 'Job not found or does not belong to the specified project'
                });
            }

            const job = jobResult.rows[0];
            const whatsappPhone = process.env.WHATSAPP_PHONE_NUMBER || '';

            if (!whatsappPhone) {
                return res.status(500).json({
                    error: 'WHATSAPP_PHONE_NUMBER is not configured on the server'
                });
            }

            // Caller supplied a custom ad_ref → check collision up-front and
            // return 409 with the existing campaign details (better UX than
            // letting the UNIQUE constraint fail mid-INSERT).
            let adRef;
            if (customAdRef) {
                if (typeof customAdRef !== 'string' || !/^[A-Za-z0-9_\-]{3,100}$/.test(customAdRef)) {
                    return res.status(400).json({
                        error: 'ad_ref must be 3–100 chars, [A-Za-z0-9_-] only'
                    });
                }
                const collisionSQL = isMySQL
                    ? `SELECT id, ad_ref, campaign_name, job_id, is_active
                         FROM ad_tracking WHERE ad_ref = ? LIMIT 1`
                    : `SELECT id, ad_ref, campaign_name, job_id, is_active
                         FROM ad_tracking WHERE ad_ref = $1 LIMIT 1`;
                const collision = await query(collisionSQL, [customAdRef]);
                if (collision.rows.length > 0) {
                    const existing = collision.rows[0];
                    return res.status(409).json({
                        error: 'ad_ref already in use',
                        existing_campaign: existing.campaign_name,
                        existing_job_id: existing.job_id,
                        is_active: Boolean(existing.is_active),
                        ad_ref: existing.ad_ref
                    });
                }
                adRef = customAdRef;
            } else {
                // Generate unique ad_ref (retry if collision)
                let attempts = 0;
                while (attempts < 5) {
                    adRef = generateAdRef(job.title);
                    const checkSQL = isMySQL
                        ? 'SELECT id FROM ad_tracking WHERE ad_ref = ? LIMIT 1'
                        : 'SELECT id FROM ad_tracking WHERE ad_ref = $1 LIMIT 1';
                    const checkResult = await query(checkSQL, [adRef]);
                    if (checkResult.rows.length === 0) break;
                    attempts++;
                }
            }

            const waLink = buildWhatsAppLink(whatsappPhone, adRef);
            const metaUrl = buildMetaAdUrl(whatsappPhone, adRef);
            const trackingId = generateUUID();

            // Insert into ad_tracking
            const insertSQL = isMySQL
                ? `INSERT INTO ad_tracking
                    (id, ad_ref, job_id, project_id, campaign_name, whatsapp_link,
                     clicks, conversions, is_active, created_by, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, 0, 0, 1, ?, NOW(), NOW())`
                : `INSERT INTO ad_tracking
                    (id, ad_ref, job_id, project_id, campaign_name, whatsapp_link,
                     clicks, conversions, is_active, created_by)
                   VALUES ($1, $2, $3, $4, $5, $6, 0, 0, TRUE, $7)`;

            await query(insertSQL, [
                trackingId,
                adRef,
                job_id,
                project_id,
                campaign_name || `${job.title} Campaign`,
                waLink,
                req.user.id
            ]);

            logger.info(`Ad link generated: ${adRef} for job ${job.title} by user ${req.user.id}`);

            // Make the bot aware of this now-advertised job within seconds.
            _resyncJobAdVisibility(job_id);

            return res.status(201).json({
                id: trackingId,
                ad_ref: adRef,
                job_id,
                project_id,
                job_title: job.title,
                project_title: job.project_title,
                campaign_name: campaign_name || `${job.title} Campaign`,
                whatsapp_link: waLink,
                meta_ad_url: metaUrl,
                qr_code_url: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(waLink)}`,
                start_message: `START:${adRef}`,
                instructions: {
                    step1: 'Copy the meta_ad_url and paste it into your Meta Ad "Website URL" field',
                    step2: 'Share whatsapp_link via QR code or direct link',
                    step3: 'When users click, WhatsApp opens and automatically sends the START message',
                    step4: 'The chatbot reads the START message and loads this job context automatically'
                }
            });
        } catch (error) {
            logger.error('Ad link generation error:', error);
            return res.status(500).json({ error: 'Failed to generate ad link' });
        }
    }
);

// ── GET /api/ad-links ─────────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
    const { project_id, job_id, active_only = 'false' } = req.query;

    try {
        let whereClause = 'WHERE 1=1';
        const params = [];
        let pc = 1;

        if (project_id) {
            whereClause += isMySQL ? ' AND at.project_id = ?' : ` AND at.project_id = $${pc++}`;
            params.push(project_id);
        }
        if (job_id) {
            whereClause += isMySQL ? ' AND at.job_id = ?' : ` AND at.job_id = $${pc++}`;
            params.push(job_id);
        }
        if (active_only === 'true') {
            whereClause += isMySQL ? ' AND at.is_active = 1' : ' AND at.is_active = TRUE';
        }

        const listSQL = isMySQL
            ? `SELECT at.*,
                      j.title as job_title, j.category as job_category,
                      p.title as project_title, p.client_name
               FROM ad_tracking at
               JOIN jobs j     ON at.job_id     = j.id
               JOIN projects p ON at.project_id = p.id
               ${whereClause}
               ORDER BY at.created_at DESC`
            : `SELECT at.*,
                      j.title as job_title, j.category as job_category,
                      p.title as project_title, p.client_name
               FROM ad_tracking at
               JOIN jobs j     ON at.job_id     = j.id
               JOIN projects p ON at.project_id = p.id
               ${whereClause}
               ORDER BY at.created_at DESC`;

        const result = await query(listSQL, params);

        // Enrich each row with derived fields
        const whatsappPhone = process.env.WHATSAPP_PHONE_NUMBER || '';
        const rows = result.rows.map(row => ({
            ...row,
            conversion_rate: row.clicks > 0
                ? ((row.conversions / row.clicks) * 100).toFixed(1) + '%'
                : '0%',
            qr_code_url: `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(row.whatsapp_link)}`,
            meta_ad_url: buildMetaAdUrl(whatsappPhone, row.ad_ref)
        }));

        return res.json({ data: rows, total: rows.length });
    } catch (error) {
        logger.error('Ad links list error:', error);
        return res.status(500).json({ error: 'Failed to fetch ad links' });
    }
});

// ── GET /api/ad-links/:ad_ref ─────────────────────────────────────────────────
router.get('/:ad_ref', authenticate, async (req, res) => {
    const { ad_ref } = req.params;

    try {
        const detailSQL = isMySQL
            ? `SELECT at.*,
                      j.title as job_title, j.category, j.requirements, j.salary_range, j.location,
                      p.title as project_title, p.client_name, p.countries, p.benefits, p.interview_date
               FROM ad_tracking at
               JOIN jobs j     ON at.job_id     = j.id
               JOIN projects p ON at.project_id = p.id
               WHERE at.ad_ref = ?`
            : `SELECT at.*,
                      j.title as job_title, j.category, j.requirements, j.salary_range, j.location,
                      p.title as project_title, p.client_name, p.countries, p.benefits, p.interview_date
               FROM ad_tracking at
               JOIN jobs j     ON at.job_id     = j.id
               JOIN projects p ON at.project_id = p.id
               WHERE at.ad_ref = $1`;

        const result = await query(detailSQL, [ad_ref]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: `No ad link found with ref: ${ad_ref}` });
        }

        const row = result.rows[0];
        const whatsappPhone = process.env.WHATSAPP_PHONE_NUMBER || '';

        // Fetch candidates who came via this ad
        const candidatesSQL = isMySQL
            ? `SELECT c.id, c.name, c.phone, c.status, c.created_at
               FROM candidates c
               WHERE c.ad_ref = ?
               ORDER BY c.created_at DESC
               LIMIT 50`
            : `SELECT c.id, c.name, c.phone, c.status, c.created_at
               FROM candidates c
               WHERE c.ad_ref = $1
               ORDER BY c.created_at DESC
               LIMIT 50`;

        const candidatesResult = await query(candidatesSQL, [ad_ref]);

        return res.json({
            ...row,
            conversion_rate: row.clicks > 0
                ? ((row.conversions / row.clicks) * 100).toFixed(1) + '%'
                : '0%',
            qr_code_url: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(row.whatsapp_link)}`,
            meta_ad_url: buildMetaAdUrl(whatsappPhone, row.ad_ref),
            recent_candidates: candidatesResult.rows
        });
    } catch (error) {
        logger.error('Ad link detail error:', error);
        return res.status(500).json({ error: 'Failed to fetch ad link details' });
    }
});

// ── PATCH /api/ad-links/:ad_ref/toggle ───────────────────────────────────────
router.patch(
    '/:ad_ref/toggle',
    authenticate,
    authorize('admin', 'sourcing_department'),
    async (req, res) => {
        const { ad_ref } = req.params;

        try {
            const currentSQL = isMySQL
                ? 'SELECT id, is_active, job_id FROM ad_tracking WHERE ad_ref = ?'
                : 'SELECT id, is_active, job_id FROM ad_tracking WHERE ad_ref = $1';
            const currentResult = await query(currentSQL, [ad_ref]);

            if (currentResult.rows.length === 0) {
                return res.status(404).json({ error: 'Ad link not found' });
            }

            const current = currentResult.rows[0];
            const newState = isMySQL ? (current.is_active ? 0 : 1) : !current.is_active;

            const updateSQL = isMySQL
                ? 'UPDATE ad_tracking SET is_active = ?, updated_at = NOW() WHERE ad_ref = ?'
                : 'UPDATE ad_tracking SET is_active = $1, updated_at = NOW() WHERE ad_ref = $2';
            await query(updateSQL, [newState, ad_ref]);

            // Refresh the bot's view — the job may have just lost (or regained)
            // its last active campaign.
            _resyncJobAdVisibility(current.job_id);

            return res.json({
                ad_ref,
                is_active: Boolean(newState),
                message: `Ad link ${newState ? 'activated' : 'deactivated'}`
            });
        } catch (error) {
            logger.error('Ad link toggle error:', error);
            return res.status(500).json({ error: 'Failed to toggle ad link' });
        }
    }
);

// ── DELETE /api/ad-links/:ad_ref ──────────────────────────────────────────────
router.delete(
    '/:ad_ref',
    authenticate,
    authorize('admin'),
    async (req, res) => {
        const { ad_ref } = req.params;

        try {
            // Capture the job_id before deleting so we can refresh the bot's
            // advertised-jobs view afterwards.
            const ownerSQL = isMySQL
                ? 'SELECT job_id FROM ad_tracking WHERE ad_ref = ?'
                : 'SELECT job_id FROM ad_tracking WHERE ad_ref = $1';
            const ownerResult = await query(ownerSQL, [ad_ref]);
            const ownerJobId = ownerResult.rows.length > 0 ? ownerResult.rows[0].job_id : null;

            const deleteSQL = isMySQL
                ? 'DELETE FROM ad_tracking WHERE ad_ref = ?'
                : 'DELETE FROM ad_tracking WHERE ad_ref = $1 RETURNING id';
            const result = await query(deleteSQL, [ad_ref]);

            if (isMySQL && result.rowCount === 0) {
                return res.status(404).json({ error: 'Ad link not found' });
            }
            if (!isMySQL && result.rows.length === 0) {
                return res.status(404).json({ error: 'Ad link not found' });
            }

            // If that was the job's last active campaign, the bot drops it.
            _resyncJobAdVisibility(ownerJobId);

            return res.json({ message: `Ad link ${ad_ref} deleted successfully` });
        } catch (error) {
            logger.error('Ad link delete error:', error);
            return res.status(500).json({ error: 'Failed to delete ad link' });
        }
    }
);

module.exports = router;
