import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build_spike  # noqa: E402


def test_build_layout(tmp_path):
    fake = tmp_path / "embed.zip"
    with zipfile.ZipFile(fake, "w") as z:
        z.writestr("python.exe", "x")
        z.writestr("python311._pth", "python311.zip\n.\n#import site\n")
    out = tmp_path / "build"
    zip_path = build_spike.build(out, fake, skip_wheels=True)
    names = set(zipfile.ZipFile(zip_path).namelist())
    assert {"kerf-spike/spike.py", "kerf-spike/run_spike.bat", "kerf-spike/README.txt",
            "kerf-spike/python/python.exe", "kerf-spike/python/python311._pth"} <= names
    z = zipfile.ZipFile(zip_path)
    pth = z.read("kerf-spike/python/python311._pth").decode()
    assert "Lib\\site-packages" in pth and "\nimport site" in pth.replace("\r", "")
    assert b"\r\n" in z.read("kerf-spike/run_spike.bat")
    assert "python\\python.exe" in z.read("kerf-spike/run_spike.bat").decode()
