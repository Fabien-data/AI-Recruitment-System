import re

with open(r"c:\Users\Tiran's PC\Documents\GitHub\AI-Recruitment-System\Chatbot\whatsapp-recruitment-bot\app\chatbot.py", "r", encoding="utf-8") as f:
    text = f.read()

m = re.search(r"        elif state == self\.STATE_AWAITING_JOB:(.*?)        # ── AWAITING DESTINATION COUNTRY", text, re.DOTALL)
if m:
    print("JOB logic found")
else:
    print("JOB logic not found")

m = re.search(r"        elif state == self\.STATE_AWAITING_COUNTRY:(.*?)        # ── AWAITING JOB SELECTION", text, re.DOTALL)
if m:
    print("COUNTRY logic found")
else:
    print("COUNTRY logic not found")

m = re.search(r"        elif state == self\.STATE_AWAITING_EXPERIENCE:(.*?)        # ── COLLECTING SPECIFIC JOB REQUIREMENTS", text, re.DOTALL)
if m:
    print("EXPERIENCE logic found")
else:
    print("EXPERIENCE logic not found")
