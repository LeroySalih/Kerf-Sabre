@echo off
rem BISAK Kerf Cutter. Double-click, or run from a Command Prompt with the arguments the Admin site gave you.
cd /d "%~dp0"
python\python.exe -m kerf_cutter %*
if errorlevel 1 (
  echo.
  echo The Cutter stopped. Read the message above, or run diag.bat and send the zip it makes.
  pause
)
