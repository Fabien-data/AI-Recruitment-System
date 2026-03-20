import requests
import json
import time
from sqlalchemy import text
from sqlalchemy import create_engine

CHATBOT_URL = 'http://localhost:8000/webhook/whatsapp'
DB_URL = 'postgresql+psycopg2://postgres:Shifter%40321c@localhost:5432/chatbot_db'

engine = create_engine(DB_URL)

def send_msg(phone, text_msg):
    payload = {
        'object': 'whatsapp_business_account',
        'entry': [{
            'id': 'test',
            'changes': [{
                'value': {
                    'messaging_product': 'whatsapp',
                    'contacts': [{'profile': {'name': 'Tester'}, 'wa_id': phone}],
                    'messages': [{'from': phone, 'id': f'wamid.{int(time.time()*1000)}', 'timestamp': str(int(time.time())), 'text': {'body': text_msg}, 'type': 'text'}]
                }
            }]
        }]
    }
    requests.post(CHATBOT_URL, json=payload)
    time.sleep(2) # wait for async processing

def check_candidate_state(phone):
    with engine.connect() as conn:
        result = conn.execute(text(f"SELECT bot_state, preferred_language FROM candidates WHERE phone_number = '{phone}'"))
        row = result.fetchone()
        if row:
            return {'bot_state': row[0], 'preferred_language': row[1]}
    return None

def test_a1():
    print('Running A1.1: English start')
    p1 = '777000111'
    send_msg(p1, 'Hello')
    state = check_candidate_state(p1)
    print(f'A1.1 State: {state}')

    print('Running A1.2: Sinhala start')
    p2 = '777000222'
    send_msg(p2, '????????')
    state = check_candidate_state(p2)
    print(f'A1.2 State: {state}')

if __name__ == '__main__':
    test_a1()
