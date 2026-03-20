import sqlite3
import json
conn = sqlite3.connect('Chatbot/whatsapp-recruitment-bot/recruitment_chatbot.db')
cursor = conn.cursor()
cursor.execute("SELECT name FROM sqlite_master WHERE type='table';")
print("Tables:", cursor.fetchall())

try:
    cursor.execute("SELECT id, candidate_id, attempts, status, last_error FROM pending_sync")
    print("Pending syncs:", cursor.fetchall())
except Exception as e:
    print("Error querying pending_sync:", e)
