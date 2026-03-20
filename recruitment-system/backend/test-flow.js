const axios = require('axios');

async function testChatbotFlow() {
    const url = 'http://localhost:3000/webhooks/whatsapp';

    // Simulate a random phone number
    const phoneNumber = '94770000000' + Math.floor(Math.random() * 1000);

    async function sendMessage(text) {
        console.log(`\n\n=== Sending: "${text}" ===`);
        try {
            const response = await axios.post(url, {
                object: 'whatsapp_business_account',
                entry: [{
                    changes: [{
                        field: 'messages',
                        value: {
                            contacts: [{ profile: { name: 'Test User' }, wa_id: phoneNumber }],
                            messages: [{
                                from: phoneNumber,
                                id: `wamid.HBgL${Math.floor(Math.random() * 10000000)}`,
                                timestamp: Math.floor(Date.now() / 1000).toString(),
                                type: 'text',
                                text: { body: text }
                            }]
                        }
                    }]
                }]
            });
            console.log('Webhook Response (Async):', response.status);
        } catch (error) {
            console.error('Error sending message:', error.message);
        }
        // Wait a bit for the background processing to log
        await new Promise(resolve => setTimeout(resolve, 3000));
    }

    // Follow the expected flow
    await sendMessage('Hi there!');
    await sendMessage('1'); // English
    await sendMessage('Software Engineer'); // Job
    await sendMessage('Australia'); // Country
    await sendMessage('5 years'); // Experience
}

testChatbotFlow();
