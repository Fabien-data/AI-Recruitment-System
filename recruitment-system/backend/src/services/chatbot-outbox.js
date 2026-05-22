/**
 * Chatbot Sync Outbox
 * ===================
 * Realtime knowledge pipeline: CRM mutations (jobs / projects / KB FAQs) are
 * written here, then a background worker drains them and POSTs to the chatbot.
 *
 * Why an outbox: makes sync survive chatbot restarts, retries with backoff,
 * collapses bursts (partial unique index on pending rows), and gives the
 * reconciler a single source of truth for "what has the bot seen?".
 *
 * PostgreSQL-only. MySQL deployments fall through to a no-op (warning logged
 * once at startup), matching the existing PG-only migrations.
 */

const axios = require('axios');
const { pool, query } = require('../config/database');
const { isMySQL } = require('../utils/query-adapter');
const logger = require('../utils/logger');

const CHATBOT_API_URL = process.env.CHATBOT_API_URL || 'http://localhost:8000';
const CHATBOT_API_KEY = process.env.CHATBOT_API_KEY || '';
const MAX_ATTEMPTS = parseInt(process.env.CHATBOT_SYNC_MAX_ATTEMPTS, 10) || 8;

let mysqlWarned = false;
function _warnIfMySQL() {
    if (isMySQL && !mysqlWarned) {
        logger.warn('chatbot-outbox: MySQL mode detected — outbox is no-op. Sync will fall back to legacy direct push.');
        mysqlWarned = true;
    }
    return isMySQL;
}

/* ───────────────────────────────── enqueue ────────────────────────────────── */

/**
 * Insert (or refresh) a pending sync row for a doc.
 *
 * Uses ON CONFLICT against the partial unique index `idx_outbox_pending_per_doc`
 * so a burst of edits to the same doc collapses into one pending row carrying
 * the latest payload. Already-sent rows are kept as history for the reconciler.
 *
 * @param {object} args
 * @param {string} args.doc_id    e.g. 'job_<uuid>'
 * @param {string} args.doc_type  'job_desc' | 'faq' | 'project_desc'
 * @param {string} args.operation 'upsert' | 'delete'
 * @param {object} args.payload   exact JSON body to POST to the bot
 * @returns {Promise<string|null>} outbox row id or null
 */
async function enqueue({ doc_id, doc_type, operation, payload }) {
    if (!doc_id || !doc_type || !operation) {
        throw new Error('chatbot-outbox.enqueue: doc_id, doc_type, operation are required');
    }
    if (operation !== 'upsert' && operation !== 'delete') {
        throw new Error(`chatbot-outbox.enqueue: invalid operation ${operation}`);
    }
    if (_warnIfMySQL()) return null;

    const sql = `
        INSERT INTO chatbot_sync_outbox (doc_id, doc_type, operation, payload, status, attempts, updated_at)
        VALUES ($1, $2, $3, $4::jsonb, 'pending', 0, NOW())
        ON CONFLICT (doc_id, operation) WHERE status = 'pending'
        DO UPDATE SET
            payload    = EXCLUDED.payload,
            doc_type   = EXCLUDED.doc_type,
            attempts   = 0,
            last_error = NULL,
            updated_at = NOW()
        RETURNING id
    `;
    try {
        const result = await pool.query(sql, [doc_id, doc_type, operation, JSON.stringify(payload || {})]);
        return result.rows[0]?.id || null;
    } catch (err) {
        logger.error(`chatbot-outbox.enqueue failed for ${doc_id}: ${err.message}`);
        return null;
    }
}

/* ────────────────────────────────── drain ─────────────────────────────────── */

function _backoffSeconds(attempts) {
    return Math.min(60 * Math.pow(2, attempts), 1800);
}

async function _postToChatbot(endpoint, body) {
    if (!CHATBOT_API_KEY) {
        throw new Error('CHATBOT_API_KEY not set');
    }
    return axios.post(`${CHATBOT_API_URL}${endpoint}`, body, {
        headers: { 'x-chatbot-api-key': CHATBOT_API_KEY },
        timeout: 10000,
    });
}

/**
 * Drain a batch of due rows. Each row whose backoff window has elapsed is sent
 * to the bot; on success it is marked 'sent', on failure 'attempts' is bumped
 * and the row is re-tried later (or moved to 'failed' after MAX_ATTEMPTS).
 *
 * Uses FOR UPDATE SKIP LOCKED so multiple worker instances cooperate safely.
 */
async function drainOnce({ batchSize = 25 } = {}) {
    if (_warnIfMySQL()) return { drained: 0, sent: 0, failed: 0 };

    const selectSQL = `
        SELECT id, doc_id, doc_type, operation, payload, attempts
        FROM chatbot_sync_outbox
        WHERE status IN ('pending', 'failed')
          AND attempts < $1
          AND updated_at + (LEAST(60 * POWER(2, attempts), 1800) || ' seconds')::interval <= NOW()
        ORDER BY updated_at ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED
    `;

    let sent = 0;
    let failed = 0;
    let drained = 0;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query(selectSQL, [MAX_ATTEMPTS, batchSize]);
        const rows = result.rows;
        drained = rows.length;

        for (const row of rows) {
            const endpoint = row.operation === 'delete'
                ? '/api/knowledge/delete'
                : '/api/knowledge/upsert';

            try {
                await _postToChatbot(endpoint, row.payload);
                await client.query(
                    `UPDATE chatbot_sync_outbox
                     SET status = 'sent', synced_at = NOW(), updated_at = NOW(), last_error = NULL
                     WHERE id = $1`,
                    [row.id]
                );
                sent += 1;
            } catch (err) {
                const nextAttempts = row.attempts + 1;
                const newStatus = nextAttempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
                const errMsg = (err.response?.data?.detail || err.message || 'unknown').toString().slice(0, 500);
                await client.query(
                    `UPDATE chatbot_sync_outbox
                     SET status = $1, attempts = $2, last_error = $3, updated_at = NOW()
                     WHERE id = $4`,
                    [newStatus, nextAttempts, errMsg, row.id]
                );
                failed += 1;
                logger.warn(`chatbot-outbox: ${row.doc_id} attempt ${nextAttempts} -> ${newStatus} (${errMsg})`);
            }
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        logger.error(`chatbot-outbox.drainOnce error: ${err.message}`);
    } finally {
        client.release();
    }

    return { drained, sent, failed };
}

/* ──────────────────────────────── reconcile ───────────────────────────────── */

/**
 * Find entities whose updated_at is newer than the most recent successful sync,
 * and re-enqueue them. Catches:
 *   - DB writes that bypass the route layer (admin SQL, scripts)
 *   - rows whose enqueue silently failed
 *   - chatbot redeploys that wiped the in-memory caches between syncs
 *
 * Payload builders are imported here so reconcile can rebuild fresh payloads.
 */
async function reconcile() {
    if (_warnIfMySQL()) return { jobs: 0, projects: 0, faqs: 0 };

    // Local require to avoid circular import (chatbot-sync.js requires this module).
    const { buildJobPayload, buildProjectPayload, buildFaqPayload } = require('./chatbot-payloads');

    const stats = { jobs: 0, projects: 0, faqs: 0 };

    /* Jobs */
    try {
        const jobsSQL = `
            SELECT j.*, p.countries, p.benefits, p.salary_info,
                   p.start_date, p.interview_date, p.title AS project_title
            FROM jobs j
            LEFT JOIN projects p ON j.project_id = p.id
            LEFT JOIN LATERAL (
                SELECT MAX(synced_at) AS last_synced
                FROM chatbot_sync_outbox o
                WHERE o.doc_id = 'job_' || j.id::text
                  AND o.status = 'sent'
            ) o ON TRUE
            WHERE j.status = 'active'
              AND (o.last_synced IS NULL OR COALESCE(j.updated_at, j.created_at) > o.last_synced)
            LIMIT 500
        `;
        const result = await pool.query(jobsSQL, []);
        for (const job of result.rows) {
            await enqueue({
                doc_id: `job_${job.id}`,
                doc_type: 'job_desc',
                operation: 'upsert',
                payload: buildJobPayload(job),
            });
            stats.jobs += 1;
        }
    } catch (err) {
        logger.warn(`chatbot-outbox.reconcile jobs: ${err.message}`);
    }

    /* Projects */
    try {
        const projSQL = `
            SELECT p.*
            FROM projects p
            LEFT JOIN LATERAL (
                SELECT MAX(synced_at) AS last_synced
                FROM chatbot_sync_outbox o
                WHERE o.doc_id = 'project_' || p.id::text
                  AND o.status = 'sent'
            ) o ON TRUE
            WHERE COALESCE(p.status, 'active') NOT IN ('archived', 'cancelled')
              AND (o.last_synced IS NULL OR COALESCE(p.updated_at, p.created_at) > o.last_synced)
            LIMIT 500
        `;
        const result = await pool.query(projSQL, []);
        for (const proj of result.rows) {
            await enqueue({
                doc_id: `project_${proj.id}`,
                doc_type: 'project_desc',
                operation: 'upsert',
                payload: buildProjectPayload(proj),
            });
            stats.projects += 1;
        }
    } catch (err) {
        logger.warn(`chatbot-outbox.reconcile projects: ${err.message}`);
    }

    /* FAQs */
    try {
        const faqSQL = `
            SELECT kb.*
            FROM knowledge_base kb
            LEFT JOIN LATERAL (
                SELECT MAX(synced_at) AS last_synced
                FROM chatbot_sync_outbox o
                WHERE o.doc_id = 'faq_' || kb.id::text
                  AND o.status = 'sent'
            ) o ON TRUE
            WHERE COALESCE(kb.is_active, TRUE) = TRUE
              AND (o.last_synced IS NULL OR COALESCE(kb.updated_at, kb.created_at) > o.last_synced)
            LIMIT 500
        `;
        const result = await pool.query(faqSQL, []);
        for (const faq of result.rows) {
            await enqueue({
                doc_id: `faq_${faq.id}`,
                doc_type: 'faq',
                operation: 'upsert',
                payload: buildFaqPayload(faq),
            });
            stats.faqs += 1;
        }
    } catch (err) {
        // knowledge_base or its updated_at column may not exist in older DBs — non-fatal
        logger.warn(`chatbot-outbox.reconcile faqs: ${err.message}`);
    }

    if (stats.jobs || stats.projects || stats.faqs) {
        logger.info(`chatbot-outbox.reconcile: re-enqueued jobs=${stats.jobs} projects=${stats.projects} faqs=${stats.faqs}`);
    }
    return stats;
}

/* ───────────────────────────── full resync ────────────────────────────────── */

/**
 * Re-enqueue every active job, project, and FAQ. Used by the
 * /api/chatbot-sync/full-resync admin endpoint.
 */
async function fullResync() {
    if (_warnIfMySQL()) return { jobs: 0, projects: 0, faqs: 0 };
    const { buildJobPayload, buildProjectPayload, buildFaqPayload } = require('./chatbot-payloads');

    const stats = { jobs: 0, projects: 0, faqs: 0 };

    const jobs = await query(
        `SELECT j.*, p.countries, p.benefits, p.salary_info,
                p.start_date, p.interview_date, p.title AS project_title
         FROM jobs j LEFT JOIN projects p ON j.project_id = p.id
         WHERE j.status = 'active'`,
        []
    );
    for (const job of jobs.rows || []) {
        await enqueue({
            doc_id: `job_${job.id}`,
            doc_type: 'job_desc',
            operation: 'upsert',
            payload: buildJobPayload(job),
        });
        stats.jobs += 1;
    }

    const projects = await query(
        `SELECT * FROM projects WHERE COALESCE(status, 'active') NOT IN ('archived', 'cancelled')`,
        []
    );
    for (const proj of projects.rows || []) {
        await enqueue({
            doc_id: `project_${proj.id}`,
            doc_type: 'project_desc',
            operation: 'upsert',
            payload: buildProjectPayload(proj),
        });
        stats.projects += 1;
    }

    try {
        const faqs = await query(
            `SELECT * FROM knowledge_base WHERE COALESCE(is_active, TRUE) = TRUE`,
            []
        );
        for (const faq of faqs.rows || []) {
            await enqueue({
                doc_id: `faq_${faq.id}`,
                doc_type: 'faq',
                operation: 'upsert',
                payload: buildFaqPayload(faq),
            });
            stats.faqs += 1;
        }
    } catch (err) {
        logger.warn(`chatbot-outbox.fullResync faqs: ${err.message}`);
    }

    return stats;
}

module.exports = {
    enqueue,
    drainOnce,
    reconcile,
    fullResync,
    _backoffSeconds,
};
