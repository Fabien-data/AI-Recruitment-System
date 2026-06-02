/**
 * Shared SQL fragments for the jobs read path.
 *
 * `positions_filled` is no longer a stored value we trust — it is derived from
 * applications with status in ('selected','placed'). Every read of jobs must
 * include this LATERAL join so the count reflects reality.
 *
 * The stored `positions_filled` column on jobs is kept for one release as a
 * denormalized cache but is no longer written by the application layer.
 */

const POSITIONS_FILLED_JOIN = `
    LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS positions_filled
        FROM applications a
        WHERE a.job_id = j.id AND a.status IN ('selected','placed')
    ) pf ON TRUE
`;

const POSITIONS_FILLED_SELECT = `
    pf.positions_filled AS positions_filled,
    GREATEST(0, COALESCE(j.positions_available, 0) - pf.positions_filled) AS positions_remaining
`;

/**
 * Per-job pipeline counts surfaced on the Jobs cards / detail:
 *  - applied_count      : every application on the job (total candidates)
 *  - pending_count      : applications still awaiting recruiter action
 *  - cv_uploaded_count  : applicants who have actually uploaded a CV
 *
 * A single LATERAL keeps it to one extra scan per job row. The CV check
 * trusts a cv_files row OR the candidates.cv_uploaded flag, so it stays
 * correct whether the CV arrived via the chatbot (cv_files) or an older
 * flag-only path.
 */
const JOB_COUNTS_JOIN = `
    LEFT JOIN LATERAL (
        SELECT
            COUNT(*)::int AS applied_count,
            COUNT(*) FILTER (
                WHERE a.status IN ('applied','auto_assigned','screening','reviewing')
            )::int AS pending_count,
            COUNT(*) FILTER (
                WHERE c.cv_uploaded IS TRUE
                   OR EXISTS (SELECT 1 FROM cv_files f WHERE f.candidate_id = c.id)
            )::int AS cv_uploaded_count
        FROM applications a
        JOIN candidates c ON a.candidate_id = c.id
        WHERE a.job_id = j.id
    ) jc ON TRUE
`;

const JOB_COUNTS_SELECT = `
    COALESCE(jc.applied_count, 0)     AS applied_count,
    COALESCE(jc.pending_count, 0)     AS pending_count,
    COALESCE(jc.cv_uploaded_count, 0) AS cv_uploaded_count
`;

module.exports = {
    POSITIONS_FILLED_JOIN,
    POSITIONS_FILLED_SELECT,
    JOB_COUNTS_JOIN,
    JOB_COUNTS_SELECT,
};
