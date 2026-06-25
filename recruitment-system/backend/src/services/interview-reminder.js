/**
 * Interview Reminder Service
 *
 * Called by the Cloud Scheduler-triggered queue processor
 * (POST /api/internal/process-queue → sendPendingReminders).
 *
 * Recurring cadence (replaces the old one-shot 24h reminder):
 *   • Daily pass   — a friendly reminder on each of the final 3 days BEFORE the
 *                    interview (at most one per Asia/Colombo day).
 *   • Day-of pass  — a distinct, more urgent reminder on the interview date
 *                    itself (the morning of).
 *
 * All "today"/date comparisons are done in Asia/Colombo (the candidate's TZ) so
 * the day boundaries match how candidates experience them, not UTC.
 *
 * Graceful degrade: the cadence needs columns added in migration 025
 * (last_reminder_date, reminder_count, dayof_reminder_sent_at). On prod the
 * interview_schedules table may be postgres-owned, so those ALTERs can be
 * rejected. If the columns are absent we fall back to the legacy single 24h
 * reminder keyed on reminder_sent_at, so reminders still go out — just not the
 * full cadence. Run scripts/fix-interview-ownership.js to enable it.
 *
 * Sends are send-then-mark: a row is only marked once its WhatsApp send
 * succeeds, so a failed send is naturally retried on the next sweep.
 */

const { query } = require('../config/database');
const { adaptQuery } = require('../utils/query-adapter');
const notifications = require('./notifications');
const logger = require('../utils/logger');

// One-time (cached) check for the migration-025 cadence columns. Mirrors the
// interviewHasDescriptionColumn() pattern in routes/interviews.js.
let _hasCadenceCols = null;
async function hasCadenceColumns() {
    if (_hasCadenceCols !== null) return _hasCadenceCols;
    try {
        const r = await query(adaptQuery(
            `SELECT 1 FROM information_schema.columns
              WHERE table_name = 'interview_schedules'
                AND column_name = 'last_reminder_date' LIMIT 1`
        ), []);
        _hasCadenceCols = r.rows.length > 0;
    } catch (_) {
        _hasCadenceCols = false;
    }
    return _hasCadenceCols;
}

const SELECT_FIELDS = `
    iv.id, iv.scheduled_datetime, iv.location,
    c.id AS candidate_id,
    j.title AS job_title`;

const JOINS = `
    FROM interview_schedules iv
    JOIN applications a ON iv.application_id = a.id
    JOIN candidates c ON a.candidate_id = c.id
    JOIN jobs j ON a.job_id = j.id`;

/**
 * Daily reminders for the final 3 days BEFORE the interview (excludes the
 * interview date itself — that's handled by the day-of pass). At most one per
 * Asia/Colombo day per interview.
 */
async function runDailyPass(stats) {
    const result = await query(adaptQuery(`
        SELECT ${SELECT_FIELDS} ${JOINS}
        WHERE iv.status IN ('scheduled', 'confirmed')
          AND iv.scheduled_datetime > NOW()
          AND iv.scheduled_datetime <= NOW() + INTERVAL '3 days'
          AND (iv.scheduled_datetime AT TIME ZONE 'Asia/Colombo')::date
              > (NOW() AT TIME ZONE 'Asia/Colombo')::date
          AND (iv.last_reminder_date IS NULL
               OR iv.last_reminder_date < (NOW() AT TIME ZONE 'Asia/Colombo')::date)
        ORDER BY iv.scheduled_datetime ASC
        LIMIT 100
    `));

    for (const iv of result.rows) {
        try {
            const notif = await notifications.sendInterviewReminderNotification(
                iv.candidate_id, iv.job_title, iv.scheduled_datetime, iv.location || 'TBD', ['whatsapp']
            );
            if (notif.success.some(s => s.channel === 'whatsapp')) {
                await query(
                    adaptQuery(`
                        UPDATE interview_schedules
                           SET last_reminder_date = (NOW() AT TIME ZONE 'Asia/Colombo')::date,
                               reminder_count = COALESCE(reminder_count, 0) + 1,
                               reminder_sent_at = NOW()
                         WHERE id = $1
                    `),
                    [iv.id]
                );
                logger.info(`interview-reminder: daily reminder sent for interview ${iv.id}`);
                stats.sent++;
            } else {
                logger.warn(`interview-reminder: daily send not confirmed for ${iv.id} — will retry next sweep`);
                stats.failed++;
            }
        } catch (err) {
            logger.error(`interview-reminder: daily failed for ${iv.id} — ${err.message}`);
            stats.failed++;
        }
    }
}

/**
 * Distinct morning-of reminder on the interview date itself. Fires at most once
 * per interview (guarded by dayof_reminder_sent_at).
 */
async function runDayOfPass(stats) {
    const result = await query(adaptQuery(`
        SELECT ${SELECT_FIELDS} ${JOINS}
        WHERE iv.status IN ('scheduled', 'confirmed')
          AND iv.dayof_reminder_sent_at IS NULL
          AND (iv.scheduled_datetime AT TIME ZONE 'Asia/Colombo')::date
              = (NOW() AT TIME ZONE 'Asia/Colombo')::date
          AND iv.scheduled_datetime >= NOW()
        ORDER BY iv.scheduled_datetime ASC
        LIMIT 100
    `));

    for (const iv of result.rows) {
        try {
            const notif = await notifications.sendInterviewDayOfNotification(
                iv.candidate_id, iv.job_title, iv.scheduled_datetime, iv.location || 'TBD', ['whatsapp']
            );
            if (notif.success.some(s => s.channel === 'whatsapp')) {
                await query(
                    adaptQuery('UPDATE interview_schedules SET dayof_reminder_sent_at = NOW() WHERE id = $1'),
                    [iv.id]
                );
                logger.info(`interview-reminder: day-of reminder sent for interview ${iv.id}`);
                stats.sent++;
            } else {
                logger.warn(`interview-reminder: day-of send not confirmed for ${iv.id} — will retry next sweep`);
                stats.failed++;
            }
        } catch (err) {
            logger.error(`interview-reminder: day-of failed for ${iv.id} — ${err.message}`);
            stats.failed++;
        }
    }
}

/**
 * Legacy fallback used only when the migration-025 cadence columns are absent
 * (prod table-ownership block). Single reminder for interviews in the next 24h.
 */
async function runLegacyPass(stats) {
    const result = await query(adaptQuery(`
        SELECT ${SELECT_FIELDS} ${JOINS}
        WHERE iv.status IN ('scheduled', 'confirmed')
          AND iv.reminder_sent_at IS NULL
          AND iv.scheduled_datetime BETWEEN NOW() AND NOW() + INTERVAL '24 hours'
        ORDER BY iv.scheduled_datetime ASC
        LIMIT 50
    `));

    for (const iv of result.rows) {
        try {
            const notif = await notifications.sendInterviewReminderNotification(
                iv.candidate_id, iv.job_title, iv.scheduled_datetime, iv.location || 'TBD', ['whatsapp']
            );
            if (notif.success.some(s => s.channel === 'whatsapp')) {
                await query(
                    adaptQuery('UPDATE interview_schedules SET reminder_sent_at = NOW() WHERE id = $1'),
                    [iv.id]
                );
                logger.info(`interview-reminder: (legacy) reminder sent for interview ${iv.id}`);
                stats.sent++;
            } else {
                stats.failed++;
            }
        } catch (err) {
            logger.error(`interview-reminder: (legacy) failed for ${iv.id} — ${err.message}`);
            stats.failed++;
        }
    }
}

/**
 * Send all due interview reminders (recurring daily cadence + day-of).
 * Returns { sent, failed }.
 */
async function sendPendingReminders() {
    const stats = { sent: 0, failed: 0 };
    try {
        if (await hasCadenceColumns()) {
            await runDailyPass(stats);
            await runDayOfPass(stats);
        } else {
            logger.warn('interview-reminder: cadence columns missing (migration 025 not applied — likely table-ownership); using legacy 24h reminder. Run scripts/fix-interview-ownership.js.');
            await runLegacyPass(stats);
        }
    } catch (err) {
        logger.error('interview-reminder: sendPendingReminders error —', err.message);
        throw err;
    }
    return stats;
}

module.exports = { sendPendingReminders };
