/**
 * User KPI Service
 * ================
 *
 * Computes the four KPI categories used by the admin User Detail page and the
 * printable KPI Report:
 *
 *   1. Activity volume    — total actions, total views, per-day timeseries
 *   2. Work output        — created/updated/deleted/viewed counts per entity_type
 *   3. Response &
 *      throughput         — avg time-to-first-action after login, avg session
 *                            duration, login count
 *   4. Section usage      — hits per section_key (excluding nulls bucketed as _other)
 *
 * All four aggregations share the same date window so they round-trip in one query.
 */

const { pool } = require('../config/database');
const logger = require('../utils/logger');

// Remembers whether the audit_logs.section_key / session_id columns exist so
// the legacy fallback path is only taken when needed. See middleware/audit.js
// for the same pattern — both are reset to true on process restart.
let hasMigration021Cols = true;

/**
 * @param {string} userId
 * @param {Date|string} from
 * @param {Date|string} to
 */
async function computeUserKpi(userId, from, to) {
    const sql = `
        WITH p AS (
            SELECT
                $1::uuid        AS uid,
                $2::timestamptz AS dfrom,
                $3::timestamptz AS dto
        )
        SELECT
            -- 1) Activity volume
            (SELECT COUNT(*)::int FROM audit_logs a, p
               WHERE a.user_id = p.uid
                 AND a.created_at BETWEEN p.dfrom AND p.dto
            ) AS total_actions,

            (SELECT COUNT(*)::int FROM audit_logs a, p
               WHERE a.user_id = p.uid
                 AND a.action = 'view'
                 AND a.created_at BETWEEN p.dfrom AND p.dto
            ) AS total_views,

            (SELECT COUNT(*)::int FROM audit_logs a, p
               WHERE a.user_id = p.uid
                 AND a.action = 'login'
                 AND a.created_at BETWEEN p.dfrom AND p.dto
            ) AS total_logins,

            COALESCE((
                SELECT json_agg(t ORDER BY t.day)
                FROM (
                    SELECT date_trunc('day', a.created_at) AS day,
                           COUNT(*)::int                   AS actions,
                           COUNT(*) FILTER (WHERE a.action = 'view')::int   AS views,
                           COUNT(*) FILTER (WHERE a.action = 'create')::int AS created,
                           COUNT(*) FILTER (WHERE a.action = 'update')::int AS updated,
                           COUNT(*) FILTER (WHERE a.action = 'delete')::int AS deleted
                    FROM audit_logs a, p
                    WHERE a.user_id = p.uid
                      AND a.created_at BETWEEN p.dfrom AND p.dto
                    GROUP BY 1
                ) t
            ), '[]'::json) AS activity_by_day,

            -- 2) Work output by entity
            COALESCE((
                SELECT json_agg(t ORDER BY (t.created + t.updated + t.deleted) DESC)
                FROM (
                    SELECT
                        a.entity_type,
                        COUNT(*) FILTER (WHERE a.action = 'create')::int AS created,
                        COUNT(*) FILTER (WHERE a.action = 'update')::int AS updated,
                        COUNT(*) FILTER (WHERE a.action = 'delete')::int AS deleted,
                        COUNT(*) FILTER (WHERE a.action = 'view')::int   AS viewed
                    FROM audit_logs a, p
                    WHERE a.user_id = p.uid
                      AND a.created_at BETWEEN p.dfrom AND p.dto
                    GROUP BY 1
                ) t
            ), '[]'::json) AS work_by_entity,

            -- 3a) Response: avg seconds between login and the next non-login action
            (SELECT AVG(EXTRACT(EPOCH FROM (a.created_at - s.login_at)))::int
             FROM user_sessions s
             LEFT JOIN LATERAL (
                 SELECT created_at
                 FROM audit_logs
                 WHERE session_id = s.id AND action <> 'login'
                 ORDER BY created_at ASC
                 LIMIT 1
             ) a ON true, p
             WHERE s.user_id = p.uid
               AND s.login_at BETWEEN p.dfrom AND p.dto
               AND a.created_at IS NOT NULL
            ) AS avg_first_action_seconds,

            -- 3b) Throughput: avg session duration (ms), only for closed sessions
            (SELECT AVG(duration_ms)::bigint FROM user_sessions s, p
               WHERE s.user_id = p.uid
                 AND s.logout_at IS NOT NULL
                 AND s.login_at BETWEEN p.dfrom AND p.dto
            ) AS avg_session_ms,

            -- 3c) Throughput: total session count
            (SELECT COUNT(*)::int FROM user_sessions s, p
               WHERE s.user_id = p.uid
                 AND s.login_at BETWEEN p.dfrom AND p.dto
            ) AS total_sessions,

            -- 3d) Action breakdown (for pie chart)
            COALESCE((
                SELECT json_agg(t ORDER BY t.count DESC)
                FROM (
                    SELECT a.action, COUNT(*)::int AS count
                    FROM audit_logs a, p
                    WHERE a.user_id = p.uid
                      AND a.created_at BETWEEN p.dfrom AND p.dto
                    GROUP BY 1
                ) t
            ), '[]'::json) AS action_breakdown,

            -- 4) Section usage breakdown
            COALESCE((
                SELECT json_agg(t ORDER BY t.hits DESC)
                FROM (
                    SELECT COALESCE(a.section_key, '_other') AS section,
                           COUNT(*)::int                     AS hits
                    FROM audit_logs a, p
                    WHERE a.user_id = p.uid
                      AND a.created_at BETWEEN p.dfrom AND p.dto
                    GROUP BY 1
                ) t
            ), '[]'::json) AS section_usage
    `;

    let result;
    if (hasMigration021Cols) {
        try {
            result = await pool.query(sql, [userId, from, to]);
        } catch (err) {
            const msg = (err.message || '').toLowerCase();
            if (msg.includes('session_id') || msg.includes('section_key') || msg.includes('column')) {
                hasMigration021Cols = false;
                logger.warn('kpi: Migration 021 columns missing on audit_logs — using legacy KPI query. Run scripts/fix-audit-ownership.js.');
            } else {
                throw err;
            }
        }
    }

    if (!hasMigration021Cols) {
        // Legacy query: no session_id / section_key references. Drops the
        // "response & throughput" first-action-after-login metric and the
        // section_usage breakdown (which require those columns) — they come
        // back as null/empty so the UI degrades gracefully.
        const legacySql = `
            WITH p AS (
                SELECT $1::uuid uid, $2::timestamptz dfrom, $3::timestamptz dto
            )
            SELECT
                (SELECT COUNT(*)::int FROM audit_logs a, p
                   WHERE a.user_id = p.uid AND a.created_at BETWEEN p.dfrom AND p.dto
                ) AS total_actions,
                (SELECT COUNT(*)::int FROM audit_logs a, p
                   WHERE a.user_id = p.uid AND a.action = 'view'
                     AND a.created_at BETWEEN p.dfrom AND p.dto
                ) AS total_views,
                (SELECT COUNT(*)::int FROM audit_logs a, p
                   WHERE a.user_id = p.uid AND a.action = 'login'
                     AND a.created_at BETWEEN p.dfrom AND p.dto
                ) AS total_logins,
                COALESCE((
                    SELECT json_agg(t ORDER BY t.day)
                    FROM (
                        SELECT date_trunc('day', a.created_at) AS day,
                               COUNT(*)::int                   AS actions,
                               COUNT(*) FILTER (WHERE a.action='view')::int   AS views,
                               COUNT(*) FILTER (WHERE a.action='create')::int AS created,
                               COUNT(*) FILTER (WHERE a.action='update')::int AS updated,
                               COUNT(*) FILTER (WHERE a.action='delete')::int AS deleted
                        FROM audit_logs a, p
                        WHERE a.user_id = p.uid AND a.created_at BETWEEN p.dfrom AND p.dto
                        GROUP BY 1
                    ) t
                ), '[]'::json) AS activity_by_day,
                COALESCE((
                    SELECT json_agg(t ORDER BY (t.created + t.updated + t.deleted) DESC)
                    FROM (
                        SELECT a.entity_type,
                               COUNT(*) FILTER (WHERE a.action='create')::int AS created,
                               COUNT(*) FILTER (WHERE a.action='update')::int AS updated,
                               COUNT(*) FILTER (WHERE a.action='delete')::int AS deleted,
                               COUNT(*) FILTER (WHERE a.action='view')::int   AS viewed
                        FROM audit_logs a, p
                        WHERE a.user_id = p.uid AND a.created_at BETWEEN p.dfrom AND p.dto
                        GROUP BY 1
                    ) t
                ), '[]'::json) AS work_by_entity,
                NULL::int AS avg_first_action_seconds,
                (SELECT AVG(duration_ms)::bigint FROM user_sessions s, p
                   WHERE s.user_id = p.uid AND s.logout_at IS NOT NULL
                     AND s.login_at BETWEEN p.dfrom AND p.dto
                ) AS avg_session_ms,
                (SELECT COUNT(*)::int FROM user_sessions s, p
                   WHERE s.user_id = p.uid AND s.login_at BETWEEN p.dfrom AND p.dto
                ) AS total_sessions,
                COALESCE((
                    SELECT json_agg(t ORDER BY t.count DESC)
                    FROM (
                        SELECT a.action, COUNT(*)::int AS count
                        FROM audit_logs a, p
                        WHERE a.user_id = p.uid AND a.created_at BETWEEN p.dfrom AND p.dto
                        GROUP BY 1
                    ) t
                ), '[]'::json) AS action_breakdown,
                '[]'::json AS section_usage
        `;
        result = await pool.query(legacySql, [userId, from, to]);
    }

    const row = result?.rows?.[0] || {};
    return {
        from,
        to,
        total_actions:            row.total_actions            ?? 0,
        total_views:              row.total_views              ?? 0,
        total_logins:             row.total_logins             ?? 0,
        total_sessions:           row.total_sessions           ?? 0,
        avg_first_action_seconds: row.avg_first_action_seconds ?? null,
        avg_session_ms:           row.avg_session_ms != null ? Number(row.avg_session_ms) : null,
        activity_by_day:          row.activity_by_day || [],
        work_by_entity:           row.work_by_entity  || [],
        action_breakdown:         row.action_breakdown || [],
        section_usage:            row.section_usage   || [],
    };
}

module.exports = { computeUserKpi };
