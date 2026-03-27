import re

with open('Chatbot/whatsapp-recruitment-bot/app/chatbot.py', 'r', encoding='utf-8') as f:
    text = f.read()

# Replace AWAITING_JOB
job_pattern = re.compile(
    r'(elif state == self\.STATE_AWAITING_JOB:\s+text_norm = _normalize_text\(text\))'
    r'(\s+# If user just clicked.*?)(self\._save_intake\(db, candidate, \'job_interest\', job_interest_value\))',
    re.MULTILINE | re.DOTALL
)
job_repl = r'''\1

            # 1. Attempt Data Extraction
            target_data = _entities.get("job_roles")
            if not target_data:
                target_data = [text_norm] if len(text_norm) >= 3 else []
            
            job_interest_value = str(target_data[0]) if isinstance(target_data, list) and target_data else str(target_data)

            # 2. The Happy Path
            if job_interest_value and job_interest_value.strip() and job_interest_value.lower() not in ["none", "nothing"]:
                \3'''

text = job_pattern.sub(job_repl, text, count=1)

with open('Chatbot/whatsapp-recruitment-bot/app/chatbot.py', 'w', encoding='utf-8') as f:
    f.write(text)
print("AWAITING_JOB replaced!")
