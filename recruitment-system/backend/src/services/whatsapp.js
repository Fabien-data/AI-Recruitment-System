const axios = require('axios');
const logger = require('../utils/logger');

const WHATSAPP_API_URL = 'https://graph.facebook.com/v18.0';

// Read credentials lazily on every send. They used to be captured once at
// module load, so if the env var was injected late (Cloud Run secret) or
// rotated at runtime, the stale `undefined`/old value was baked in forever.
function getPhoneNumberId() {
    return process.env.WHATSAPP_PHONE_NUMBER_ID;
}
function getAccessToken() {
    return process.env.WHATSAPP_ACCESS_TOKEN;
}

/**
 * Throw a clear, actionable error when the WhatsApp credentials are missing,
 * instead of letting Meta reject the call with the opaque
 * "Cannot parse access token" (error 190).
 */
function assertConfigured() {
    const phoneNumberId = getPhoneNumberId();
    const accessToken = getAccessToken();
    if (!phoneNumberId || !accessToken) {
        const missing = [
            !phoneNumberId && 'WHATSAPP_PHONE_NUMBER_ID',
            !accessToken && 'WHATSAPP_ACCESS_TOKEN',
        ].filter(Boolean).join(', ');
        throw new Error(`WhatsApp not configured: missing ${missing}`);
    }
    return { phoneNumberId, accessToken };
}

/**
 * Log the full Meta Graph API error (code + subcode + message + fbtrace_id)
 * so token problems are diagnosable from the logs. Meta returns
 * `error.code === 190` ("Cannot parse access token") for expired/invalid tokens.
 */
function logMetaError(context, error) {
    const metaError = error.response?.data?.error;
    if (metaError) {
        logger.error(
            `WhatsApp ${context} failed (Meta error): ` +
            `code=${metaError.code} subcode=${metaError.error_subcode || '-'} ` +
            `fbtrace_id=${metaError.fbtrace_id || '-'} message="${metaError.message}"`
        );
        if (metaError.code === 190) {
            logger.error(
                'WhatsApp access token is invalid or expired (code 190). ' +
                'Rotate WHATSAPP_ACCESS_TOKEN with a fresh Meta System User token and redeploy.'
            );
        }
    } else {
        logger.error(`WhatsApp ${context} failed: ${error.message}`);
    }
}

/**
 * Send WhatsApp text message
 */
async function sendTextMessage(to, message) {
    const { phoneNumberId, accessToken } = assertConfigured();
    try {
        const response = await axios.post(
            `${WHATSAPP_API_URL}/${phoneNumberId}/messages`,
            {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: to.replace(/[^0-9]/g, ''), // Clean phone number
                type: 'text',
                text: { body: message }
            },
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        return response.data;
    } catch (error) {
        logMetaError('text send', error);
        throw error;
    }
}

/**
 * Send WhatsApp template message
 */
async function sendTemplateMessage(to, templateName, languageCode, components = []) {
    const { phoneNumberId, accessToken } = assertConfigured();
    try {
        const response = await axios.post(
            `${WHATSAPP_API_URL}/${phoneNumberId}/messages`,
            {
                messaging_product: 'whatsapp',
                to: to.replace(/[^0-9]/g, ''),
                type: 'template',
                template: {
                    name: templateName,
                    language: { code: languageCode },
                    components
                }
            },
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        return response.data;
    } catch (error) {
        logMetaError('template send', error);
        throw error;
    }
}

/**
 * Send WhatsApp media message (image, document, audio, video)
 */
async function sendMediaMessage(to, type, mediaUrl, caption = '') {
    const { phoneNumberId, accessToken } = assertConfigured();
    try {
        const payload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: to.replace(/[^0-9]/g, ''),
            type,
            [type]: {
                link: mediaUrl
            }
        };

        if (caption && (type === 'image' || type === 'document' || type === 'video')) {
            payload[type].caption = caption;
        }

        const response = await axios.post(
            `${WHATSAPP_API_URL}/${phoneNumberId}/messages`,
            payload,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        return response.data;
    } catch (error) {
        logMetaError(`${type} send`, error);
        throw error;
    }
}

/**
 * Download media from WhatsApp
 */
async function downloadMedia(mediaId) {
    const { accessToken } = assertConfigured();
    try {
        // Step 1: Get media URL
        const mediaResponse = await axios.get(
            `${WHATSAPP_API_URL}/${mediaId}`,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                }
            }
        );

        const mediaUrl = mediaResponse.data.url;

        // Step 2: Download the actual file
        const fileResponse = await axios.get(mediaUrl, {
            headers: {
                'Authorization': `Bearer ${accessToken}`
            },
            responseType: 'arraybuffer'
        });

        return {
            data: fileResponse.data,
            mimeType: fileResponse.headers['content-type'],
            filename: `whatsapp_${mediaId}.${getExtensionFromMimeType(fileResponse.headers['content-type'])}`
        };
    } catch (error) {
        logMetaError('media download', error);
        throw error;
    }
}

/**
 * Mark message as read
 */
async function markMessageAsRead(messageId) {
    let creds;
    try {
        creds = assertConfigured();
    } catch (error) {
        logger.warn(`Skipping mark-as-read: ${error.message}`);
        return;
    }
    try {
        await axios.post(
            `${WHATSAPP_API_URL}/${creds.phoneNumberId}/messages`,
            {
                messaging_product: 'whatsapp',
                status: 'read',
                message_id: messageId
            },
            {
                headers: {
                    'Authorization': `Bearer ${creds.accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );
    } catch (error) {
        logMetaError('mark read', error);
    }
}

/**
 * Validate the WhatsApp token against Meta (GET /{phone_number_id}?fields=id).
 * Use at boot or in a health check to catch an expired token before candidates do.
 * Returns { ok: true } or { ok: false, error, code }.
 */
async function verifyCredentials() {
    let creds;
    try {
        creds = assertConfigured();
    } catch (error) {
        return { ok: false, error: error.message };
    }
    try {
        await axios.get(`${WHATSAPP_API_URL}/${creds.phoneNumberId}`, {
            params: { fields: 'id' },
            headers: { 'Authorization': `Bearer ${creds.accessToken}` },
            timeout: 10000,
        });
        return { ok: true };
    } catch (error) {
        const metaError = error.response?.data?.error;
        return {
            ok: false,
            code: metaError?.code,
            error: metaError?.message || error.message,
        };
    }
}

/**
 * Helper function to get file extension from MIME type
 */
function getExtensionFromMimeType(mimeType) {
    const extensions = {
        'application/pdf': 'pdf',
        'application/msword': 'doc',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/jpg': 'jpg'
    };
    return extensions[mimeType] || 'bin';
}

module.exports = {
    sendTextMessage,
    sendTemplateMessage,
    sendMediaMessage,
    downloadMedia,
    markMessageAsRead,
    verifyCredentials
};
