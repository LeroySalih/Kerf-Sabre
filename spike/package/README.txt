KERF SPIKE - laser connection test
===================================
This small program checks that this PC can talk to the laser cutter.
It needs NO installation and NO administrator rights. To remove it,
just delete this folder.

BEFORE YOU START
  1. Plug the laser's USB cable into this PC and switch the laser on.
  2. CLOSE LightBurn, LaserGRBL and any Creality software
     (only one program can use the laser at a time).
  3. Put a spare bit of scrap material on the bed, or leave the bed clear.
     The test moves the laser head about 10-30 mm and homes it.
  4. Stay at the machine for the whole test. Keep the stop button in reach.

RUN IT
  (Use the built kerf-spike.zip: unzip it, then run run_spike.bat from INSIDE the
   kerf-spike folder. Running it from the source code folder will not work
   unless Python and pyserial are installed on the PC.)
  1. Double-click  run_spike.bat
  2. Choose  a  (auto test) when asked.
  3. Type the station name, e.g.  station1
  4. Type the server address if you were given one, or press Enter to skip.
  5. Answer y or n when it asks about the air assist (listen for the fan).
  6. Wait for "Done". Note the line "Send this ONE file back" - it names a
     .zip file in the "output" folder. Email or share that one file.
     Press any key to close.

The laser is NOT fired during the normal test.

IF SOMETHING GOES WRONG
  - Even if the test stops early, crashes or hangs, send the .zip (or the whole
    "output" folder). Everything that happened is recorded in it:
      session.log   one timeline: what was sent to the laser, what it answered,
                    what the screen showed and what you typed, with times
      report.txt    pass / fail for each test
      env.txt       the PC, Python, serial driver and USB devices
  - Windows says the file is blocked, or nothing opens: the school may block
    programs in this folder. Tell IT to allow this folder.
  - "No serial ports found": the CH340 USB driver may be missing. Tell Mr Salih.
  - Press Ctrl+C at any time to stop. The laser is told to stop immediately.

SEND THE RESULTS BACK
  After the test there is a folder inside "output" named like
  station1_20260101-093000. Copy that whole folder to a USB stick
  (or zip it) and give it to Mr Salih. Do not edit the files.

Console mode (advanced): run_spike.bat --mode console
