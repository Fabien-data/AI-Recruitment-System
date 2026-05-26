/**
 * Chatbot Notifier
 * Pushes outbound candidate-status WhatsApp messages through the chatbot service.
 * The chatbot owns the single WhatsApp Business identity, so candidates see
 * proactive notifications in the same thread as their bot conversation.
 *
 * Maps internal notification types -> chatbot /webhook/candidate-status `status` values.
 */
const axios = require('axios');
const logger = require('../utils/logger');

const TYPE_TO_STATUS = {
    certified: 'certified',
    prescreening_certified: 'prescreening_certified',
    interview_scheduled: 'interview_scheduled',
    interview_reminder: 'interview_reminder',
    selected: 'hired',
    rejected: 'rejected_with_alternatives',
    general_pool: 'general_pool',
    transfer: 'transferred',
};

function mapType(type) {
    return TYPE_TO_STATUS[type] || type;
}

/**
 * Push a candidate status update through the chatbot's webhook.
 * Returns { ok, messageId?, error? } — never throws.
 */
async function pushCandidateStatus({
    phone,
    name,
    type,
    jobTitle,
    interviewDate,
    interviewLocation,
    alternativeJobs,
    prescreeningDatetime,
    prescreeningLocation,
    certificationNotes,
    oldJobTitle,
    newJobTitle,
}) {
    const base = process.env.CHATBOT_API_URL;
    const key = process.env.CHATBOT_API_KEY;

    if (!base || !key) {
        return { ok: false, error: 'CHATBOT_API_URL or CHATBOT_API_KEY missing' };
    }
    if (!phone) {
        return { ok: false, error: 'candidate phone is empty' };
    }

    const status = mapType(type);
    const payload = {
        candidate_phone: phone,
        candidate_name: name || '',
        status,
        job_title: jobTitle || newJobTitle || '',
        interview_date: interviewDate || null,
        interview_location: interviewLocation || null,
        alternative_jobs: alternativeJobs || null,
        prescreening_datetime: prescreeningDatetime || null,
        prescreening_location: prescreeningLocation || null,
        certification_notes: certificationNotes || null,
        old_job_title: oldJobTitle || null,
        new_job_title: newJobTitle || null,
    };

    try {
        const url = `${base.replace(/\/$/, '')}/webhook/candidate-status`;
        const resp = await axios.post(url, payload, {
            headers: {
                'x-chatbot-api-key': key,
                'Content-Type': 'application/json',
            },
            timeout: 15000,
        });

        const body = resp.data || {};
        if (body.status === 'sent') {
            return { ok: true, messageId: body.message_id || null };
        }
        // Chatbot responded but did not confirm a send (skipped / candidate_not_found / error)
        const reason = body.detail || body.reason || body.status || 'chatbot did not confirm delivery';
        logger.warn(`chatbotNotifier: non-sent response for ${phone} (${status}): ${JSON.stringify(body)}`);
        return { ok: false, error: String(reason) };
    } catch (err) {
        const detail = err.response?.data?.detail || err.response?.data || err.message;
        logger.error(`chatbotNotifier: POST failed for ${phone} (${status}): ${JSON.stringify(detail)}`);
        return { ok: false, error: typeof detail === 'string' ? detail : JSON.stringify(detail) };
    }
}

module.exports = {
    pushCandidateStatus,
    mapType,
};
