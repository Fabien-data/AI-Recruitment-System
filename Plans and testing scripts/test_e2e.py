import requests
import json
import time

CHATBOT_URL = 'http://localhost:8000/webhook/whatsapp'
BACKEND_URL = 'http://localhost:3000'

def send_msg(phone, text):
    payload = {
        'object': 'whatsapp_business_account',
        'entry': [{
            'id': '123',
            'changes': [{
                'value': {
                    'messaging_product': 'whatsapp',
                    'contacts': [{'profile': {'name': 'Test User'}, 'wa_id': phone}],
                    'messages': [{'from': phone, 'id': f'wamid.{int(time.time()*1000)}', 'timestamp': str(int(time.time())), 'text': {'body': text}, 'type': 'text'}]
                }
            }]
        }]
    }
    r = requests.post(CHATBOT_URL, json=payload)
    print(f'Sent {text} to {phone}, response: {r.status_code}')
    time.sleep(1)

def test_a1_language_flow():
    print('Testing A1...')
    send_msg('111111111', 'Hello')
    send_msg('222222222', '????????')
    send_msg('333333333', '???????')
    
if __name__ == '__main__':
    test_a1_language_flow()
