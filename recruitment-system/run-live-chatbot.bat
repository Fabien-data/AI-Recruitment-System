@echo off
echo.
echo ========================================================
echo       Starting ngrok to expose local port 3000
echo ========================================================
echo.
echo Once ngrok starts, copy the "Forwarding" HTTPS URL
echo For example: https://1234abcd.ngrok-free.app
echo.
echo Your WhatsApp Webhook URL will be:
echo https://YOUR_NGROK_URL/webhooks/whatsapp
echo.
echo Provide this full URL to your WhatsApp Business App 
echo Configuration on developers.facebook.com
echo.
echo Remember to verify with token: dewan_recruitment_webhook_2024
echo.
echo Press any key to start ngrok...
pause >nul

ngrok http 3000
pause
