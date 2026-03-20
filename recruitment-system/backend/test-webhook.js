const payload = {
    "object": "whatsapp_business_account",
    "entry": [
        {
            "id": "704620442619448",
            "changes": [
                {
                    "value": {
                        "messaging_product": "whatsapp",
                        "metadata": {
                            "display_phone_number": "15551874252",
                            "phone_number_id": "900210539852935"
                        },
                        "contacts": [
                            {
                                "profile": {
                                    "name": "Tiran Dewnith"
                                },
                                "wa_id": "94765716780"
                            }
                        ],
                        "messages": [
                            {
                                "from": "94765716780",
                                "id": "wamid.test_",
                                "timestamp": Math.floor(Date.now() / 1000).toString(),
                                "text": {
                                    "body": "Hi"
                                },
                                "type": "text"
                            }
                        ]
                    },
                    "field": "messages"
                }
            ]
        }
    ]
};

fetch('http://localhost:3000/webhooks/whatsapp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
})
    .then(r => r.text())
    .then(text => console.log('Response:', text))
    .catch(err => console.error('Error:', err));
