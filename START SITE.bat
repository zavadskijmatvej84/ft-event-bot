@echo off
setlocal
cd /d "%~dp0telegram-app"
title Funtime Event Site

set "SITE_PORT=3080"
set "SITE_URL=http://127.0.0.1:%SITE_PORT%/eventbotfuntime"
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

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$listening = Get-NetTCPConnection -LocalPort %SITE_PORT% -State Listen -ErrorAction SilentlyContinue; if (-not $listening) { Start-Process cmd.exe -ArgumentList '/c node src\\app.js 1>>server.out.log 2>>server.err.log' -WorkingDirectory '%CD%' -WindowStyle Hidden }"

echo [INFO] Waiting for site service...
timeout /t 3 /nobreak >nul

echo [INFO] Opening %SITE_URL%
start "" "%SITE_URL%"
exit /b 0
