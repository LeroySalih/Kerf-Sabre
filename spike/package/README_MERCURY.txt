KERF MERCURY PROBE - how is this laser connected?
=================================================
For the GCC Mercury III (station 5), which is run from Techsoft 2D Design.

This test only LOOKS. It does NOT send anything to the laser, does NOT move it
and does NOT fire it. It asks Windows what is plugged in and installed, and
asks you to unplug and replug the laser's USB cable so we can tell which
device is the laser. It needs NO installation and NO administrator rights.

BEFORE YOU START
  1. Switch the laser ON and plug its USB cable into the PC (as you normally do).
  2. CLOSE 2D Design and any other laser software.
  3. Stay at the machine. Nothing will move.

RUN IT
  1. Unzip kerf-spike.zip, open the kerf-spike folder, double-click
     run_mercury_probe.bat
  2. Type the station name, e.g.  station5
  3. Follow the prompts: it asks you to unplug the USB cable (the end in the
     PC), wait, then plug it back into the SAME socket. Then it asks a few
     questions about how you use the laser. "don't know" is a fine answer.
  4. Note the line "Send this ONE file back": it names a .zip in the "output"
     folder. Share that one file. Press any key to close.

TWO EXTRA THINGS THAT HELP (no need to type anything)
  - Take a photo of the machine's label (model and laser power) and of the
    controller's display/panel.
  - Open 2D Design, go to the dialog you use to send a job to the laser, and
    take a screenshot of it (including any device/port/printer name).

WHAT IS COLLECTED
  USB devices, COM ports, printers and printer drivers, installed software
  names (no documents), running laser-related programs, network adapters, the
  file NAMES in laser-software folders, and small settings files (.ini .cfg
  .xml .json .txt, under 100 KB) from those folders. No documents, no
  screenshots, no camera, no names of pupils.

IF SOMETHING GOES WRONG
  Even if it stops early, send the .zip (or the whole "output" folder).
  session.log has the full timeline, report.txt a summary and probe.json
  all the details. Press Ctrl+C at any time to stop.
