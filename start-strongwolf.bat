@echo off
cd /d "%~dp0"
start "Strongwolf Server" cmd /k "cd /d %~dp0 && python -m http.server 4173 --bind 127.0.0.1"
timeout /t 3 > nul
start "" http://127.0.0.1:4173/index.html
