@echo off
rem Start the Kerf Sabre Server, Editor and laser connector on this PC (Windows). See: start.bat --help
cd /d "%~dp0"
where py >nul 2>nul && (py -3 start.py %* & goto :end)
where python >nul 2>nul && (python start.py %* & goto :end)
echo Python 3.11 or newer is needed. Install it from https://www.python.org/downloads/ and run this again.
:end
