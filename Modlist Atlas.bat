@echo off
rem Starts the local Modlist Atlas server and opens it in your browser.
cd /d "%~dp0"
python tools\serve.py
pause
