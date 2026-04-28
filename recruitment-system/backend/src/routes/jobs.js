const express = require('express');
const router = express.Router();
const multer = require('multer');
const { pool } = require('../config/database');
const { authenticate, authorize } = require('../middleware/auth');
const { syncJobAsync } = require('./chatbot-sync');
const { processJobFlyer } = require('../services/auto-ingest');
const logger = require('../utils/logger');

const MAX_FLYERS_PER_BATCH = 20;

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 15 * 1024 * 1024 },
});

function getFlyerFiles(req) {
    if (Array.isArray(req.files) && req.files.length > 0) {
        return req.files;
    }

    if (req.file) {
        return [req.file];
    }

    return [];
}

async function handleMagicCreate(req, res, next) {
    try {
        const files = getFlyerFiles(req);

        if (files.length === 0) {
            return res.status(400).json({ error: 'No flyer image uploaded' });
        }

        const invalidFile = files.find((file) => !file.mimetype || !file.mimetype.startsWith('image/'));
        if (invalidFile) {
            return res.status(400).json({ error: 'Flyer must be an image file' });
        }

        const results = [];
        const failures = [];

        for (const file of files) {
            try {
                const result = await processJobFlyer(file.buffer, file.mimetype);
                results.push({
                    fileName: file.originalname,
                    ...result,
                });
            } catch (error) {
                failures.push({
                    fileName: file.originalname,
                    error: error.message,
                });
                logger.error(`Magic create failed for ${file.originalname}: ${error.message}`);
            }
        }

        if (results.length === 0) {
            return res.status(500).json({
                error: 'Failed to process flyer batch',
                failures,
            });
        }

        res.status(201).json({
            message: files.length === 1
                ? 'Flyer processed successfully'
                : `Processed ${results.length} of ${files.length} flyers successfully`,
            totalFiles: files.length,
            succeeded: results.length,
            failed: failures.length,
            results,
            failures,
        });
    } catch (error) {
        logger.error(`Magic create failed: ${error.message}`);
        next(error);
    }
}

router.post('/magic-create', authenticate, authorize('admin', 'sourcing_department'), upload.array('flyer', MAX_FLYERS_PER_BATCH), handleMagicCreate);
router.post('/auto-ingest', authenticate, authorize('admin', 'sourcing_department'), upload.array('flyer', MAX_FLYERS_PER_BATCH), handleMagicCreate);


/**
 * Get all jobs
 */
router.get('/', authenticate, async (req, res, next) => {
    try {
        const { status = 'active', category, project_id } = req.query;

        let query = 'SELECT * FROM jobs WHERE 1=1';
        const params = [];
        let paramCount = 1;

        if (status) {
            query += ` AND status = $${paramCount}`;
            params.push(status);
            paramCount++;
        }

        if (category) {
            query += ` AND category = $${paramCount}`;
            params.push(category);
            paramCount++;
        }

        if (project_id) {
            query += ` AND project_id = $${paramCount}`;
            params.push(project_id);
            paramCount++;
        }

        query += ' ORDER BY created_at DESC';

        const result = await pool.query(query, params);

        res.json({ data: result.rows });
    } catch (error) {
        next(error);
    }
});

/**
 * Get job by ID
 */
router.get('/:id', authenticate, async (req, res, next) => {
    try {
        const { id } = req.params;

        const result = await pool.query(
            `SELECT j.*, p.title as project_title, p.client_name as project_client
             FROM jobs j
             LEFT JOIN projects p ON j.project_id = p.id
             WHERE j.id = $1`,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Job not found' });
        }

        // Get application count
        const countResult = await pool.query(
            'SELECT COUNT(*) FROM applications WHERE job_id = $1',
            [id]
        );

        const job = result.rows[0];
        job.application_count = parseInt(countResult.rows[0].count);

        res.json(job);
    } catch (error) {
        next(error);
    }
});

/**
 * Create new job
 */
router.post('/', authenticate, authorize('admin', 'sourcing_department', 'project_handler'), async (req, res, next) => {
    try {
        const {
            title,
            category,
            description,
            requirements,
            wiggle_room,
            positions_available,
            salary_range,
            location,
            deadline,
            project_id
        } = req.body;

        if (!title || !category || !requirements) {
            return res.status(400).json({ error: 'Title, category, and requirements are required' });
        }

        if (!project_id) {
            return res.status(400).json({ error: 'Project ID is required. Jobs must belong to a project.' });
        }

        // Verify project exists
        const projectResult = await pool.query(
            'SELECT id, title FROM projects WHERE id = $1',
            [project_id]
        );

        if (projectResult.rows.length === 0) {
            return res.status(404).json({ error: 'Project not found' });
        }

        const result = await pool.query(
            `INSERT INTO jobs (title, category, description, requirements, wiggle_room, positions_available, salary_range, location, deadline, project_id, created_by, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active')
             RETURNING *`,
            [
                title,
                category,
                description,
                JSON.stringify(requirements),
                JSON.stringify(wiggle_room || {}),
                positions_available || 1,
                salary_range,
                location,
                deadline,
                project_id,
                req.user.id
            ]
        );

        const newJob = result.rows[0];
        // Sync to chatbot knowledge base before returning success
        try {
            await syncJobAsync(newJob.id);
        } catch (syncErr) {
            logger.warn(`Job created but chatbot sync failed for job ${newJob.id}: ${syncErr.message}`);
        }
        res.status(201).json(newJob);
    } catch (error) {
        next(error);
    }
});

/**
 * Update job
 */
router.put('/:id', authenticate, authorize('admin', 'sourcing_department', 'project_handler'), async (req, res, next) => {
    try {
        const { id } = req.params;
        const updates = req.body;

        const allowedFields = [
            'title', 'category', 'description', 'requirements',
            'wiggle_room', 'status', 'positions_available',
            'positions_filled', 'salary_range', 'location', 'deadline', 'project_id'
        ];

        const setClause = [];
        const values = [];
        let paramCount = 1;

        Object.keys(updates).forEach(key => {
            if (allowedFields.includes(key)) {
                if (key === 'requirements' || key === 'wiggle_room') {
                    setClause.push(`${key} = $${paramCount}::jsonb`);
                    values.push(JSON.stringify(updates[key]));
                } else {
                    setClause.push(`${key} = $${paramCount}`);
                    values.push(updates[key]);
                }
                paramCount++;
            }
        });

        if (setClause.length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }

        setClause.push(`updated_at = NOW()`);
        values.push(id);

        const query = `UPDATE jobs SET ${setClause.join(', ')} WHERE id = $${paramCount} RETURNING *`;
        const result = await pool.query(query, values);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Job not found' });
        }

        const updated = result.rows[0];
        // Re-sync to chatbot knowledge base before returning success
        try {
            await syncJobAsync(updated.id);
        } catch (syncErr) {
            logger.warn(`Job updated but chatbot sync failed for job ${updated.id}: ${syncErr.message}`);
        }
        res.json(updated);
    } catch (error) {
        next(error);
    }
});

/**
 * Delete job
 */
router.delete('/:id', authenticate, authorize('admin'), async (req, res, next) => {
    try {
        const { id } = req.params;

        const result = await pool.query(
            'DELETE FROM jobs WHERE id = $1 RETURNING *',
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Job not found' });
        }

        const deleted = result.rows[0];
        // Remove from chatbot knowledge base in background
        const axios = require('axios');
        const chatbotUrl = process.env.CHATBOT_API_URL || 'http://localhost:8000';
        const apiKey = process.env.CHATBOT_API_KEY || '';
        axios.post(`${chatbotUrl}/api/knowledge/delete`, { doc_id: `job_${id}` }, {
            headers: { 'x-chatbot-api-key': apiKey }, timeout: 5000
        }).catch(err => logger.warn(`Failed to remove job ${id} from chatbot KB: ${err.message}`));
        res.json({ message: 'Job deleted successfully' });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
