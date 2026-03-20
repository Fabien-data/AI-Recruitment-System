/**
 * Recruiter Alerts Service
 * Sends real-time alerts to recruiters when key events occur:
 * - new_candidate: chatbot intake completed
 * - human_handoff: candidate requested human support
 * - high_match_candidate: candidate with >0.85 match score
 * - interview_reminder: upcoming interview in 24h
 * - queue_failure: notification queue has failed items
 */

const { query } = require('../config/database');
const { adaptQuery } = require('../utils/query-adapter');
const logger = require('../utils/logger');

const ALERT_TYPES = {
    new_candidate: {
        subject: '🆕 New Candidate Submitted via WhatsApp',
        priority: 'normal'
    },
    human_handoff: {
        subject: '⚠️ Candidate Requesting Human Support',
        priority: 'high'
    },
    high_match_candidate: {
        subject: '⭐ High-Match Candidate Available',
        priority: 'normal'
    },
    interview_reminder: {
        subject: '📅 Interview Reminder — Tomorrow',
        priority: 'normal'
    },
    queue_failure: {
        subject: '🚨 Notification Queue Has Failed Items',
        priority: 'high'
    }
};

/**
 * Build email body for a recruiter alert
 */
function buildAlertEmailBody(alertType, data) {
    switch (alertType) {
        case 'new_candidate':
            return `
<p>A new candidate has submitted their application via the WhatsApp chatbot.</p>
<table style="border-collapse:collapse;width:100%">
  <tr><td style="padding:4px 8px;font-weight:bold">Name</td><td style="padding:4px 8px">${data.candidate?.name || 'Unknown'}</td></tr>
  <tr><td style="padding:4px 8px;font-weight:bold">Phone</td><td style="padding:4px 8px">${data.candidate?.phone || '-'}</td></tr>
  <tr><td style="padding:4px 8px;font-weight:bold">Job Interest</td><td style="padding:4px 8px">${data.jobTitle || '-'}</td></tr>
  <tr><td style="padding:4px 8px;font-weight:bold">Match Score</td><td style="padding:4px 8px">${data.matchScore != null ? `${Math.round(data.matchScore * 100)}%` : 'Pending'}</td></tr>
  <tr><td style="padding:4px 8px;font-weight:bold">Source</td><td style="padding:4px 8px">${data.adRef ? `Ad: ${data.adRef}` : 'Direct WhatsApp'}</td></tr>
</table>
<p><a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/candidates/${data.candidate?.id}">View Candidate Profile →</a></p>
`;

        case 'human_handoff':
            return `
<p>A candidate on WhatsApp has requested to speak with a human recruiter.</p>
<table style="border-collapse:collapse;width:100%">
  <tr><td style="padding:4px 8px;font-weight:bold">Phone</td><td style="padding:4px 8px">${data.candidatePhone || 'Unknown'}</td></tr>
  <tr><td style="padding:4px 8px;font-weight:bold">Last Message</td><td style="padding:4px 8px"><em>${data.lastMessage || '-'}</em></td></tr>
  <tr><td style="padding:4px 8px;font-weight:bold">Time</td><td style="padding:4px 8px">${new Date().toLocaleString()}</td></tr>
</table>
<p>Please respond to the candidate on WhatsApp as soon as possible.</p>
`;

        case 'high_match_candidate':
            return `
<p>A candidate with a high match score has been detected for one of your jobs.</p>
<table style="border-collapse:collapse;width:100%">
  <tr><td style="padding:4px 8px;font-weight:bold">Candidate</td><td style="padding:4px 8px">${data.candidate?.name || 'Unknown'}</td></tr>
  <tr><td style="padding:4px 8px;font-weight:bold">Job</td><td style="padding:4px 8px">${data.jobTitle || '-'}</td></tr>
  <tr><td style="padding:4px 8px;font-weight:bold">Match Score</td><td style="padding:4px 8px">${data.matchScore != null ? `${Math.round(data.matchScore * 100)}%` : '-'}</td></tr>
</table>
<p><a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/jobs/${data.jobId}/candidates">Review Candidate →</a></p>
`;

        case 'interview_reminder':
            return `
<p>You have an interview scheduled for tomorrow.</p>
<table style="border-collapse:collapse;width:100%">
  <tr><td style="padding:4px 8px;font-weight:bold">Candidate</td><td style="padding:4px 8px">${data.candidateName || 'Unknown'}</td></tr>
  <tr><td style="padding:4px 8px;font-weight:bold">Job</td><td style="padding:4px 8px">${data.jobTitle || '-'}</td></tr>
  <tr><td style="padding:4px 8px;font-weight:bold">Time</td><td style="padding:4px 8px">${data.scheduledDatetime || '-'}</td></tr>
  <tr><td style="padding:4px 8px;font-weight:bold">Location</td><td style="padding:4px 8px">${data.location || 'TBD'}</td></tr>
</table>
`;

        case 'queue_failure':
            return `
<p>The notification queue has items that have exceeded retry limits.</p>
<table style="border-collapse:collapse;width:100%">
  <tr><td style="padding:4px 8px;font-weight:bold">Failed Count</td><td style="padding:4px 8px">${data.failedCount || 0}</td></tr>
</table>
<p>Please check the notification_queue table for details.</p>
`;

        default:
            return `<p>Recruiter alert: ${alertType}</p><pre>${JSON.stringify(data, null, 2)}</pre>`;
    }
}

/**
 * Find recruiters to notify for a given job / project
 * Returns array of user records with email and phone
 */
async function findRecruitersForJob(jobId) {
    try {
        if (!jobId) {
            // Fallback: notify all admin users
            const result = await query(
                adaptQuery("SELECT id, email, full_name, phone FROM users WHERE role IN ('admin','supervisor') AND is_active = true"),
                []
            );
            return result.rows;
        }

        // Find recruiters assigned to the project that owns this job
        const result = await query(
            adaptQuery(`
                SELECT DISTINCT u.id, u.email, u.full_name, u.phone
                FROM users u
                JOIN project_assignments pa ON u.id = pa.user_id
                JOIN jobs j ON pa.project_id = j.project_id
                WHERE j.id = $1 AND u.is_active = true
                UNION
                SELECT id, email, full_name, phone FROM users
                WHERE role = 'admin' AND is_active = true
            `),
            [jobId]
        );
        return result.rows;
    } catch (err) {
        logger.warn(`recruiter-alerts: could not fetch recruiters — ${err.message}`);
        return [];
    }
}

/**
 * Send recruiter alert via email (and optionally WhatsApp)
 * @param {string} alertType - One of ALERT_TYPES keys
 * @param {Object} data - Context data for the alert
 * @param {string} [jobId] - Optional job ID to narrow down which recruiters to notify
 */
async function recruiterAlert(alertType, data = {}, jobId = null) {
    const alertConfig = ALERT_TYPES[alertType];
    if (!alertConfig) {
        logger.warn(`recruiter-alerts: unknown alert type "${alertType}"`);
        return;
    }

    try {
        const recruiters = await findRecruitersForJob(jobId || data.jobId || null);

        if (recruiters.length === 0) {
            logger.warn(`recruiter-alerts: no recruiters found for alert "${alertType}"`);
            return;
        }

        const htmlBody = buildAlertEmailBody(alertType, data);
        const subject = alertConfig.subject;

        // Send email via Gmail service if connected
        try {
            const gmailService = require('./gmail');
            const isConnected = await gmailService.isConnected();

            if (isConnected) {
                for (const recruiter of recruiters) {
                    if (recruiter.email) {
                        await gmailService.sendEmail(
                            recruiter.email,
                            subject,
                            htmlBody,
                            recruiter.full_name
                        ).catch(err =>
                            logger.warn(`recruiter-alerts: email to ${recruiter.email} failed — ${err.message}`)
                        );
                        logger.info(`recruiter-alerts: emailed ${recruiter.email} for "${alertType}"`);
                    }
                }
            } else {
                logger.info(`recruiter-alerts: Gmail not connected — alert "${alertType}" logged only`);
            }
        } catch (gmailErr) {
            logger.warn(`recruiter-alerts: Gmail error — ${gmailErr.message}`);
        }

        // Optionally send WhatsApp to recruiters who have a phone
        if (process.env.WHATSAPP_ACCESS_TOKEN && (alertConfig.priority === 'high')) {
            const whatsapp = require('./whatsapp');
            const textBody = subject + '\n\n' + htmlBody.replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim();

            for (const recruiter of recruiters) {
                if (recruiter.phone) {
                    whatsapp.sendTextMessage(recruiter.phone, textBody).catch(err =>
                        logger.warn(`recruiter-alerts: WhatsApp to ${recruiter.phone} failed — ${err.message}`)
                    );
                }
            }
        }

        logger.info(`recruiter-alerts: alert "${alertType}" dispatched to ${recruiters.length} recruiter(s)`);
    } catch (err) {
        logger.error(`recruiter-alerts: unexpected error for "${alertType}" — ${err.message}`);
    }
}

module.exports = { recruiterAlert, findRecruitersForJob };
