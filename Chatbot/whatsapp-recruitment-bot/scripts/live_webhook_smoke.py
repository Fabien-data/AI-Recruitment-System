import random
import time
import requests

base = "https://whatsapp-chatbot-782458551389.us-central1.run.app/webhook/whatsapp"
phone = "9477009" + str(random.randint(10000, 99999))

messages = ["Hi", "I like to go someplace amazing", "hmm"]

for text in messages:
    msg_id = f"wamid.TEST_{int(time.time())}_{random.randint(1000,9999)}"
    payload = {
        "object": "whatsapp_business_account",
        "entry": [
            {
                "id": "TEST",
                "changes": [
                    {
                        "field": "messages",
                        "value": {
                            "messaging_product": "whatsapp",
                            "metadata": {
                                "display_phone_number": "123",
                                "phone_number_id": "123",
                            },
                            "contacts": [
                                {
                                    "profile": {"name": "E2E Tester"},
                                    "wa_id": phone,
                                }
                            ],
                            "messages": [
                                {
                                    "from": phone,
                                    "id": msg_id,
                                    "timestamp": str(int(time.time())),
                                    "type": "text",
                                    "text": {"body": text},
                                }
                            ],
                        },
                    }
                ],
            }
        ],
    }

    response = requests.post(base, json=payload, timeout=20)
    print(f"POST {text!r} -> {response.status_code} {response.text}")
    time.sleep(1)

print(f"PHONE={phone}")
