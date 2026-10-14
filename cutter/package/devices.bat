@echo off
rem Lists the serial ports, finds the laser and remembers it. Use: devices.bat --assign COM5 to choose by hand.
cd /d "%~dp0"
python\python.exe -m kerf_cutter --devices %*
pause
