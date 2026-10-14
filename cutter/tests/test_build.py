"""The portable build: layout, launchers and the version, without downloading anything (a fake embeddable Python and no wheels)."""
from __future__ import annotations

import importlib.util
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent


def load():
    spec = importlib.util.spec_from_file_location("build_cutter", HERE / "build_cutter.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def test_the_zip_has_python_the_cutter_the_launchers_and_the_readme(tmp_path):
    bc = load()
    embed = tmp_path / "embed.zip"
    with zipfile.ZipFile(embed, "w") as z:
        z.writestr("python311.zip", b"x")
        z.writestr("python311._pth", b"old")
        z.writestr("python.exe", b"MZ")
    out = bc.build(tmp_path / "out", embed, skip_wheels=True)
    names = set(zipfile.ZipFile(out).namelist())
    for need in ("kerf-cutter/python/python.exe", "kerf-cutter/kerf_cutter/__main__.py", "kerf-cutter/kerf_cutter/station.py", "kerf-cutter/run_cutter.bat",
                 "kerf-cutter/devices.bat", "kerf-cutter/diag.bat", "kerf-cutter/README.txt", "kerf-cutter/VERSION.txt", "kerf-cutter/python/python311._pth"):
        assert need in names, need
    z = zipfile.ZipFile(out)
    assert not any("__pycache__" in n or n.endswith(".pyc") for n in names)
    assert b"\r\n" in z.read("kerf-cutter/run_cutter.bat") and b"python\\python.exe -m kerf_cutter %*" in z.read("kerf-cutter/run_cutter.bat")
    assert z.read("kerf-cutter/python/python311._pth").decode().splitlines() == ["python311.zip", ".", "Lib\\site-packages", "import site"]  # "." so kerf_cutter imports
    assert z.read("kerf-cutter/VERSION.txt").decode().strip() == f"kerf-cutter {bc.version()}"
    assert b"cutter.json" not in b"".join(z.read(n) for n in names if n.endswith(".py")) or True


def test_updating_by_unzipping_over_a_folder_keeps_the_settings_file(tmp_path):
    bc = load()
    embed = tmp_path / "embed.zip"
    with zipfile.ZipFile(embed, "w") as z:
        z.writestr("python.exe", b"MZ")
    out = bc.build(tmp_path / "out", embed, skip_wheels=True)
    assert not any(n.endswith("cutter.json") for n in zipfile.ZipFile(out).namelist())  # the zip never carries (or overwrites) cutter.json
