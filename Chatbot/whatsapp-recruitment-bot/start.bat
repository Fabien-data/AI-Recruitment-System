@echo off
:: Start the Dewan WhatsApp Recruitment Chatbot (Python FastAPI)
:: Run this from the whatsapp-recruitment-bot directory.
cd /d "%~dp0"

:: Check .env exists
if not exist ".env" (
    echo ERROR: .env file not found. Copy .env.example to .env and fill in your values.
    pause
    exit /b 1
)

:: Initialize the database tables (safe to run multiple times)
echo Initializing database...
python scripts/init_db.py

:: Start the server
echo.
echo Starting Python chatbot on port 8000...
echo Webhook URL to register with Meta: http://YOUR_SERVER:8000/webhook/whatsapp
echo Verify token: dewan_recruitment_webhook_2024
echo.
python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 2
