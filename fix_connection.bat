@echo off
echo Stopping any running Node.js processes...
taskkill /F /IM node.exe /T 2>nul
taskkill /F /IM chrome.exe /T 2>nul

echo.
echo Cleaning up old WhatsApp session data...
rmdir /s /q .wwebjs_auth 2>nul
rmdir /s /q .wwebjs_cache 2>nul
del /q session.json 2>nul

echo.
echo ===================================================
echo   FIX COMPLETE!
echo ===================================================
