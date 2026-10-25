@echo off
rem Double-click to start Mechano Download Manager and open its window.
cd /d "%~dp0"
start "Mechano DM" node bin\mdm.js serve
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:9614/
