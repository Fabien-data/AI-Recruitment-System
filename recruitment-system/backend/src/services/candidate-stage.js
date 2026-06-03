/**
 * Candidate Stage Sync
 * ====================
 * Single source of truth for the canonical candidate lifecycle stage.
 *
 * The user-facing pipeline has four stages:
 *   New → Screening → Certified → Interview Scheduled
 *
 * `applications.status` (per candidate+job) remains the detailed source of
 * truth. `candidates.status` is an AUTO-DERIVED reflection of the candidate's
 * furthest-along application, mapped down to those four canonical values, and
 * `candidates.conversation_stage` is kept unified with it so the conversation
 * panel shows the same stage.
 *
 * `syncCandidateStage()` is called fire-and-forget after every place that
 * writes `applications.status` (applications.js, interviews.js, auto-assign.js).
 * It NEVER throws into a request handler and NEVER downgrades terminal/pool
 * states (future_pool / merged / hired) — those are set explicitly elsewhere.
 */

const { query } = require('../config/database');
const { adaptQuery } = require('../utils/query-adapter');
const logger = require('../utils/logger');

// Furthest-along ordering for the four canonical candidate stages.
const STAGE_ORDER = { new: 0, screening: 1, certified: 2, interview_scheduled: 3 };

// application.status → canonical candidate stage. Anything not listed
// (rejected / transferred / merged) maps to null and is ignored when
// computing the furthest stage.
const APP_STATUS_TO_STAGE = {
    applied: 'screening',
    auto_assigned: 'screening',
    reviewing: 'screening',
    screening: 'screening',
    certified: 'certified',
    pre_screened: 'certified',
    interview_scheduled: 'interview_scheduled',
    interviewed: 'interview_scheduled',
    selected: 'interview_scheduled',
    placed: 'interview_scheduled',
};

// Candidate statuses the auto-sync must never overwrite — they are set by
// explicit, intentional writes (General Pool / hire) and outrank the pipeline.
const PROTECTED_CANDIDATE_STATUSES = new Set(['future_pool', 'merged', 'hired']);

/**
 * Map a single application status to a candidate stage, applying the CV gate:
 * a candidate without a CV on file can be at most 'new', even if an application
 * row exists (mirrors the New→Screening hard gate).
 * @returns {('new'|'screening'|'certified'|'interview_scheduled'|null)}
 */
function deriveCandidateStage(applicationStatus, hasCv) {
    const stage = APP_STATUS_TO_STAGE[applicationStatus] || null;
    if (!stage) return null;
    if (stage === 'screening' && !hasCv) return 'new';
    return stage;
}

// Postgres returns booleans as true/false; MySQL returns 1/0; be tolerant.
function truthy(v) {
    return v === true || v === 1 || v === '1' || v === 't' || v === 'true';
}

/**
 * Recompute candidates.status (+ conversation_stage) from the candidate's
 * furthest-along application. Fire-and-forget: logs and swallows all errors.
 * @param {string} candidateId
 */
async function syncCandidateStage(candidateId) {
    if (!candidateId) return;
    try {
        const candRes = await query(
            adaptQuery(`
                SELECT c.status AS current_status,
                       (c.cv_uploaded IS TRUE
                        OR EXISTS (SELECT 1 FROM cv_files f WHERE f.candidate_id = c.id)) AS has_cv
                FROM candidates c
                WHERE c.id = $1
            `),
            [candidateId]
        );
        if (candRes.rows.length === 0) return;

        const currentStatus = candRes.rows[0].current_status;
        // Never fight an explicit terminal/pool write.
        if (PROTECTED_CANDIDATE_STATUSES.has(currentStatus)) return;

        const hasCv = truthy(candRes.rows[0].has_cv);

        const appRes = await query(
            adaptQuery('SELECT status FROM applications WHERE candidate_id = $1'),
            [candidateId]
        );

        let best = null;
        let bestOrder = -1;
        for (const row of appRes.rows) {
            const stage = deriveCandidateStage(row.status, hasCv);
            if (stage && STAGE_ORDER[stage] > bestOrder) {
                best = stage;
                bestOrder = STAGE_ORDER[stage];
            }
        }

        // No application maps to a stage (none, or all rejected/transferred) —
        // leave the candidate's status untouched.
        if (!best || best === currentStatus) return;

        await query(
            adaptQuery(`
                UPDATE candidates
                SET status = $1, conversation_stage = $2, updated_at = NOW()
                WHERE id = $3 AND status NOT IN ('future_pool', 'merged', 'hired')
            `),
            [best, best, candidateId]
        );
        logger.info(`candidate-stage: ${candidateId} ${currentStatus} → ${best}`);
    } catch (err) {
        logger.warn(`candidate-stage: sync failed for ${candidateId}: ${err.message}`);
    }
}

module.exports = {
    STAGE_ORDER,
    APP_STATUS_TO_STAGE,
    deriveCandidateStage,
    syncCandidateStage,
};
