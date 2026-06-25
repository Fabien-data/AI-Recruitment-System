/**
 * Bulk Application Import routes
 * ==============================
 * Two endpoints, both gated by the same permission as creating an application:
 *
 *   POST /api/applications/bulk-import/validate   (JSON, no files)
 *       Dry-run: classify every row (will_create / in_file_dups / db_dups /
 *       missing_cv / unresolved_job / errors) WITHOUT writing anything.
 *
 *   POST /api/applications/bulk-import/commit      (multipart)
 *       Commit ONE batch. Field `payload` (JSON) carries { project_id,
 *       default_job_id?, batch_id, batch_index, rows[] }. Each row's CV file (if
 *       any) is sent under field name `cv_<row._index>` so files map back to rows
 *       unambiguously. The frontend keeps each request under the Cloud Run 32MB
 *       cap by batching min(25 rows, ~20MB) per call.
 *
 * The actual cascade + dedup + screening-gate bypass lives in
 * services/bulk-import-service.js.
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const { authenticate } = require('../middleware/auth');
const { requireSection } = require('../middleware/sections');
const { validateRows, importApplicationBatch } = require('../services/bulk-import-service');
const logger = require('../utils/logger');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024, files: 30 }, // 15 MB/file, ≤30 files/batch
});

// POST /api/applications/bulk-import/validate
router.post('/validate', authenticate, requireSection('applications', 'create'), async (req, res, next) => {
    try {
        const { project_id, default_job_id, assign_unresolved_to_project, rows } = req.body || {};
        if (!project_id) return res.status(400).json({ error: 'project_id is required' });
        if (!Array.isArray(rows) || rows.length === 0) {
            return res.status(400).json({ error: 'rows must be a non-empty array' });
        }
        if (rows.length > 5000) {
            return res.status(413).json({ error: 'Too many rows in one validate call (max 5000)' });
        }
        const report = await validateRows(rows, {
            projectId: project_id,
            defaultJobId: default_job_id || null,
            // Default on: rows with no matching job bucket into a per-project
            // catch-all rather than dead-ending. Pass false to opt out.
            assignUnresolvedToProject: assign_unresolved_to_project !== false,
        });
        res.json(report);
    } catch (err) {
        next(err);
    }
});

// POST /api/applications/bulk-import/commit
router.post(
    '/commit',
    authenticate,
    requireSection('applications', 'create'),
    upload.any(),
    async (req, res, next) => {
        try {
            let payload;
            try {
                payload = JSON.parse(req.body.payload || '{}');
            } catch (e) {
                return res.status(400).json({ error: 'Invalid payload JSON' });
            }

            const { project_id, default_job_id, assign_unresolved_to_project, batch_id, batch_index, rows } = payload;
            if (!project_id) return res.status(400).json({ error: 'project_id is required' });
            if (!batch_id) return res.status(400).json({ error: 'batch_id is required' });
            if (!Array.isArray(rows) || rows.length === 0) {
                return res.status(400).json({ error: 'rows must be a non-empty array' });
            }
            if (rows.length > 50) {
                return res.status(413).json({ error: 'Batch too large (max 50 rows)' });
            }

            // Map multipart files (fieldname `cv_<index>`) back to their rows.
            const files = {};
            for (const f of req.files || []) {
                const m = /^cv_(\d+)$/.exec(f.fieldname);
                if (m) {
                    files[parseInt(m[1], 10)] = {
                        buffer: f.buffer,
                        originalname: f.originalname,
                        mimetype: f.mimetype,
                    };
                }
            }

            const { results, summary } = await importApplicationBatch(rows, files, {
                projectId: project_id,
                defaultJobId: default_job_id || null,
                assignUnresolvedToProject: assign_unresolved_to_project !== false,
                userId: req.user.id,
                batchId: batch_id,
            });

            logger.info(
                `bulk-import: batch ${batch_index} (${batch_id}) → created ${summary.created}, ` +
                `skipped ${summary.skipped_duplicate}, error ${summary.error}, cv ${summary.cv_attached}`
            );
            res.json({ batch_index: batch_index ?? null, summary, results });
        } catch (err) {
            next(err);
        }
    }
);

module.exports = router;
