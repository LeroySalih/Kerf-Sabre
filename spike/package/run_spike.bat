@echo off
rem Kerf Spike launcher. Double-click to run.
rem From the portable kerf-spike folder it needs no install. From anywhere else it uses Python installed on this PC.
cd /d "%~dp0"

set "SPIKE=spike.py"
if not exist "%SPIKE%" if exist "..\spike.py" set "SPIKE=..\spike.py"
if not exist "%SPIKE%" goto nospike

if exist ".\python\python.exe" (
  ".\python\python.exe" "%SPIKE%" %*
  goto finished
)

rem No bundled Python here (for example this is the source folder, not the built kerf-spike.zip).
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY where python >nul 2>nul && set "PY=python"
if not defined PY goto nopython
%PY% -c "import serial" >nul 2>nul
if errorlevel 1 goto noserial
echo (No .\python folder found, so this is using the Python installed on this PC.)
%PY% "%SPIKE%" %*
goto finished

:nospike
echo.
echo ERROR: spike.py was not found next to this file.
echo Use the built kerf-spike.zip: unzip it and run run_spike.bat from inside the kerf-spike folder.
goto end

:nopython
echo.
echo ERROR: this folder has no bundled Python (.\python\python.exe) and no Python is installed on this PC.
echo Use the built kerf-spike.zip: unzip it and run run_spike.bat from inside the kerf-spike folder.
goto end

:noserial
echo.
echo ERROR: Python is installed but the "pyserial" package is missing.
echo Either use the built kerf-spike.zip (nothing to install), or run once:   py -3 -m pip install pyserial
goto end

:finished
echo.
echo ============================================================
echo  Finished. Results are in the "output" folder next to this file.
echo  Send the .zip file in that folder back (it holds every log).
echo ============================================================

:end
echo  Press any key to close this window.
pause >nul
