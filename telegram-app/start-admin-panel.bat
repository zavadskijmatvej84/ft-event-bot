@echo off
setlocal
cd /d "%~dp0"
title Funtime Admin Panel

if not exist "node_modules" (
  echo [INFO] Installing npm dependencies...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

echo [INFO] Starting admin panel and Telegram service...
call npm start
pause
