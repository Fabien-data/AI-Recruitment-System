/**
 * Chatbot Knowledge Base Sync Route
 * ==================================
 * When a job or project is created/updated in the recruitment system,
 * this service pushes the content to the chatbot's knowledge base
 * endpoint so the bot can answer questions about current openings
 * intelligently using RAG.
 *
 * This is called INTERNALLY by jobs.js and projects.js routes — NOT
 * a public API. But exposed as routes for manual re-sync triggers.
 *
 * Auth: JWT (admin/supervisor only for manual triggers)
 *
 * POST /api/chatbot-sync/job             — Sync a single job
 * POST /api/chatbot-sync/project         — Sync a whole project + jobs
 * POST /api/chatbot-sync/sync-all        — Re-sync everything (admin)
 * DELETE /api/chatbot-sync/job/:job_id   — Remove job from chatbot KB
 */

const express = require('express');
const router = express.Router();
const { query } = require('../config/database');
const { isMySQL } = require('../utils/query-adapter');
const { authenticate, authorize } = require('../middleware/auth');
const logger = require('../utils/logger');
const axios = require('axios');

// ── Helper: HTTP POST to chatbot knowledge base (with retry) ──────────────────
const SYNC_MAX_RETRIES = 3;
const SYNC_RETRY_BASE_DELAY_MS = 1000; // 1s → 2s → 4s exponential backoff

async function pushToChatbotKB(endpoint, payload) {
    const chatbotUrl = process.env.CHATBOT_API_URL || 'http://localhost:8000';
    const apiKey = process.env.CHATBOT_API_KEY;

    let lastError = null;
    for (let attempt = 1; attempt <= SYNC_MAX_RETRIES; attempt++) {
        try {
            const response = await axios.post(`${chatbotUrl}${endpoint}`, payload, {
                headers: {
                    'Content-Type': 'application/json',
                    'x-chatbot-api-key': apiKey || ''
                },
                timeout: 10000
            });
            return { success: true, status: response.status, data: response.data };
        } catch (error) {
            lastError = error;
            const status = error.response ? error.response.status : null;

            // Non-retryable: 4xx client errors (except 429 rate limit)
            if (status && status >= 400 && status < 500 && status !== 429) {
                return { success: false, status, data: error.response.data };
            }

            // Retryable: 5xx, timeout, connection error, 429
            if (attempt < SYNC_MAX_RETRIES) {
                const delay = SYNC_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
                logger.warn(
                    `Chatbot KB push attempt ${attempt}/${SYNC_MAX_RETRIES} failed ` +
                    `(${status || error.code || error.message}) — retrying in ${delay}ms`
                );
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    // All retries exhausted
    if (lastError && lastError.response) {
        return { success: false, status: lastError.response.status, data: lastError.response.data };
    }
    return { success: false, error: lastError ? lastError.message : 'Unknown error after retries' };
}

// ── Helper: Build KB document content for a job ───────────────────────────────
function buildJobKBContent(job, project) {
    const reqs = typeof job.requirements === 'string'
        ? (() => { try { return JSON.parse(job.requirements); } catch { return {}; } })()
        : (job.requirements || {});

    const benefits = typeof project?.benefits === 'string'
        ? (() => { try { return JSON.parse(project.benefits); } catch { return {}; } })()
        : (project?.benefits || {});

    const countries = typeof project?.countries === 'string'
        ? (() => { try { return JSON.parse(project.countries); } catch { return []; } })()
        : (project?.countries || []);

    const parts = [
        `Job Title: ${job.title}`,
        `Category: ${job.category}`,
        project ? `Client: ${project.client_name}` : '',
        countries.length > 0 ? `Country/Location: ${countries.join(', ')}` : '',
        job.location ? `Job Location: ${job.location}` : '',
        job.salary_range ? `Salary: ${job.salary_range}` : '',
        job.positions_available ? `Positions Available: ${job.positions_available}` : '',
        job.deadline ? `Application Deadline: ${job.deadline}` : '',
        project?.interview_date ? `Interview Date: ${project.interview_date}` : '',
        project?.start_date ? `Start Date: ${project.start_date}` : '',
    ];

    // Requirements
    if (reqs.min_age) parts.push(`Age Requirement: ${reqs.min_age}–${reqs.max_age || '55'} years`);
    if (reqs.min_height_cm) parts.push(`Height Requirement: Min ${reqs.min_height_cm}cm${reqs.max_height_cm ? ` – Max ${reqs.max_height_cm}cm` : ''}`);
    if (reqs.experience_years) parts.push(`Experience Required: ${reqs.experience_years} years`);
    if (reqs.required_languages) {
        const langs = Array.isArray(reqs.required_languages) ? reqs.required_languages.join(', ') : reqs.required_languages;
        parts.push(`Languages Required: ${langs}`);
    }
    if (reqs.licenses) {
        const lic = Array.isArray(reqs.licenses) ? reqs.licenses.join(', ') : reqs.licenses;
        parts.push(`Required Licenses: ${lic}`);
    }

    // Benefits
    const benefitsList = [];
    if (benefits.accommodation) benefitsList.push('Accommodation');
    if (benefits.food) benefitsList.push('Food');
    if (benefits.flight) benefitsList.push('Flight tickets');
    if (benefits.medical) benefitsList.push('Medical insurance');
    if (benefits.transport) benefitsList.push('Transport');
    if (benefitsList.length > 0) parts.push(`Benefits: ${benefitsList.join(', ')}`);

    // Description
    if (job.description) parts.push(`Description: ${job.description.slice(0, 500)}`);

    // Status
    parts.push(`Status: ${job.status === 'active' ? 'Currently accepting applications' : `Not currently active (${job.status})`}`);

    return parts.filter(Boolean).join('\n');
}

// ── Helper: Sync a single job to chatbot KB ───────────────────────────────────
async function syncJobToChatbot(jobId) {
    const jobSQL = isMySQL
        ? `SELECT j.*, p.title as project_title, p.client_name, p.countries,
                  p.benefits, p.interview_date, p.start_date
           FROM jobs j
           LEFT JOIN projects p ON j.project_id = p.id
           WHERE j.id = ?`
        : `SELECT j.*, p.title as project_title, p.client_name, p.countries,
                  p.benefits, p.interview_date, p.start_date
           FROM jobs j
           LEFT JOIN projects p ON j.project_id = p.id
           WHERE j.id = $1`;

    const result = await query(jobSQL, [jobId]);
    if (result.rows.length === 0) {
        return { success: false, error: `Job ${jobId} not found` };
    }

    const job = result.rows[0];
    const content = buildJobKBContent(job, {
        client_name: job.client_name,
        countries: job.countries,
        benefits: job.benefits,
        interview_date: job.interview_date,
        start_date: job.start_date
    });

    const payload = {
        doc_id: `job_${job.id}`,
        doc_type: 'job_desc',
        title: `${job.title}${job.client_name ? ` - ${job.client_name}` : ''}`,
        content,
        metadata: {
            job_id: job.id,
            project_id: job.project_id,
            category: job.category,
            status: job.status,
            positions_available: job.positions_available,
            salary_range: job.salary_range,
            // Pass raw requirements JSON so chatbot can tailor questions
            requirements: job.requirements
        }
    };

    const syncResult = await pushToChatbotKB('/api/knowledge/upsert', payload);
    logger.info(`Chatbot KB sync — Job "${job.title}": ${syncResult.success ? '✅ Success' : `❌ ${syncResult.error || syncResult.data}`}`);
    return syncResult;
}

// ── Exported helper for use by jobs.js and projects.js ───────────────────────
async function syncJobAsync(jobId) {
    try {
        const result = await syncJobToChatbot(jobId);
        // Also notify the chatbot to refresh its in-memory job cache immediately
        // so new/updated jobs appear without waiting for the 5-minute poll
        pushToChatbotKB('/api/knowledge/refresh-cache', { trigger: 'job_sync', job_id: jobId })
            .catch(err => logger.warn(`Cache refresh notification failed for job ${jobId}: ${err.message || err}`));
        return result;
    } catch (err) {
        logger.warn(`Background chatbot KB sync failed for job ${jobId}: ${err.message}`);
    }
}

// ── POST /api/chatbot-sync/job ────────────────────────────────────────────────
router.post('/job', authenticate, authorize('admin', 'supervisor'), async (req, res) => {
    const { job_id } = req.body;
    if (!job_id) return res.status(400).json({ error: 'job_id is required' });

    try {
        const result = await syncJobToChatbot(job_id);
        return res.json({ success: result.success, job_id, detail: result });
    } catch (error) {
        logger.error('Manual job sync error:', error);
        return res.status(500).json({ error: 'Sync failed', detail: error.message });
    }
});

// ── POST /api/chatbot-sync/project ───────────────────────────────────────────
router.post('/project', authenticate, authorize('admin', 'supervisor'), async (req, res) => {
    const { project_id } = req.body;
    if (!project_id) return res.status(400).json({ error: 'project_id is required' });

    try {
        const jobsSQL = isMySQL
            ? `SELECT id, title FROM jobs WHERE project_id = ? AND status = 'active'`
            : `SELECT id, title FROM jobs WHERE project_id = $1 AND status = 'active'`;
        const jobsResult = await query(jobsSQL, [project_id]);

        const syncResults = [];
        for (const job of jobsResult.rows) {
            const result = await syncJobToChatbot(job.id);
            syncResults.push({ job_id: job.id, job_title: job.title, ...result });
        }

        return res.json({
            success: true,
            project_id,
            jobs_synced: syncResults.length,
            results: syncResults
        });
    } catch (error) {
        logger.error('Project sync error:', error);
        return res.status(500).json({ error: 'Project sync failed', detail: error.message });
    }
});

// ── POST /api/chatbot-sync/sync-all ──────────────────────────────────────────
router.post('/sync-all', authenticate, authorize('admin'), async (req, res) => {
    try {
        const allJobsSQL = `SELECT id, title FROM jobs WHERE status = 'active'`;
        const allJobs = await query(allJobsSQL, []);

        // Start sync in background, respond immediately
        res.json({
            message: 'Full sync started in background',
            jobs_queued: allJobs.rows.length
        });

        // Background sync
        for (const job of allJobs.rows) {
            await syncJobToChatbot(job.id).catch(err =>
                logger.warn(`Sync-all failed for job ${job.id}: ${err.message}`)
            );
        }

        logger.info(`Sync-all completed: ${allJobs.rows.length} jobs synced to chatbot KB`);
    } catch (error) {
        logger.error('Sync-all error:', error);
    }
});

// ── DELETE /api/chatbot-sync/job/:job_id ─────────────────────────────────────
router.delete('/job/:job_id', authenticate, authorize('admin', 'supervisor'), async (req, res) => {
    const { job_id } = req.params;

    try {
        const payload = { doc_id: `job_${job_id}` };
        const result = await pushToChatbotKB('/api/knowledge/delete', payload);

        return res.json({
            success: result.success,
            job_id,
            message: result.success ? 'Removed from chatbot knowledge base' : 'Removal may have failed',
            detail: result
        });
    } catch (error) {
        logger.error('Job KB removal error:', error);
        return res.status(500).json({ error: 'Removal failed', detail: error.message });
    }
});

module.exports = router;
module.exports.syncJobAsync = syncJobAsync;
module.exports.syncJobToChatbot = syncJobToChatbot;
