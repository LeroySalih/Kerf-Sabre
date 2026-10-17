"""The downloadable Cutter package. If the portable Cutter zip has been built (cutter/build_cutter.py -> cutter/build/kerf-cutter.zip, or KERF_CUTTER_ZIP)
that is what is served ("real"); otherwise it is the PRETEND Cutter (it cuts nothing). The zip never contains a token: the token is only in the command
the Admin site shows."""
from __future__ import annotations

import io
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
PRACTICE_NAME = "kerf-cutter-practice.zip"
REAL_NAME = "kerf-cutter.zip"

README = """BISAK Kerf Cutter: PRACTICE version
===================================

This is NOT the Creality Falcon Cutter. It behaves like a laser for testing (it connects to the Kerf Server, reports a camera
picture and "cuts" jobs) but it never touches a laser or a serial port. The Creality Falcon Cutter is the one that runs a real laser.

What you need: Python 3.11 or newer, then once:   python -m pip install websockets

Mac with Python from python.org: if it stops with "CERTIFICATE_VERIFY_FAILED ... unable to get local issuer
certificate", run this once (or double-click it in Finder; use your Python's version number), then try again:

   /Applications/Python\\ 3.12/Install\\ Certificates.command

Run it with the command the Admin site gave you (Cutter software page). It looks like:

   python fake_cutter.py --url http://SERVER:8000 --token ks_... --station station-1

(On Windows you can also use run_cutter.bat with the same arguments, and on Mac/Linux ./run_cutter.sh.)

--url      the address the laser PC uses to reach the Kerf Server (not "localhost" unless the server is on this PC)
--token    this laser's station token. Keep it private: anyone with it can connect as this laser.
--station  the laser's ID, e.g. station-1

Useful extras: --speed 5 (cut faster than real time), --frame-s 1 (frame faster), --marks-after-cut
(show scored calibration squares in the camera picture after the first cut). Stop it with Ctrl+C.
"""

BAT = "@echo off\r\ncd /d %~dp0\r\npython fake_cutter.py %*\r\n"
SH = "#!/usr/bin/env sh\ncd \"$(dirname \"$0\")\" || exit 1\nexec python3 fake_cutter.py \"$@\"\n"


def build_zip() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for name in ("fake_cutter.py", "fake_bed.jpg", "fake_bed_marked.jpg"):
            z.write(HERE / name, f"kerf-cutter/{name}")
        z.writestr("kerf-cutter/README.txt", README)
        z.writestr("kerf-cutter/run_cutter.bat", BAT)
        info = zipfile.ZipInfo("kerf-cutter/run_cutter.sh")
        info.external_attr = 0o755 << 16  # executable on Mac/Linux
        z.writestr(info, SH)
    return buf.getvalue()


def real_zip(settings) -> Path | None:
    """The built portable Cutter, if there is one."""
    p = settings.cutter_zip or Path(settings.shared_dir).parent / "cutter" / "build" / REAL_NAME
    return p if p.is_file() else None


def available(settings) -> dict[str, str | None]:
    """Which kinds can be offered: kind -> file name, or None when it cannot (the Creality Falcon Cutter has not been built here)."""
    return {"practice": PRACTICE_NAME, "real": REAL_NAME if real_zip(settings) is not None else None}


def file_name(kind: str) -> str:
    return REAL_NAME if kind == "real" else PRACTICE_NAME


def read(settings, name: str) -> bytes | None:
    """The bytes of the download called `name`, or None if there is no such download."""
    if name == PRACTICE_NAME:
        return build_zip()
    real = real_zip(settings) if name == REAL_NAME else None
    return real.read_bytes() if real is not None else None
