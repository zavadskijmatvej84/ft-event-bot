@echo off
setlocal
cd /d "%~dp0telegram-app"
title Funtime Public Event Site

set "SITE_PORT=3080"
set "PUBLIC_SUBDOMAIN=eventbotfuntime"
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

echo [INFO] Waiting for local site service...
timeout /t 3 /nobreak >nul

echo [INFO] Starting public tunnel...
set "PUBLIC_SITE_PORT=%SITE_PORT%"
set "PUBLIC_SITE_SUBDOMAIN=%PUBLIC_SUBDOMAIN%"
call node src\public-tunnel.js

pause
