/**
 * Conversation counts — shared SQL building blocks
 * =================================================
 * One definition of "which candidates does the Conversations panel count, and
 * how are they bucketed by canonical status" — imported by BOTH the
 * `/active-chats` list, the `/active-chats/counts` aggregate, AND the
 * Applications page's `/api/applications/status-totals`. Keeping the filter
 * predicates and the bucketing expression in one place is what guarantees the
 * Messages tab badges, the list rows, and the Applications candidate-by-stage
 * strip can never silently diverge.
 *
 * Population predicate (the "conversation gate"): only candidates that actually
 * have a WhatsApp thread (`lm.sent_at IS NOT NULL`). This is intrinsic to a
 * conversations panel and is applied identically wherever these helpers are used.
 */
const { adaptQuery } = require('../utils/query-adapter');

// Effective project = the candidate's latest application's project, falling back
// to the CTWA ad they arrived on (ad_tracking). Must stay byte-identical to the
// SELECT alias used in the list endpoint so the WHERE and SELECT agree.
const EFF_PROJECT_ID_EXPR = `COALESCE(la.project_id, adt.project_id)`;

// Derived pipeline stage (a triage axis, NOT the canonical status). Mirrors the
// expression inlined in the list/counts endpoints.
const PIPELINE_STAGE_EXPR = `
    CASE
        WHEN COALESCE(ca.is_human_handoff, FALSE) = TRUE THEN 'human_takeover_active'
        WHEN COALESCE(ca.requires_human, FALSE) = TRUE THEN 'pending_human_review'
        WHEN LOWER(COALESCE(ca.cv_status, '')) = 'parsed' THEN 'cv_parsed'
        WHEN COALESCE(ca.cv_uploaded, FALSE) = TRUE THEN 'cv_uploaded'
        WHEN LOWER(COALESCE(la.application_status, '')) IN ('hired', 'rejected')
             OR LOWER(COALESCE(ca.status, '')) IN ('hired', 'merged') THEN 'shortlisted_or_rejected'
        ELSE 'bot_engaging'
    END`;

// The canonical status buckets surfaced as Messages tabs. Mutually exclusive,
// driven by ca.status (kept in sync by candidate-stage.js). NULL = 'new'.
const CANDIDATE_STATUS_BUCKETS = new Set(['new', 'screening', 'certified', 'interview_scheduled', 'future_pool']);

/**
 * Build the conversation filter clauses shared by the list and counts endpoints.
 *
 * @param {object}   opts
 * @param {object}   opts.query              - the Express req.query
 * @param {*}        opts.userId             - req.user.id (for claimed=me)
 * @param {Function} opts.addParam           - (value) => placeholder string; pushes to the caller's params array
 * @param {boolean}  opts.includeStatusBucket- apply the single-bucket status filter (true for the list, false for counts which fan out per bucket)
 * @returns {string[]} filter clauses (AND-joined by the caller)
 *
 * A search is a GLOBAL lookup — it bypasses the status-bucket + project scope so
 * the candidate is found no matter which tab/project is selected.
 */
function buildConversationFilters({ query, userId, addParam, includeStatusBucket }) {
    const filters = [];
    const {
        search = '',
        status,
        project_id,
        pipeline_stage,
        handoff_state,
        response_status,
        date_from,
        date_to,
    } = query;

    const isSearch = Boolean(String(search || '').trim());
    if (isSearch) {
        const sp = addParam(`%${search}%`);
        filters.push(`(ca.name ILIKE ${sp} OR ca.phone ILIKE ${sp} OR ca.whatsapp_phone ILIKE ${sp})`);
    }

    if (includeStatusBucket && !isSearch && status && CANDIDATE_STATUS_BUCKETS.has(String(status).toLowerCase())) {
        filters.push(`LOWER(COALESCE(ca.status, 'new')) = ${addParam(String(status).toLowerCase())}`);
    }

    if (!isSearch && project_id) {
        if (String(project_id).toLowerCase() === 'unassigned') {
            filters.push(`${EFF_PROJECT_ID_EXPR} IS NULL`);
        } else {
            filters.push(`${EFF_PROJECT_ID_EXPR} = ${addParam(project_id)}`);
        }
    }

    if (pipeline_stage) filters.push(`${PIPELINE_STAGE_EXPR} = ${addParam(pipeline_stage)}`);

    if (handoff_state === 'human') filters.push(`ca.is_human_handoff = TRUE`);
    else if (handoff_state === 'bot') filters.push(`COALESCE(ca.is_human_handoff, FALSE) = FALSE`);

    if (query.disposition) filters.push(`ca.disposition = ${addParam(query.disposition)}`);
    if (query.call_status === 'on_call') filters.push(`ca.call_status = 'on_call'`);
    if (query.contacted === 'yes') filters.push(`ca.last_contacted_at IS NOT NULL`);
    else if (query.contacted === 'no') filters.push(`ca.last_contacted_at IS NULL`);
    if (query.claimed === 'me') filters.push(`ca.claimed_by = ${addParam(userId)}`);
    else if (query.claimed === 'unassigned') filters.push(`ca.claimed_by IS NULL`);

    if (date_from) filters.push(`lm.sent_at >= ${addParam(date_from)}`);
    if (date_to) filters.push(`lm.sent_at <= ${addParam(date_to)}`);

    if (response_status === 'awaiting_candidate') filters.push(`lm.direction = 'outbound'`);
    else if (response_status === 'awaiting_agent') filters.push(`lm.direction = 'inbound'`);
    else if (response_status === 'unread') { filters.push(`lm.direction = 'inbound'`); filters.push(`lm.read_at IS NULL`); }
    else if (response_status === 'replied') { filters.push(`lm.direction = 'outbound'`); filters.push(`(lm.read_at IS NOT NULL OR lm.delivered_at IS NOT NULL)`); }

    // Conversation gate: only candidates that actually have a WhatsApp thread.
    // Applied to the list AND every count so badges == rows.
    filters.push(`lm.sent_at IS NOT NULL`);

    return filters;
}

/**
 * Build the candidate-level per-status counts query. The FROM/JOIN block matches
 * the list endpoint's population (lm conversation gate, la latest application for
 * project scope, adt ad fallback, cvf CV presence) so the aggregate counts the
 * exact same rows the list would return.
 *
 * @param {object}  opts
 * @param {string}  opts.whereClause - the full "WHERE ..." string (or '') from buildConversationFilters
 * @param {boolean} opts.includeHired - also emit the hired bucket (Applications strip wants it; Messages tabs don't)
 * @returns {string} adapted SQL
 */
function buildCandidateStatusCountsSql({ whereClause = '', includeHired = false } = {}) {
    const hasCvExpr = `(ca.cv_uploaded IS TRUE OR cvf.has_cv_file IS TRUE)`;
    const statusCount = (value, alias) =>
        `COUNT(*) FILTER (WHERE LOWER(COALESCE(ca.status,'new')) = '${value}') AS ${alias}`;

    return adaptQuery(`
        SELECT
            COUNT(*) AS total_chats,
            COUNT(*) FILTER (WHERE COALESCE(ca.is_human_handoff, FALSE) = TRUE)  AS human_controlled,
            COUNT(*) FILTER (WHERE COALESCE(ca.is_human_handoff, FALSE) = FALSE) AS bot_controlled,
            COUNT(*) FILTER (WHERE ${hasCvExpr}) AS cv_uploaded,
            ${statusCount('new', 'st_new')},
            ${statusCount('screening', 'st_screening')},
            ${statusCount('certified', 'st_certified')},
            ${statusCount('interview_scheduled', 'st_interview_scheduled')},
            ${statusCount('future_pool', 'st_future_pool')}${includeHired ? `,
            ${statusCount('hired', 'st_hired')}` : ''}
        FROM candidates ca
        LEFT JOIN (
            SELECT DISTINCT ON (candidate_id)
                candidate_id, direction, read_at, delivered_at, sent_at
            FROM communications
            WHERE channel = 'whatsapp'
            ORDER BY candidate_id, sent_at DESC
        ) lm ON lm.candidate_id = ca.id
        LEFT JOIN (
            SELECT DISTINCT ON (a.candidate_id)
                a.candidate_id, a.status AS application_status, j.project_id AS project_id
            FROM applications a
            LEFT JOIN jobs j ON j.id = a.job_id
            ORDER BY a.candidate_id, COALESCE(a.updated_at, a.applied_at) DESC
        ) la ON la.candidate_id = ca.id
        LEFT JOIN (
            SELECT t.ad_ref, t.project_id FROM ad_tracking t
        ) adt ON adt.ad_ref = ca.ad_ref
        LEFT JOIN LATERAL (
            SELECT TRUE AS has_cv_file FROM cv_files f WHERE f.candidate_id = ca.id LIMIT 1
        ) cvf ON TRUE
        ${whereClause}
    `);
}

/** Shape the raw counts row into the API response object. */
function shapeCountsRow(row, { includeHired = false } = {}) {
    const r = row || {};
    const num = (v) => parseInt(v, 10) || 0;
    const by_status = {
        new: num(r.st_new),
        screening: num(r.st_screening),
        certified: num(r.st_certified),
        interview_scheduled: num(r.st_interview_scheduled),
        future_pool: num(r.st_future_pool),
    };
    if (includeHired) by_status.hired = num(r.st_hired);
    return {
        total_chats: num(r.total_chats),
        bot_controlled: num(r.bot_controlled),
        human_controlled: num(r.human_controlled),
        cv_uploaded: num(r.cv_uploaded),
        by_status,
    };
}

module.exports = {
    EFF_PROJECT_ID_EXPR,
    PIPELINE_STAGE_EXPR,
    CANDIDATE_STATUS_BUCKETS,
    buildConversationFilters,
    buildCandidateStatusCountsSql,
    shapeCountsRow,
};
