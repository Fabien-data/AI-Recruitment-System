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

// ── Canonical vocabularies (UPGRADES.md #1) — the single backend source ───────
// candidate.status: the 7 canonical values. application.status: the 5 canonical
// values. Every backend writer validates/maps against these so no parallel or
// ad-hoc status word can be persisted.
const CANDIDATE_STATUSES = ['new', 'screening', 'certified', 'interview_scheduled', 'future_pool', 'merged', 'hired'];
const APPLICATION_STATUSES = ['screening', 'certified', 'interview_scheduled', 'hired', 'rejected'];
const CANDIDATE_STATUS_SET = new Set(CANDIDATE_STATUSES);
const APPLICATION_STATUS_SET = new Set(APPLICATION_STATUSES);

// Legacy → canonical application-status map (used to normalize any value read
// from a not-yet-migrated row, and to keep derivation back-compatible).
const LEGACY_APP_STATUS_MAP = {
    applied: 'screening',
    auto_assigned: 'screening',
    reviewing: 'screening',
    pre_screened: 'certified',
    interviewed: 'interview_scheduled',
    selected: 'interview_scheduled',
    placed: 'hired',
    transferred: 'rejected',
};

/** Normalize any (possibly legacy) application status onto the canonical 5. */
function normalizeApplicationStatus(status) {
    if (!status) return status;
    if (APPLICATION_STATUS_SET.has(status)) return status;
    return LEGACY_APP_STATUS_MAP[status] || status;
}

// Forward map: a user-chosen canonical stage → the application status to write
// through to the candidate's active applications (source of truth). Stages with
// no application equivalent (new / future_pool) fall back to a direct write.
const STAGE_TO_APP_STATUS = {
    screening: 'screening',
    certified: 'certified',
    interview_scheduled: 'interview_scheduled',
};

/**
 * Broadcast that a candidate's canonical stage changed so the conversations
 * panel can update the row's status badge live and move it between buckets.
 * Lazy-required + swallowed so callers (incl. fire-and-forget sync) never break.
 */
function emitStageChanged(candidateId, status) {
    try {
        const { getIO } = require('../utils/websocket');
        const io = getIO();
        if (io) io.emit('candidate_stage_changed', { candidate_id: candidateId, status, ts: new Date().toISOString() });
    } catch (err) {
        logger.debug(`candidate-stage: WS emit skipped for ${candidateId}: ${err.message}`);
    }
}

/**
 * Map a single application status to a candidate stage, applying the CV gate:
 * a candidate without a CV on file can be at most 'new', even if an application
 * row exists (mirrors the New→Screening hard gate).
 * @returns {('new'|'screening'|'certified'|'interview_scheduled'|null)}
 */
function deriveCandidateStage(applicationStatus, hasCv) {
    const stage = APP_STATUS_TO_STAGE[applicationStatus] || null;
    if (!stage) return null;
    // CV is the hard gate (#5): with no CV on file a candidate can be at most
    // 'new', for ANY forward stage (screening / certified / interview_scheduled) —
    // never just screening. This keeps the re-derivation consistent with the
    // migration's CV-less re-bucket so a certified/interview app can't silently
    // re-promote a CV-less candidate.
    if (!hasCv) return 'new';
    return stage;
}

// Postgres returns booleans as true/false; MySQL returns 1/0; be tolerant.
function truthy(v) {
    return v === true || v === 1 || v === '1' || v === 't' || v === 'true';
}

/**
 * The single, shared definition of the CV-eligibility test (UPGRADES.md #5):
 * a candidate "has a CV" iff `cv_uploaded` is true OR a `cv_files` row exists.
 * Returns a SQL boolean fragment so every eligibility surface (auto-assign,
 * job-candidate lists, prescreen/certify gates, project stats) uses ONE
 * definition instead of re-inlining it. `alias` is the candidates table alias.
 */
function hasCvSql(alias = 'c') {
    return `(${alias}.cv_uploaded IS TRUE OR EXISTS (SELECT 1 FROM cv_files f WHERE f.candidate_id = ${alias}.id))`;
}

/**
 * Async point-check of the same CV-eligibility test for a single candidate.
 * Never throws — returns false on any error so callers fail closed (no CV ⇒
 * not eligible).
 */
async function candidateHasCv(candidateId) {
    if (!candidateId) return false;
    try {
        const r = await query(
            adaptQuery(`SELECT ${hasCvSql('c')} AS has_cv FROM candidates c WHERE c.id = $1`),
            [candidateId]
        );
        return r.rows.length ? truthy(r.rows[0].has_cv) : false;
    } catch (err) {
        logger.warn(`candidate-stage: candidateHasCv failed for ${candidateId}: ${err.message}`);
        return false;
    }
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
        emitStageChanged(candidateId, best);
    } catch (err) {
        logger.warn(`candidate-stage: sync failed for ${candidateId}: ${err.message}`);
    }
}

/**
 * Move a candidate to a chosen canonical stage, writing THROUGH to the
 * candidate's active applications (the source of truth) then re-deriving
 * candidates.status — the same logic the CV-Manager `PUT /:id/stage` endpoint
 * uses, extracted so the calling console ("Done → advance") can reuse it.
 *
 * Stages with an application equivalent (screening/certified/interview_scheduled)
 * cascade to all non-terminal applications and re-derive via syncCandidateStage.
 * new / future_pool — or a candidate with no active applications — fall back to a
 * direct candidates.status write. Emits `candidate_stage_changed` either way.
 *
 * @param {string} candidateId
 * @param {('new'|'screening'|'certified'|'interview_scheduled'|'future_pool')} stage
 * @returns {Promise<{updatedApplications: number}>}
 */
async function setCandidateStage(candidateId, stage) {
    if (!candidateId || !stage) return { updatedApplications: 0 };
    const appStatus = STAGE_TO_APP_STATUS[stage] || null;
    let updatedApps = 0;

    if (appStatus) {
        // Don't downgrade terminal/closed applications.
        const certClause = appStatus === 'certified'
            ? ', certified_at = COALESCE(certified_at, NOW())'
            : '';
        const upRes = await query(
            adaptQuery(`
                UPDATE applications SET status = $1, updated_at = NOW()${certClause}
                WHERE candidate_id = $2
                  AND status NOT IN ('rejected','hired','transferred','merged','selected','placed')
            `),
            [appStatus, candidateId]
        );
        updatedApps = upRes.rowCount || (upRes.rows ? upRes.rows.length : 0);
    }

    if (appStatus && updatedApps > 0) {
        // Re-derive candidate.status (+ conversation_stage); emits on change.
        await syncCandidateStage(candidateId);
    } else {
        // new / future_pool, or no active applications to cascade to.
        // CV is the hard gate (#5): a CV-less candidate can never sit past New
        // (future_pool / certified / interview_scheduled set directly here) —
        // fall back to New (awaiting CV). Subsumes the future_pool case.
        let finalStage = stage;
        if (stage !== 'new' && !(await candidateHasCv(candidateId))) {
            finalStage = 'new';
        }
        await query(
            adaptQuery('UPDATE candidates SET status = $1, conversation_stage = $1, updated_at = NOW() WHERE id = $2'),
            [finalStage, candidateId]
        );
        emitStageChanged(candidateId, finalStage);
    }
    return { updatedApplications: updatedApps };
}

module.exports = {
    STAGE_ORDER,
    APP_STATUS_TO_STAGE,
    STAGE_TO_APP_STATUS,
    PROTECTED_CANDIDATE_STATUSES,
    CANDIDATE_STATUSES,
    APPLICATION_STATUSES,
    CANDIDATE_STATUS_SET,
    APPLICATION_STATUS_SET,
    LEGACY_APP_STATUS_MAP,
    normalizeApplicationStatus,
    deriveCandidateStage,
    syncCandidateStage,
    setCandidateStage,
    emitStageChanged,
    hasCvSql,
    candidateHasCv,
};
