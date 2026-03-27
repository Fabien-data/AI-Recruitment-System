import re

with open('Chatbot/whatsapp-recruitment-bot/app/chatbot.py', 'r', encoding='utf-8') as f:
    text = f.read()

text = re.sub(
    r'agentic_msg = await rag_engine\.generate_agentic_response\(\s*user_message=text,\s*current_goal=.*?\n\s*\)',
    """takeover_reply = await rag_engine.generate_global_takeover(
                    user_message=text,
                    current_state=state
                )""",
    text,
    flags=re.MULTILINE|re.DOTALL
)

# And change return agentic_msg to return takeover_reply
text = text.replace('return agentic_msg', 'return takeover_reply')
text = text.replace('agentic_msg', 'takeover_reply')

with open('Chatbot/whatsapp-recruitment-bot/app/chatbot.py', 'w', encoding='utf-8') as f:
    f.write(text)
print("Done")
