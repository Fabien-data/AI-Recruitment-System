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

module.exports = {
    POSITIONS_FILLED_JOIN,
    POSITIONS_FILLED_SELECT,
};
