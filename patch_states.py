import re

with open('Chatbot/whatsapp-recruitment-bot/app/chatbot.py', 'r', encoding='utf-8') as f:
    text = f.read()

# I will replace the agentic message logic and retries with the global takeover
pattern = re.compile(
    r'(if not validation\.get\(\'is_valid\'\):.*?)(?=\n\s+extracted_.*?= validation)',
    re.DOTALL
)
def replacer(m):
    return """if not validation.get('is_valid'):
                return await rag_engine.generate_global_takeover(
                    user_message=text, 
                    current_state=state
                )"""

new_text = pattern.sub(replacer, text)
with open('Chatbot/whatsapp-recruitment-bot/app/chatbot.py', 'w', encoding='utf-8') as f:
    f.write(new_text)

print("Done")
