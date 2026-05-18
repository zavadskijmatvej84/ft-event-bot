@echo off
setlocal
cd /d "%~dp0"
title Funtime Event Bot Build

set "GRADLE_USER_HOME=%~dp0.gradle-user-home"
set "TMP=%~dp0tmp"
set "TEMP=%~dp0tmp"

if not exist "%GRADLE_USER_HOME%" mkdir "%GRADLE_USER_HOME%"
if not exist "%TMP%" mkdir "%TMP%"

echo [INFO] Building mod jar...
call gradlew.bat build
if errorlevel 1 (
  echo [ERROR] Build failed.
  pause
  exit /b 1
)

echo [INFO] Done. Check build\libs
pause
