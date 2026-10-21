@echo off
rem Preview buttons in the cabinet bot - a wrapper around setup-admin-bot.mjs.
rem Asks for the bot token, your Telegram id and the Vercel bypass secret; stores nothing.
rem (ASCII only above chcp: cmd reads this file in the OEM code page.)
rem The menu button is left alone: it keeps opening the production cabinet.
rem   scripts\setup-admin-bot.cmd          - send + pin the preview buttons message
rem   scripts\setup-admin-bot.cmd --reset  - restore the production menu button in your chat
chcp 65001 >nul
setlocal

if not defined TELEGRAM_CABINET_BOT_TOKEN set /p TELEGRAM_CABINET_BOT_TOKEN=Cabinet bot token:
if not defined PREVIEW_CHAT_ID set /p PREVIEW_CHAT_ID=Your Telegram id:
if /i not "%~1"=="--reset" if not defined VERCEL_BYPASS_SECRET set /p VERCEL_BYPASS_SECRET=Vercel bypass secret:

node "%~dp0setup-admin-bot.mjs" %*
set CODE=%ERRORLEVEL%
pause
endlocal & exit /b %CODE%
