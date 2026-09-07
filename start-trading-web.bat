@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "PORT=3081"
if not "%~1"=="" set "PORT=%~1"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-trading-web.ps1" -Port %PORT%
echo.
echo Host exited with code %ERRORLEVEL%.
pause
