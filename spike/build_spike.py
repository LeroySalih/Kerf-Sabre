#!/usr/bin/env python3
"""Build the portable Windows kerf-spike.zip on Linux/macOS/Windows.

Needs: pip (for downloading Windows wheels from PyPI) and the Windows embeddable
Python zip. Pass it with --embed-zip, or let the script download it from python.org.

    python3 spike/build_spike.py [--embed-zip python-3.11.9-embed-amd64.zip] [--out spike/build]
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
PYTHON_VERSION = "3.11.9"
PY_TAG = "311"
EMBED_URL = f"https://www.python.org/ftp/python/{PYTHON_VERSION}/python-{PYTHON_VERSION}-embed-amd64.zip"
# Pinned for Windows 10/11 64-bit, CPython 3.11
WHEELS = ["pyserial==3.5", "numpy==1.26.4", "opencv-python==4.9.0.80"]
PTH = f"python{PY_TAG}.zip\n.\nLib\\site-packages\nimport site\n"


def crlf(path: Path) -> bytes:
    return path.read_bytes().replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")


def get_embed_zip(arg: str | None, cache: Path) -> Path:
    if arg:
        return Path(arg)
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / Path(EMBED_URL).name
    if not target.exists():
        print(f"Downloading {EMBED_URL}")
        urllib.request.urlretrieve(EMBED_URL, target)
    return target


def download_wheels(dest: Path, no_camera: bool = False) -> list[Path]:
    wheels = [w for w in WHEELS if w.startswith("pyserial")] if no_camera else WHEELS
    dest.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [sys.executable, "-m", "pip", "download", "--no-deps", "--only-binary=:all:",
         "--platform", "win_amd64", "--python-version", "3.11", "--implementation", "cp",
         "--abi", "cp311", "--abi", "abi3", "--abi", "none", "-d", str(dest), *wheels],
        check=True)
    return sorted(w for w in dest.glob("*.whl") if not no_camera or w.name.lower().startswith("pyserial"))


def build(out: Path, embed_zip: Path, skip_wheels: bool = False, no_camera: bool = False) -> Path:
    out.mkdir(parents=True, exist_ok=True)
    stage = out / "kerf-spike"
    if stage.exists():
        import shutil
        shutil.rmtree(stage)
    py = stage / "python"
    py.mkdir(parents=True)
    with zipfile.ZipFile(embed_zip) as z:
        z.extractall(py)
    site = py / "Lib" / "site-packages"
    site.mkdir(parents=True)
    if not skip_wheels:
        for wheel in download_wheels(out / "wheels", no_camera):
            with zipfile.ZipFile(wheel) as z:
                z.extractall(site)
    for old in py.glob("python*._pth"):
        old.unlink()
    (py / f"python{PY_TAG}._pth").write_text(PTH, encoding="ascii", newline="\r\n")
    (stage / "spike.py").write_bytes((HERE / "spike.py").read_bytes())
    (stage / "run_spike.bat").write_bytes(crlf(HERE / "package" / "run_spike.bat"))
    (stage / "README.txt").write_bytes(crlf(HERE / "package" / "README.txt"))

    zip_path = out / "kerf-spike.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(stage.rglob("*")):
            if f.is_file():
                z.write(f, f.relative_to(out))
    return zip_path


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--embed-zip", help="path to python-3.11.9-embed-amd64.zip (else downloaded)")
    p.add_argument("--out", default=str(HERE / "build"))
    p.add_argument("--no-camera", action="store_true", help="leave out OpenCV (about 45 MB smaller); the camera test is then skipped")
    p.add_argument("--skip-wheels", action="store_true", help="testing only: omit pyserial/opencv")
    a = p.parse_args()
    out = Path(a.out)
    try:
        embed = get_embed_zip(a.embed_zip, out / "cache")
    except Exception as exc:  # noqa: BLE001
        print(f"Could not get the embeddable Python zip: {exc}\n"
              f"Download {EMBED_URL} manually and pass --embed-zip PATH.", file=sys.stderr)
        return 2
    print(f"Built {build(out, embed, a.skip_wheels, a.no_camera)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
