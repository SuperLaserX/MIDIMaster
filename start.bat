@echo off
rem Starts the MIDIMaster local server and opens it in the default browser.
rem Web MIDI needs Chrome or Edge.
cd /d "%~dp0"
where node >nul 2>nul
if %errorlevel%==0 (
  start "" http://localhost:8020/
  node serve.js 8020
) else (
  echo Node.js not found, trying Python...
  start "" http://localhost:8020/
  python -m http.server 8020 --bind 127.0.0.1
)
