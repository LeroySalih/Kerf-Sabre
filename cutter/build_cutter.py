#!/usr/bin/env python3
"""Build the portable Windows kerf-cutter.zip (embeddable Python + bundled packages + the Cutter + .bat files). Runs on Windows, macOS or Linux.

    python3 cutter/build_cutter.py [--embed-zip python-3.11.9-embed-amd64.zip] [--out cutter/build] [--no-camera]

Needs internet once: pip downloads the Windows wheels, and python.org provides the embeddable Python (or pass --embed-zip). The result is
cutter/build/kerf-cutter.zip; the Server's Cutter download page serves it automatically when it exists (or set KERF_CUTTER_ZIP).
Camera support (numpy + OpenCV, about 45 MB) can be left out with --no-camera; the laser then works without a camera picture."""
from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
PYTHON_VERSION, PY_TAG = "3.11.9", "311"
EMBED_URL = f"https://www.python.org/ftp/python/{PYTHON_VERSION}/python-{PYTHON_VERSION}-embed-amd64.zip"
BASE = ["pyserial==3.5", "websockets==15.0.1"]
CAMERA = ["numpy==1.26.4", "opencv-python-headless==4.9.0.80"]
# Paths in a ._pth file are relative to the file, i.e. to the python\ folder. ".." is the kerf-cutter folder, where the kerf_cutter package lives:
# without it `python -m kerf_cutter` is "No module named kerf_cutter" (a ._pth install adds neither the current folder nor the script folder for -m).
PTH = f"python{PY_TAG}.zip\n.\n..\nLib\\site-packages\nimport site\n"


def version() -> str:
    return re.search(r'__version__ = "([^"]+)"', (HERE / "kerf_cutter" / "__init__.py").read_text()).group(1)


def crlf(data: bytes) -> bytes:
    return data.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")


def get_embed_zip(arg: str | None, cache: Path) -> Path:
    if arg:
        return Path(arg)
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / Path(EMBED_URL).name
    if not target.exists():
        print(f"Downloading {EMBED_URL}")
        urllib.request.urlretrieve(EMBED_URL, target)
    return target


def download_wheels(dest: Path, camera: bool) -> list[Path]:
    dest.mkdir(parents=True, exist_ok=True)
    subprocess.run([sys.executable, "-m", "pip", "download", "--no-deps", "--only-binary=:all:", "--platform", "win_amd64", "--python-version", "3.11", "--implementation", "cp",
                    "--abi", "cp311", "--abi", "abi3", "--abi", "none", "-d", str(dest), *BASE, *(CAMERA if camera else [])], check=True)
    return sorted(dest.glob("*.whl"))


def build(out: Path, embed_zip: Path, camera: bool = True, skip_wheels: bool = False) -> Path:
    stage = out / "kerf-cutter"
    if stage.exists():
        shutil.rmtree(stage)
    py = stage / "python"
    py.mkdir(parents=True)
    with zipfile.ZipFile(embed_zip) as z:
        z.extractall(py)
    site = py / "Lib" / "site-packages"
    site.mkdir(parents=True)
    if not skip_wheels:
        for wheel in download_wheels(out / "wheels", camera):
            with zipfile.ZipFile(wheel) as z:
                z.extractall(site)
    for old in py.glob("python*._pth"):
        old.unlink()
    (py / f"python{PY_TAG}._pth").write_text(PTH, encoding="ascii", newline="\r\n")
    shutil.copytree(HERE / "kerf_cutter", stage / "kerf_cutter", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    for name in ("run_cutter.bat", "devices.bat", "diag.bat", "README.txt"):
        (stage / name).write_bytes(crlf((HERE / "package" / name).read_bytes()))
    (stage / "VERSION.txt").write_text(f"kerf-cutter {version()}\n", encoding="ascii")
    zip_path = out / "kerf-cutter.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(stage.rglob("*")):
            if f.is_file():
                z.write(f, f.relative_to(out))
    return zip_path


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--embed-zip", help="path to python-3.11.9-embed-amd64.zip (else downloaded)")
    p.add_argument("--out", default=str(HERE / "build"))
    p.add_argument("--no-camera", action="store_true", help="leave out numpy and OpenCV (about 45 MB smaller); the laser works, there is no camera picture")
    p.add_argument("--skip-wheels", action="store_true", help="testing only: leave out all third-party packages")
    a = p.parse_args()
    out = Path(a.out)
    try:
        embed = get_embed_zip(a.embed_zip, out / "cache")
    except Exception as exc:  # noqa: BLE001
        print(f"Could not get the embeddable Python zip: {exc}\nDownload {EMBED_URL} and pass --embed-zip PATH.", file=sys.stderr)
        return 2
    z = build(out, embed, not a.no_camera, a.skip_wheels)
    print(f"Built {z} ({z.stat().st_size // (1024 * 1024)} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
