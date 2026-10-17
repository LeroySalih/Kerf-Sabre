@echo off
rem Kerf Mercury probe launcher. Double-click to run.
rem From the portable kerf-spike folder it needs no install. From anywhere else it uses Python installed on this PC.
cd /d "%~dp0"

set "PROBE=mercury_probe.py"
if not exist "%PROBE%" if exist "..\mercury_probe.py" set "PROBE=..\mercury_probe.py"
if not exist "%PROBE%" goto nospike

if exist ".\python\python.exe" (
  ".\python\python.exe" "%PROBE%" %*
  goto finished
)

rem No bundled Python here (for example this is the source folder, not the built kerf-spike.zip).
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY where python >nul 2>nul && set "PY=python"
if not defined PY goto nopython
echo (No .\python folder found, so this is using the Python installed on this PC.)
%PY% "%PROBE%" %*
goto finished

:nospike
echo.
echo ERROR: mercury_probe.py was not found next to this file.
echo Use the built kerf-spike.zip: unzip it and run run_mercury_probe.bat from inside the kerf-spike folder.
goto end

:nopython
echo.
echo ERROR: this folder has no bundled Python (.\python\python.exe) and no Python is installed on this PC.
echo Use the built kerf-spike.zip: unzip it and run run_mercury_probe.bat from inside the kerf-spike folder.
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
