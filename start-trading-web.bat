@echo off
setlocal EnableExtensions
cd /d "%~dp0"

rem Starts trading-web host on PORT, and opens dependency windows when needed:
rem   start-iquant-quote.bat   (:5810 CN quotes)
rem   start-options-gateway.bat (:8090 T-board / IV)
rem Pass through: scripts\start-trading-web.ps1 -Port N [-SkipIquant] [-SkipOptions]

set "PORT=3081"
if not "%~1"=="" set "PORT=%~1"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-trading-web.ps1" -Port %PORT%
echo.
echo Host exited with code %ERRORLEVEL%.
pause
