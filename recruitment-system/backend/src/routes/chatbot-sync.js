const express = require('express');
const router = express.Router();
const multer = require('multer');
const axios = require('axios');
const { randomUUID } = require('crypto');
const { query } = require('../config/database');
const { adaptQuery, isMySQL } = require('../utils/query-adapter');
const { authenticate, authorize } = require('../middleware/auth');
const logger = require('../utils/logger');

// Some deployments don't include a ../models layer; keep this route DB-driven.
let Candidate;
let CVFile;
try {
    ({ Candidate, CVFile } = require('../models'));
} catch (err) {
    logger.warn('chatbot-sync: ../models unavailable, using query fallback for intake');
}

// Configure multer to save incoming CVs to a temporary or permanent folder
const upload = multer({ dest: 'uploads/cvs/' });

const CHATBOT_API_URL = process.env.CHATBOT_API_URL || 'http://localhost:8000';
const CHATBOT_API_KEY = process.env.CHATBOT_API_KEY || '';

async function _postToChatbot(endpoint, body) {
    if (!CHATBOT_API_KEY) {
        logger.warn('CHATBOT_API_KEY not set — skipping chatbot sync');
        return null;
    }
    return axios.post(`${CHATBOT_API_URL}${endpoint}`, body, {
        headers: { 'x-chatbot-api-key': CHATBOT_API_KEY },
        timeout: 10000,
    });
}

function _buildJobContent(job) {
    const requirements = typeof job.requirements === 'string'
        ? job.requirements
        : JSON.stringify(job.requirements || {}, null, 2);
    return [
        job.title ? `Title: ${job.title}` : null,
        job.description || null,
        requirements && requirements !== '{}' ? `Requirements: ${requirements}` : null,
        job.salary_range ? `Salary: ${job.salary_range}` : null,
        job.location ? `Location: ${job.location}` : null,
    ].filter(Boolean).join('\n\n');
}

async function syncJobToChatbot(job) {
    if (!job || !job.id) return;
    if (!CHATBOT_API_KEY) {
        logger.warn('CHATBOT_API_KEY not set — cannot sync job to chatbot');
        return;
    }

    const payload = {
        doc_id: `job_${job.id}`,
        doc_type: 'job_desc',
        title: job.title || 'Job',
        content: _buildJobContent(job),
        metadata: {
            job_id: job.id,
            project_id: job.project_id,
            category: job.category,
            status: job.status,
            requirements: job.requirements,
            salary_range: job.salary_range,
            location: job.location,
            description: job.description,
            positions_available: job.positions_available,
        },
    };

    await _postToChatbot('/api/knowledge/upsert', payload);
}

async function syncJobAsync(jobId) {
    if (!jobId) return;

    const sql = isMySQL
        ? `SELECT * FROM jobs WHERE id = ? LIMIT 1`
        : `SELECT * FROM jobs WHERE id = $1 LIMIT 1`;

    const result = await query(sql, [jobId]);
    if (!result.rows || result.rows.length === 0) {
        return;
    }

    const job = result.rows[0];
    if (job.status && job.status !== 'active') {
        await _postToChatbot('/api/knowledge/delete', { doc_id: `job_${job.id}` });
        return;
    }

    await syncJobToChatbot(job);
}

async function syncAllActiveJobs() {
    const sql = `SELECT * FROM jobs WHERE status = 'active' ORDER BY created_at DESC`;

    const result = await query(sql, []);
    const jobs = result.rows || [];

    let synced = 0;
    let failed = 0;

    for (const job of jobs) {
        try {
            await syncJobToChatbot(job);
            synced += 1;
        } catch (error) {
            failed += 1;
            logger.warn(`Failed to sync job ${job.id}: ${error.message}`);
        }
    }

    return {
        total: jobs.length,
        synced,
        failed,
    };
}

router.post('/refresh-jobs', authenticate, authorize('admin', 'sourcing_department'), async (req, res) => {
    try {
        const result = await syncAllActiveJobs();
        res.json({
            success: true,
            message: 'Active jobs synchronized with chatbot knowledge base',
            ...result,
        });
    } catch (error) {
        logger.error(`refresh-jobs endpoint error: ${error.message}`);
        res.status(500).json({ error: 'Failed to refresh chatbot knowledge base' });
    }
});

router.post('/intake', upload.single('cv_file'), async (req, res) => {
    try {
        // The Python bot sends metadata as a JSON string in 'payload'
        const payload = JSON.parse(req.body.payload);
        const {
            phone,
            name,
            experience_years,
            job_interest,
            job_role,
            country,
            skills,
            preferred_language,
            email,
        } = payload;

        const resolvedJobInterest = job_interest || job_role || 'General';

        // 1. Create or update candidate by phone
        let candidate;
        if (Candidate && typeof Candidate.upsert === 'function') {
            [candidate] = await Candidate.upsert({
                phone,
                name: name || 'Pending AI Extraction',
                experience_years: experience_years !== undefined && experience_years !== null ? experience_years : null,
                status: 'screening',
                job_interest: resolvedJobInterest,
                ...(country && { preferred_country: country }),
                ...(preferred_language && { preferred_language }),
                ...(email && { email }),
            });
        } else {
            const existing = await query(
                adaptQuery('SELECT id FROM candidates WHERE phone = $1 LIMIT 1'),
                [phone]
            );

            if (existing.rows.length > 0) {
                const candidateId = existing.rows[0].id;
                await query(
                    adaptQuery(`
                        UPDATE candidates
                        SET name = $1,
                            experience_years = $2,
                            status = 'screening',
                            job_interest = $3,
                            updated_at = NOW()
                        WHERE id = $4
                    `),
                    [
                        name || 'Pending AI Extraction',
                        experience_years !== undefined && experience_years !== null ? experience_years : null,
                        resolvedJobInterest,
                        candidateId,
                    ]
                );

                // Optional columns can differ by environment; update best-effort.
                try {
                    await query(
                        adaptQuery('UPDATE candidates SET preferred_country = $1 WHERE id = $2'),
                        [country || null, candidateId]
                    );
                } catch (_err) {}

                try {
                    await query(
                        adaptQuery('UPDATE candidates SET preferred_language = $1 WHERE id = $2'),
                        [preferred_language || null, candidateId]
                    );
                } catch (_err) {}

                try {
                    await query(
                        adaptQuery('UPDATE candidates SET email = $1 WHERE id = $2'),
                        [email || null, candidateId]
                    );
                } catch (_err) {}

                candidate = { id: candidateId };
            } else {
                const candidateId = randomUUID();
                await query(
                    adaptQuery(`
                        INSERT INTO candidates
                            (id, phone, name, experience_years, status, job_interest)
                        VALUES ($1, $2, $3, $4, 'screening', $5)
                    `),
                    [
                        candidateId,
                        phone,
                        name || 'Pending AI Extraction',
                        experience_years !== undefined && experience_years !== null ? experience_years : null,
                        resolvedJobInterest,
                    ]
                );

                try {
                    await query(
                        adaptQuery('UPDATE candidates SET preferred_country = $1, preferred_language = $2, email = $3 WHERE id = $4'),
                        [country || null, preferred_language || null, email || null, candidateId]
                    );
                } catch (_err) {}

                candidate = { id: candidateId };
            }
        }

        // 2. Store skills if provided
        if (Array.isArray(skills) && skills.length > 0 && candidate) {
            try {
                await query(
                    adaptQuery('UPDATE candidates SET skills = $1 WHERE id = $2'),
                    [skills.join(', '), candidate.id]
                );
            } catch (_err) {
                // skills column may not exist yet — skip silently
            }
        }

        // 3. Attach the CV file if it exists
        if (req.file) {
            if (CVFile && typeof CVFile.create === 'function') {
                await CVFile.create({
                    candidate_id: candidate.id,
                    file_path: req.file.path,
                    original_name: req.file.originalname,
                    ocr_status: 'pending',
                });
            } else {
                await query(
                    adaptQuery(`
                        INSERT INTO cv_files
                            (id, candidate_id, file_url, file_name, file_type, ocr_status)
                        VALUES ($1, $2, $3, $4, $5, 'pending')
                    `),
                    [
                        randomUUID(),
                        candidate.id,
                        req.file.path,
                        req.file.originalname,
                        req.file.mimetype || 'application/octet-stream',
                    ]
                );
            }
        }

        res.status(200).json({
            success: true,
            candidate_id: candidate.id,
            fields_received: {
                name: !!name,
                experience_years: experience_years !== undefined && experience_years !== null,
                job_interest: !!resolvedJobInterest,
                country: !!country,
                skills_count: Array.isArray(skills) ? skills.length : 0,
                cv_attached: !!req.file,
            },
        });
    } catch (error) {
        logger.error('CRM Sync Error:', error);
        res.status(500).json({ error: 'Sync failed' });
    }
});

module.exports = router;
router.syncJobAsync = syncJobAsync;
router.syncJobToChatbot = syncJobToChatbot;
router.syncAllActiveJobs = syncAllActiveJobs;
