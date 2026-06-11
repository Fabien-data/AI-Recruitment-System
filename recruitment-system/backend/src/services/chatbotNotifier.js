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
    welcome: 'welcome',
    application_complete: 'application_complete',
    job_assignment: 'job_assignment',
    certified: 'certified',
    prescreening_certified: 'prescreening_certified',
    interview_scheduled: 'interview_scheduled',
    interview_reminder: 'interview_reminder',
    interview_day_reminder: 'interview_day_reminder',
    interview_rescheduled: 'interview_rescheduled',
    interview_cancelled: 'interview_cancelled',
    selected: 'hired',
    rejected: 'rejected_with_alternatives',
    general_pool: 'general_pool',
    transfer: 'transferred',
    job_now_available: 'job_now_available',
    reengage: 'reengage',
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
    language,
    jobTitle,
    interviewDate,
    interviewLocation,
    interviewNotes,
    translateNotes,
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
        // CRM-side preferred language so the chatbot can localise even for
        // candidates it auto-creates (agency imports who never messaged the bot).
        language: language || null,
        job_title: jobTitle || newJobTitle || '',
        interview_date: interviewDate || null,
        interview_location: interviewLocation || null,
        interview_notes: interviewNotes || null,
        translate_notes: translateNotes === true,
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
            // `via`/`template`/`full_text` are set when the chatbot delivered an
            // approved template instead of free-form (out-of-window): full_text
            // is the rendered free-form message the caller can queue to deliver
            // on the candidate's next reply.
            return {
                ok: true,
                messageId: body.message_id || null,
                via: body.via || 'freeform',
                template: body.template || null,
                fullText: body.full_text || null,
            };
        }
        // Chatbot responded but did not confirm a send (skipped / candidate_not_found / error).
        // `reason` is the coarse, structured classification (no_whatsapp / out_of_window /
        // token_expired / rate_limited / other) the caller uses to flag unreachable
        // candidates; `error` stays the human-readable detail.
        const errText = body.detail || body.reason || body.status || 'chatbot did not confirm delivery';
        logger.warn(`chatbotNotifier: non-sent response for ${phone} (${status}): ${JSON.stringify(body)}`);
        return { ok: false, error: String(errText), reason: body.reason || null, code: body.code || null };
    } catch (err) {
        const detail = err.response?.data?.detail || err.response?.data || err.message;
        logger.error(`chatbotNotifier: POST failed for ${phone} (${status}): ${JSON.stringify(detail)}`);
        return { ok: false, error: typeof detail === 'string' ? detail : JSON.stringify(detail), reason: null, code: null };
    }
}

/**
 * Send an agent's free-form reply (text or media) through the chatbot so it goes
 * out on the chatbot's WhatsApp identity — the working token. The backend's own
 * Meta token is frequently expired (the "token split-brain"), which silently
 * dropped takeover replies. Returns { ok, messageId?, reason?, error? } and never
 * throws, so the caller can record an honest delivery status.
 */
async function sendAgentMessage({ phone, message = '', messageType = 'text', mediaUrl = null, filename = null }) {
    const base = process.env.CHATBOT_API_URL;
    const key = process.env.CHATBOT_API_KEY;
    if (!base || !key) {
        return { ok: false, error: 'CHATBOT_API_URL or CHATBOT_API_KEY missing', reason: 'config' };
    }
    if (!phone) {
        return { ok: false, error: 'candidate phone is empty', reason: 'no_phone' };
    }

    const payload = {
        candidate_phone: phone,
        message: message || '',
        message_type: messageType || 'text',
        media_url: mediaUrl || null,
        filename: filename || null,
    };

    try {
        const url = `${base.replace(/\/$/, '')}/webhook/agent-message`;
        const resp = await axios.post(url, payload, {
            headers: { 'x-chatbot-api-key': key, 'Content-Type': 'application/json' },
            timeout: 20000,
        });
        const body = resp.data || {};
        if (body.status === 'sent') {
            return { ok: true, messageId: body.message_id || null };
        }
        if (body.status === 'queued') {
            // Candidate is outside the 24h window: the chatbot (optionally) sent
            // a re-engagement template and the actual message should be parked in
            // pending_messages to auto-deliver on the candidate's next reply.
            return {
                ok: false,
                queued: true,
                reason: body.reason || 'out_of_window',
                reengageSent: !!body.reengage_message_id,
                reengageMessageId: body.reengage_message_id || null,
            };
        }
        const errText = body.detail || body.reason || body.status || 'chatbot did not confirm delivery';
        logger.warn(`chatbotNotifier.sendAgentMessage: non-sent for ${phone}: ${JSON.stringify(body)}`);
        return { ok: false, error: String(errText), reason: body.reason || null, code: body.code || null };
    } catch (err) {
        const detail = err.response?.data?.detail || err.response?.data || err.message;
        logger.error(`chatbotNotifier.sendAgentMessage: POST failed for ${phone}: ${JSON.stringify(detail)}`);
        return { ok: false, error: typeof detail === 'string' ? detail : JSON.stringify(detail), reason: null, code: null };
    }
}

module.exports = {
    pushCandidateStatus,
    sendAgentMessage,
    mapType,
};
