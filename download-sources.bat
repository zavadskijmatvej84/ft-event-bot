@echo off
setlocal
cd /d "%~dp0"
title Funtime Event Bot Sources

set "GRADLE_USER_HOME=%~dp0.gradle-user-home"
set "TMP=%~dp0tmp"
set "TEMP=%~dp0tmp"

if not exist "%GRADLE_USER_HOME%" mkdir "%GRADLE_USER_HOME%"
if not exist "%TMP%" mkdir "%TMP%"

echo [INFO] Downloading Minecraft/Fabric sources for 1.21.8...
call gradlew.bat genSources
if errorlevel 1 (
  echo [ERROR] genSources failed.
  pause
  exit /b 1
)

echo [INFO] Sources are ready for the IDE.
pause
