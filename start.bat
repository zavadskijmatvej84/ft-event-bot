@echo off
setlocal
cd /d "%~dp0"
title Funtime Event Bot 1.21.8

set "GRADLE_USER_HOME=%~dp0.gradle-user-home"
set "TMP=%~dp0tmp"
set "TEMP=%~dp0tmp"

if not exist "%GRADLE_USER_HOME%" mkdir "%GRADLE_USER_HOME%"
if not exist "%TMP%" mkdir "%TMP%"

echo [INFO] Starting Minecraft 1.21.8 Fabric dev client...
call gradlew.bat runClient
if errorlevel 1 (
  echo [ERROR] runClient failed.
  pause
  exit /b 1
)
