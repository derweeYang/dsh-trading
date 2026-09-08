@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "PORT=8090"
if not "%~1"=="" set "PORT=%~1"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-options-gateway.ps1" -Port %PORT%
echo.
echo Options gateway exited with code %ERRORLEVEL%.
pause
