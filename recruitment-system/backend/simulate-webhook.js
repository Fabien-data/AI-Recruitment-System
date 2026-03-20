/**
 * Simulate WhatsApp Webhook
 * Sends a fake WhatsApp message to your local server
 */
const axios = require('axios');

const PORT = 3000;
const WEBHOOK_URL = `http://localhost:${PORT}/webhooks/whatsapp`;

async function simulateMessage() {
    console.log('🚀 Sending fake WhatsApp message to:', WEBHOOK_URL);

    const payload = {
        object: 'whatsapp_business_account',
        entry: [{
            id: '123456789',
            changes: [{
                value: {
                    messaging_product: 'whatsapp',
                    metadata: { display_phone_number: '1234567890', phone_number_id: '123456789' },
                    contacts: [{ profile: { name: 'Test User' }, wa_id: '94771234567' }],
                    messages: [{
                        from: '94771234567',
                        id: 'wamid.test.' + Date.now(),
                        timestamp: Math.floor(Date.now() / 1000),
                        type: 'text',
                        text: { body: 'Hello, I want to apply for a job' }
                    }]
                },
                field: 'messages'
            }]
        }]
    };

    try {
        const response = await axios.post(WEBHOOK_URL, payload);
        console.log('✅ Webhook sent! Server responded with:', response.status, response.statusText);
        console.log('👉 Check your backend terminal to see the logs.');
    } catch (error) {
        console.error('❌ Error sending webhook:', error.message);
        if (error.code === 'ECONNREFUSED') {
            console.error('   Is your backend server running? (npm run dev)');
        }
    }
}

simulateMessage();
