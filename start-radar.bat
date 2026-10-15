@echo off
setlocal
title 12306 Ticket Radar

rem ===========================================================
rem  12306 Ticket Radar - launcher
rem  Read-only availability query and alerts.
rem  Booking must be done through official 12306 channels.
rem  NOTE: keep this file pure ASCII. cmd.exe reads .bat as ANSI,
rem  so non-ASCII characters here corrupt command parsing.
rem ===========================================================

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

rem ---- 1. locate Node.js ----
rem priority: runtime\node.exe > TICKET_RADAR_NODE > common paths > PATH
set "NODE="
if exist "%ROOT%\runtime\node.exe" set "NODE=%ROOT%\runtime\node.exe"
if defined NODE goto node_ready

if defined TICKET_RADAR_NODE if exist "%TICKET_RADAR_NODE%" set "NODE=%TICKET_RADAR_NODE%"
if defined NODE goto node_ready

if exist "D:\nodejs\node.exe" set "NODE=D:\nodejs\node.exe"
if defined NODE goto node_ready

if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"
if defined NODE goto node_ready

if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE=%ProgramFiles(x86)%\nodejs\node.exe"
if defined NODE goto node_ready

if exist "%LocalAppData%\Programs\nodejs\node.exe" set "NODE=%LocalAppData%\Programs\nodejs\node.exe"
if defined NODE goto node_ready

for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE goto no_node

:node_ready
rem ---- 2. verify station table, download on first run ----
if exist "%ROOT%\data\station_name.js" goto launch

echo.
echo   First run: downloading station table...
"%NODE%" "%ROOT%\tools\fetch_stations.js"
if errorlevel 1 goto no_stations

:launch
echo.
echo   Starting 12306 Ticket Radar...
echo   Close this window to quit.
echo.
"%NODE%" "%ROOT%\src\server.js"
echo.
echo   Exited.
pause
exit /b 0

:no_node
echo.
echo   [x] Node.js not found.
echo.
echo   This program needs Node.js 18 or newer. Either:
echo     1) Install the LTS build from https://nodejs.org
echo     2) Put node.exe into:  %ROOT%\runtime\
echo.
pause
exit /b 1

:no_stations
echo   [x] Failed to download the station table. Check your network and retry.
pause
exit /b 1
