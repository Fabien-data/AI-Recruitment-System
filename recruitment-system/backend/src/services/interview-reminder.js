/**
 * Interview Reminder Service
 *
 * Called by the Cloud Scheduler-triggered queue processor.
 * Finds interviews scheduled within the next 24 hours where no reminder has been sent,
 * sends candidate notifications, and marks reminder_sent_at.
 */

const { query } = require('../config/database');
const { adaptQuery } = require('../utils/query-adapter');
const notifications = require('./notifications');
const logger = require('../utils/logger');

/**
 * Send pending interview reminders for interviews in the next 24 hours.
 * Returns { sent, failed }
 */
async function sendPendingReminders() {
    const stats = { sent: 0, failed: 0 };

    try {
        const result = await query(adaptQuery(`
            SELECT
                iv.id, iv.scheduled_datetime, iv.location,
                c.id AS candidate_id,
                j.title AS job_title
            FROM interview_schedules iv
            JOIN applications a ON iv.application_id = a.id
            JOIN candidates c ON a.candidate_id = c.id
            JOIN jobs j ON a.job_id = j.id
            WHERE iv.status IN ('scheduled', 'confirmed')
              AND iv.reminder_sent_at IS NULL
              AND iv.scheduled_datetime BETWEEN NOW() AND NOW() + INTERVAL '24 hours'
            ORDER BY iv.scheduled_datetime ASC
            LIMIT 50
        `));

        for (const iv of result.rows) {
            try {
                await notifications.sendInterviewNotification(
                    iv.candidate_id,
                    iv.job_title,
                    iv.scheduled_datetime,
                    iv.location || 'TBD',
                    ['whatsapp']
                );

                await query(
                    adaptQuery('UPDATE interview_schedules SET reminder_sent_at = NOW() WHERE id = $1'),
                    [iv.id]
                );

                logger.info(`interview-reminder: sent reminder for interview ${iv.id}`);
                stats.sent++;
            } catch (err) {
                logger.error(`interview-reminder: failed for ${iv.id} — ${err.message}`);
                stats.failed++;
            }
        }
    } catch (err) {
        logger.error('interview-reminder: sendPendingReminders error —', err.message);
        throw err;
    }

    return stats;
}

module.exports = { sendPendingReminders };
