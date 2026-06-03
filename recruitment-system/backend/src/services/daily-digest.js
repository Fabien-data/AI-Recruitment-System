/**
 * Daily Recruitment Digest
 * ========================
 * Gathers a once-a-day snapshot (interviews today, re-engaged candidates, newly
 * stuck candidates, job re-engagement messages sent, callback tasks due) and
 * emails it to admin/supervisor users via the recruiter-alerts pipeline.
 *
 * Triggered by Cloud Scheduler → POST /api/internal/daily-digest (run ~08:00).
 */

const { query } = require('../config/database');
const { adaptQuery } = require('../utils/query-adapter');
const logger = require('../utils/logger');
const { recruiterAlert } = require('./recruiter-alerts');

async function _scalar(sql, params = []) {
    try {
        const r = await query(adaptQuery(sql), params);
        return (r.rows[0] && Number(r.rows[0].n)) || 0;
    } catch (err) {
        logger.warn(`daily-digest: query failed — ${err.message}`);
        return 0;
    }
}

/** Build the digest numbers (Asia/Colombo day boundaries where relevant). */
async function gatherDigest() {
    const [interviews_today, reengaged_today, new_stuck, job_matches_today, tasks_due] = await Promise.all([
        _scalar(`SELECT COUNT(*)::int AS n FROM interview_schedules
                 WHERE status IN ('scheduled','confirmed')
                   AND (scheduled_datetime AT TIME ZONE 'Asia/Colombo')::date
                       = (NOW() AT TIME ZONE 'Asia/Colombo')::date`),
        _scalar(`SELECT COUNT(DISTINCT candidate_id)::int AS n FROM communications
                 WHERE direction = 'inbound' AND sent_at >= NOW() - INTERVAL '24 hours'`),
        _scalar(`SELECT COUNT(*)::int AS n FROM candidates
                 WHERE status IN ('new','screening')
                   AND COALESCE(requires_human, FALSE) = FALSE
                   AND COALESCE(last_interaction, created_at) < NOW() - INTERVAL '2 days'`),
        _scalar(`SELECT COUNT(*)::int AS n FROM communications
                 WHERE direction = 'outbound'
                   AND metadata->>'notification_type' = 'job_now_available'
                   AND sent_at >= NOW() - INTERVAL '24 hours'`),
        _scalar(`SELECT COUNT(*)::int AS n FROM candidate_tasks
                 WHERE status = 'pending' AND due_at <= NOW()`),
    ]);

    return {
        date: new Date().toISOString().slice(0, 10),
        interviews_today,
        reengaged_today,
        new_stuck,
        job_matches_today,
        tasks_due,
    };
}

/** Gather + email the digest to admins. Returns the digest data. */
async function runDailyDigest() {
    const data = await gatherDigest();
    try {
        await recruiterAlert('daily_digest', data, null);
    } catch (err) {
        logger.warn(`daily-digest: send failed — ${err.message}`);
    }
    logger.info(`daily-digest: ${JSON.stringify(data)}`);
    return data;
}

module.exports = { gatherDigest, runDailyDigest };
