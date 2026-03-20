/**
 * SMS Service
 * Handles sending SMS notifications via Notify.lk (or configurable provider)
 * Credentials are configured via environment variables
 */
const axios = require('axios');
const logger = require('../utils/logger');

// Notify.lk configuration
const NOTIFYLK_USER_ID = process.env.NOTIFYLK_USER_ID || '';
const NOTIFYLK_API_KEY = process.env.NOTIFYLK_API_KEY || '';
const NOTIFYLK_SENDER_ID = process.env.NOTIFYLK_SENDER_ID || 'DewanRec';

/**
 * Send SMS message via Notify.lk
 * @param {string} to - Phone number (with country code)
 * @param {string} message - Message content (max 160 chars for single SMS)
 * @returns {Object} Response or simulated result
 */
async function sendSMS(to, message) {
    const cleanPhone = to.replace(/[^0-9+]/g, '');

    // If credentials are not configured, simulate sending
    if (!NOTIFYLK_USER_ID || !NOTIFYLK_API_KEY) {
        logger.info(`[SMS SIMULATED] To: ${cleanPhone} | Message: ${message.substring(0, 80)}...`);
        return {
            success: true,
            simulated: true,
            to: cleanPhone,
            message: 'SMS simulated (credentials not configured)',
            preview: message.substring(0, 160)
        };
    }

    try {
        const response = await axios.post('https://app.notify.lk/api/v1/send', null, {
            params: {
                user_id: NOTIFYLK_USER_ID,
                api_key: NOTIFYLK_API_KEY,
                sender_id: NOTIFYLK_SENDER_ID,
                to: cleanPhone,
                message: message.substring(0, 480) // Max 3 SMS segments
            }
        });

        logger.info(`SMS sent to ${cleanPhone}: ${response.data?.status || 'ok'}`);
        return {
            success: true,
            simulated: false,
            to: cleanPhone,
            response: response.data
        };
    } catch (error) {
        logger.error(`SMS send error to ${cleanPhone}:`, error.response?.data || error.message);
        throw new Error(`SMS send failed: ${error.response?.data?.message || error.message}`);
    }
}

/**
 * Send bulk SMS to multiple recipients
 * @param {Array<{phone: string, message: string}>} recipients
 * @returns {Array<Object>} Results for each recipient
 */
async function sendBulkSMS(recipients) {
    const results = [];
    for (const { phone, message } of recipients) {
        try {
            const result = await sendSMS(phone, message);
            results.push({ phone, ...result });
        } catch (error) {
            results.push({ phone, success: false, error: error.message });
        }
    }
    return results;
}

module.exports = {
    sendSMS,
    sendBulkSMS
};
