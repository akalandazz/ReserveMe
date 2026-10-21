@echo off
rem Preview buttons in the cabinet bot - a wrapper around setup-admin-bot.mjs.
rem Asks for the bot token, your Telegram id and the Vercel bypass secret; stores nothing.
rem (ASCII only above chcp: cmd reads this file in the OEM code page.)
rem   scripts\setup-admin-bot.cmd          - set the buttons
rem   scripts\setup-admin-bot.cmd --reset  - restore the default menu button
chcp 65001 >nul
setlocal

if not defined TELEGRAM_CABINET_BOT_TOKEN set /p TELEGRAM_CABINET_BOT_TOKEN=Cabinet bot token:
if not defined PREVIEW_CHAT_ID set /p PREVIEW_CHAT_ID=Your Telegram id:
if /i not "%~1"=="--reset" if not defined VERCEL_BYPASS_SECRET set /p VERCEL_BYPASS_SECRET=Vercel bypass secret:

node "%~dp0setup-admin-bot.mjs" %*
set CODE=%ERRORLEVEL%
pause
endlocal & exit /b %CODE%
