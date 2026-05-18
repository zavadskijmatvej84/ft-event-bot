@echo off
setlocal
cd /d "%~dp0"
title Funtime Event Bot Install

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

for /f "usebackq delims=" %%F in (`powershell -NoProfile -Command "Get-ChildItem 'build/libs/*.jar' | Where-Object { $_.Name -notmatch 'sources|dev|javadoc' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName"`) do set "MOD_JAR=%%F"

if not defined MOD_JAR (
  echo [ERROR] Built mod jar was not found.
  pause
  exit /b 1
)

set /p "MODS_DIR=Enter full path to your .minecraft\mods folder: "
if "%MODS_DIR%"=="" (
  echo [ERROR] Path is empty.
  pause
  exit /b 1
)

if not exist "%MODS_DIR%" (
  echo [ERROR] Target folder does not exist:
  echo %MODS_DIR%
  pause
  exit /b 1
)

copy /Y "%MOD_JAR%" "%MODS_DIR%\" >nul
if errorlevel 1 (
  echo [ERROR] Failed to copy the mod jar.
  pause
  exit /b 1
)

echo [INFO] Installed:
echo [INFO] %MOD_JAR%
echo [INFO] into
echo [INFO] %MODS_DIR%
pause
