import re

with open('Chatbot/whatsapp-recruitment-bot/app/chatbot.py', 'r', encoding='utf-8') as f:
    text = f.read()

text = text.replace('\"hmm\", \"hmmm\", \"ok\", \"okay\", \"hi\", \"hello\", \"hey\", \"wtf\",', '\"ok\", \"okay\", \"hi\", \"hello\", \"hey\",')

with open('Chatbot/whatsapp-recruitment-bot/app/chatbot.py', 'w', encoding='utf-8') as f:
    f.write(text)
print("Hmm removed")
