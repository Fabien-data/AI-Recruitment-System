import re

CHATBOT_PATH = r"c:\Users\Tiran's PC\Documents\GitHub\AI-Recruitment-System\Chatbot\whatsapp-recruitment-bot\app\chatbot.py"

with open(CHATBOT_PATH, "r", encoding="utf-8") as f:
    orig_content = f.read()

pattern = re.compile(r"        guided_states = \{.*?(reason=f\"out_of_bound_\{state\}\",\n            \)\n\n)", re.DOTALL)
content = pattern.sub("\n", orig_content)

with open(CHATBOT_PATH, "w", encoding="utf-8") as f:
    f.write(content)

if content == orig_content:
    print("NO CHANGES. REGEX MISMATCH")
else:
    print("Removal done!")
