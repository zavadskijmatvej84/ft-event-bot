@echo off
setlocal
cd /d "%~dp0"
title Funtime Telegram Center

set "NPM_CONFIG_CACHE=%CD%\.npm-cache"
set "TMP=%CD%\tmp"
set "TEMP=%CD%\tmp"

if not exist "%NPM_CONFIG_CACHE%" mkdir "%NPM_CONFIG_CACHE%"
if not exist "%TMP%" mkdir "%TMP%"

if not exist "node_modules" (
  echo [INFO] Installing npm dependencies...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

echo [INFO] Starting Telegram bot and admin panel...
call node src\app.js
pause
