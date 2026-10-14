"""The downloadable Cutter package. If the portable Cutter zip has been built (cutter/build_cutter.py -> cutter/build/kerf-cutter.zip, or KERF_CUTTER_ZIP)
that is what is served ("real"); otherwise it is the PRETEND Cutter (it cuts nothing). The zip never contains a token: the token is only in the command
the Admin site shows."""
from __future__ import annotations

import io
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
PRETEND_NAME = "kerf-cutter-pretend.zip"
REAL_NAME = "kerf-cutter.zip"

README = """BISAK Kerf Cutter: PRETEND version
==================================

This is NOT the real Cutter. It behaves like a laser for testing (it connects to the Kerf Server, reports a camera
picture and "cuts" jobs) but it never touches a laser or a serial port. The real Cutter is not finished yet.

What you need: Python 3.11 or newer, then once:   python -m pip install websockets

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


def choose(settings) -> tuple[str, str, bytes]:
    """(kind, file name, bytes) of what to offer for download."""
    real = real_zip(settings)
    if real is not None:
        return "real", REAL_NAME, real.read_bytes()
    return "pretend", PRETEND_NAME, build_zip()


def kind_of(settings) -> tuple[str, str]:
    """(kind, file name) without reading the file."""
    return ("real", REAL_NAME) if real_zip(settings) is not None else ("pretend", PRETEND_NAME)
