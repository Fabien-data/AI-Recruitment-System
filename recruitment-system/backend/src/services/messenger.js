const axios = require('axios');

const PAGE_ACCESS_TOKEN = process.env.MESSENGER_PAGE_ACCESS_TOKEN;
const GRAPH_API_URL = 'https://graph.facebook.com/v18.0';

/**
 * Send Messenger text message
 */
async function sendTextMessage(recipientId, message) {
    try {
        const response = await axios.post(
            `${GRAPH_API_URL}/me/messages`,
            {
                recipient: { id: recipientId },
                message: { text: message }
            },
            {
                params: { access_token: PAGE_ACCESS_TOKEN }
            }
        );
        
        return response.data;
    } catch (error) {
        console.error('Messenger send error:', error.response?.data || error.message);
        throw error;
    }
}

/**
 * Send Messenger message with buttons
 */
async function sendButtonMessage(recipientId, text, buttons) {
    try {
        const response = await axios.post(
            `${GRAPH_API_URL}/me/messages`,
            {
                recipient: { id: recipientId },
                message: {
                    attachment: {
                        type: 'template',
                        payload: {
                            template_type: 'button',
                            text: text,
                            buttons: buttons.map(btn => ({
                                type: 'web_url',
                                url: btn.url,
                                title: btn.title
                            }))
                        }
                    }
                }
            },
            {
                params: { access_token: PAGE_ACCESS_TOKEN }
            }
        );
        
        return response.data;
    } catch (error) {
        console.error('Messenger button send error:', error.response?.data || error.message);
        throw error;
    }
}

/**
 * Send typing indicator
 */
async function sendTypingIndicator(recipientId, isTyping = true) {
    try {
        await axios.post(
            `${GRAPH_API_URL}/me/messages`,
            {
                recipient: { id: recipientId },
                sender_action: isTyping ? 'typing_on' : 'typing_off'
            },
            {
                params: { access_token: PAGE_ACCESS_TOKEN }
            }
        );
    } catch (error) {
        console.error('Messenger typing indicator error:', error.response?.data || error.message);
    }
}

/**
 * Get user profile information
 */
async function getUserProfile(userId) {
    try {
        const response = await axios.get(
            `${GRAPH_API_URL}/${userId}`,
            {
                params: {
                    fields: 'first_name,last_name,profile_pic',
                    access_token: PAGE_ACCESS_TOKEN
                }
            }
        );
        
        return response.data;
    } catch (error) {
        console.error('Messenger profile fetch error:', error.response?.data || error.message);
        throw error;
    }
}

module.exports = {
    sendTextMessage,
    sendButtonMessage,
    sendTypingIndicator,
    getUserProfile
};
