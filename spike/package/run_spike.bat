@echo off
rem Kerf Spike launcher. Double-click to run. No install needed.
cd /d "%~dp0"
".\python\python.exe" spike.py %*
echo.
echo ============================================================
echo  Finished. Results are in the "output" folder next to this file.
echo  Press any key to close this window.
echo ============================================================
pause >nul
