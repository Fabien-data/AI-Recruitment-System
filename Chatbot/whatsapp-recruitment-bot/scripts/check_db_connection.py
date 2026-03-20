import sys
import os
import traceback
import pymysql
import pymysql
import urllib.parse
# Removed app.config dependency to run standalone

# Override settings from .env with manual check to be absolutely sure
# We read the raw .env file to get the exact password without any frameworks intervening
from dotenv import load_dotenv
load_dotenv()

log_file = "db_connection_log.txt"

def log(message):
    print(message)
    with open(log_file, "a", encoding="utf-8") as f:
        f.write(message + "\n")

with open(log_file, "w", encoding="utf-8") as f:
    f.write("Starting Direct PyMySQL Check...\n")

try:
    # Get raw values
    host = os.getenv("DB_HOST", "mysql.us.stackcp.com")
    port = int(os.getenv("DB_PORT", 39358))
    user = os.getenv("DB_USER", "recruitment_bot-35313030d237")
    password = os.getenv("DB_PASSWORD", "Master@123")
    database = os.getenv("DB_NAME", "recruitment_bot-35313030d237")

    log(f"Connecting to {host}:{port}")
    log(f"User: {user}")
    log(f"Database: {database}")
    log(f"Password: {password[:2]}******{password[-2:]} (Length: {len(password)})")
    
    # Connect directly
    connection = pymysql.connect(
        host=host,
        user=user,
        password=password,
        database=database,
        port=port,
        cursorclass=pymysql.cursors.DictCursor,
        connect_timeout=10
    )
    
    log("SUCCESS: Connected via pymysql directly!")
    
    with connection.cursor() as cursor:
        cursor.execute("SELECT 1")
        result = cursor.fetchone()
        log(f"Test Query Result: {result}")
        
    connection.close()

except Exception as e:
    log("\n--- DIRECT CONNECTION FAILED ---")
    log(f"Error Type: {type(e).__name__}")
    log(f"Error Message: {str(e)}")
    log(traceback.format_exc())
