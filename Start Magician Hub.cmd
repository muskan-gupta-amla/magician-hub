@echo off
setlocal
title Magician Hub
rem Magician Hub one-click starter: downloads or updates the hub, then starts it.
rem Share this file; teammates double-click it. Needs Node.js 18+ and Git (uses their own Git login).
rem Settings for IT or testing: MAGICIAN_HUB_REPO, MAGICIAN_HUB_HOME, MAGICIAN_HUB_STARTUP, MAGICIAN_HUB_AUTOSTART=Y/N.

if not defined MAGICIAN_HUB_REPO set "MAGICIAN_HUB_REPO=https://github.com/muskan-gupta-amla/magician-hub.git"
if not defined MAGICIAN_HUB_HOME set "MAGICIAN_HUB_HOME=%LOCALAPPDATA%\MagicianHub"
if not defined MAGICIAN_HUB_STARTUP set "MAGICIAN_HUB_STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"

where node >nul 2>nul || (call :need "Node.js 18 or newer" "https://nodejs.org" & exit /b 1)
where git >nul 2>nul || (call :need "Git" "https://git-scm.com/download/win" & exit /b 1)

if exist "%MAGICIAN_HUB_HOME%\hub.js" (
  echo Updating Magician Hub...
  git -C "%MAGICIAN_HUB_HOME%" pull --ff-only --quiet || echo Could not update; starting the version you have.
) else (
  echo Downloading Magician Hub...
  git clone --quiet "%MAGICIAN_HUB_REPO%" "%MAGICIAN_HUB_HOME%" || (
    echo.
    echo Could not download Magician Hub from %MAGICIAN_HUB_REPO%
    echo Check that you can open that repo on GitHub, then double-click this file again.
    pause
    exit /b 1
  )
)

if /i not "%~1"=="/startup" if not exist "%MAGICIAN_HUB_HOME%\.asked-autostart" call :autostart
if /i "%~1"=="/startup" set "HUB_NO_OPEN=1"

where acli >nul 2>nul || echo Tip: to see your Jira tickets here, install the Atlassian CLI (acli) and run "acli jira auth login" once.
echo.
echo Magician Hub is starting at http://localhost:4545
echo Keep this window open (you can minimise it). Closing it stops the hub.
cd /d "%MAGICIAN_HUB_HOME%"
node hub.js || pause
exit /b

:need
echo.
echo Magician Hub needs %~1. Install it from %~2, then double-click this file again.
pause
exit /b

:autostart
type nul > "%MAGICIAN_HUB_HOME%\.asked-autostart"
set "ANSWER=%MAGICIAN_HUB_AUTOSTART%"
if not defined ANSWER (
  choice /C YN /M "Start Magician Hub automatically when you sign in to Windows"
  if errorlevel 2 (set "ANSWER=N") else set "ANSWER=Y"
)
if /i not "%ANSWER%"=="Y" exit /b
> "%MAGICIAN_HUB_STARTUP%\Magician Hub.cmd" echo @start "Magician Hub" /min cmd /c ""%MAGICIAN_HUB_HOME%\Start Magician Hub.cmd" /startup"
echo It will now start when you sign in. To stop that, delete "Magician Hub" from the shell:startup folder.
exit /b
