@echo off
title School WhatsApp Bulk Notification Portal
cd /d "%~dp0"
echo ============================================================
echo   School WhatsApp Bulk Notification Portal
echo   Opening http://localhost:3000 in 2 seconds...
echo   Keep this window open while sending notifications.
echo ============================================================
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:3000"
node server.js
pause
