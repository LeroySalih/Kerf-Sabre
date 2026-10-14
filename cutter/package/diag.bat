@echo off
rem Makes diag-<time>.zip: logs, laser settings, ports, a network test. No token, no camera pictures. Send it to whoever looks after the server.
cd /d "%~dp0"
python\python.exe -m kerf_cutter --diag
pause
