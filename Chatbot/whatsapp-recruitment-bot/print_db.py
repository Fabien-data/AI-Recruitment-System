import sqlite3
db = sqlite3.connect('recruitment_chatbot.db')
c = db.cursor()
c.execute("SELECT c.phone_number, m.message_type, m.message_text FROM conversations m JOIN candidates c ON m.candidate_id = c.id WHERE c.phone_number = '+94771234567' ORDER BY m.timestamp DESC LIMIT 20")
with open('db_out.txt', 'w', encoding='utf-8') as f:
    for row in c.fetchall():
        f.write(f"[{row[1]}] {row[2]}\n")
db.close()
