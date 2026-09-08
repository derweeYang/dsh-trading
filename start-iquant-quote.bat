@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "PORT=5810"
if not "%~1"=="" set "PORT=%~1"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-iquant-quote.ps1" -Port %PORT%
echo.
echo iQuant quote gateway exited with code %ERRORLEVEL%.
pause
