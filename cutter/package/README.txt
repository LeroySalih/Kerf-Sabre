BISAK Kerf Cutter
=================

The program that runs on a laser PC. It talks to the laser over USB, watches the camera, and connects OUT to the Kerf Server (it listens on nothing).
Nothing is installed: delete this folder and it is gone.

FIRST TIME
  1. Unzip this folder anywhere (Desktop is fine). Close LightBurn, LaserGRBL and any Creality software: only one program can hold the laser's USB port.
  2. Open Command Prompt in this folder and run the command the Admin site showed you (Cutter software page):

        run_cutter.bat --url http://SERVER:8000 --token ks_... --station station-1

     The address, token and station are saved in cutter.json next to this file, so from then on you just double-click run_cutter.bat.
  3. Open the Editor in a browser on this PC and sign in with the same token: the Station page appears.

FILES
  run_cutter.bat   start the Cutter (Ctrl+C stops it; a cut in progress is held and reset first)
  devices.bat      list serial ports, find the laser, remember it (devices.bat --assign COM5 to choose by hand)
  diag.bat         make a diagnostic zip to send for help (no token, no camera pictures)
  cutter.json      your settings (kept when you update)
  logs\            what the Cutter did, one JSON line per event

UPDATING: unzip the new version over this folder. cutter.json and logs\ are kept.

IF SOMETHING IS WRONG
  "No laser found"    unplug and replug the USB cable; close other laser programs; run devices.bat.
  Another program holds the port: LightBurn, LaserGRBL or Creality software is open.
  Cannot reach the server: check the --url; the PC must be able to reach it (ask the school IT if a filter blocks it).
  After any stop the laser homes itself again (it moves to its home corner) before the next job.
