const axios = require('axios');
const FormData = require('form-data');

const WHATSAPP_API_URL = 'https://graph.facebook.com/v18.0';
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;

/**
 * Send WhatsApp text message
 */
async function sendTextMessage(to, message) {
    try {
        const response = await axios.post(
            `${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: 'whatsapp',
                recipient_type: 'individual',
                to: to.replace(/[^0-9]/g, ''), // Clean phone number
                type: 'text',
                text: { body: message }
            },
            {
                headers: {
                    'Authorization': `Bearer ${ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        return response.data;
    } catch (error) {
        console.error('WhatsApp send error:', error.response?.data || error.message);
        throw error;
    }
}

/**
 * Send WhatsApp template message
 */
async function sendTemplateMessage(to, templateName, languageCode, components = []) {
    try {
        const response = await axios.post(
            `${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/messages`,
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
                    'Authorization': `Bearer ${ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        return response.data;
    } catch (error) {
        console.error('WhatsApp template send error:', error.response?.data || error.message);
        throw error;
    }
}

/**
 * Download media from WhatsApp
 */
async function downloadMedia(mediaId) {
    try {
        // Step 1: Get media URL
        const mediaResponse = await axios.get(
            `${WHATSAPP_API_URL}/${mediaId}`,
            {
                headers: {
                    'Authorization': `Bearer ${ACCESS_TOKEN}`
                }
            }
        );
        
        const mediaUrl = mediaResponse.data.url;
        
        // Step 2: Download the actual file
        const fileResponse = await axios.get(mediaUrl, {
            headers: {
                'Authorization': `Bearer ${ACCESS_TOKEN}`
            },
            responseType: 'arraybuffer'
        });
        
        return {
            data: fileResponse.data,
            mimeType: fileResponse.headers['content-type'],
            filename: `whatsapp_${mediaId}.${getExtensionFromMimeType(fileResponse.headers['content-type'])}`
        };
    } catch (error) {
        console.error('WhatsApp media download error:', error.response?.data || error.message);
        throw error;
    }
}

/**
 * Mark message as read
 */
async function markMessageAsRead(messageId) {
    try {
        await axios.post(
            `${WHATSAPP_API_URL}/${PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: 'whatsapp',
                status: 'read',
                message_id: messageId
            },
            {
                headers: {
                    'Authorization': `Bearer ${ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );
    } catch (error) {
        console.error('WhatsApp mark read error:', error.response?.data || error.message);
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
    downloadMedia,
    markMessageAsRead
};
