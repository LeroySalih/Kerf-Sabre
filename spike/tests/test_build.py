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
            "kerf-spike/python/python.exe", "kerf-spike/python/python311._pth",
            "kerf-spike/mercury_probe.py", "kerf-spike/run_mercury_probe.bat", "kerf-spike/README_MERCURY.txt"} <= names
    z = zipfile.ZipFile(zip_path)
    pth = z.read("kerf-spike/python/python311._pth").decode()
    assert "Lib\\site-packages" in pth and "\nimport site" in pth.replace("\r", "")
    assert b"\r\n" in z.read("kerf-spike/run_spike.bat")
    assert "python\\python.exe" in z.read("kerf-spike/run_spike.bat").decode()


def test_launcher_explains_itself_and_falls_back_to_installed_python():
    bat = (Path(__file__).resolve().parents[1] / "package" / "run_spike.bat").read_text()
    assert r".\python\python.exe" in bat                  # the portable zip's bundled Python comes first
    assert "py -3" in bat and "import serial" in bat       # otherwise the PC's own Python, if it has pyserial
    assert r"..\spike.py" in bat                           # works from the source folder too
    for message in (":nospike", ":nopython", ":noserial"):  # and says what to do instead of a bare 'path not found'
        assert message in bat


def test_the_mercury_launcher_runs_its_own_script_with_the_bundled_python():
    bat = (Path(__file__).resolve().parents[1] / "package" / "run_mercury_probe.bat").read_text()
    assert r".\python\python.exe" in bat and "mercury_probe.py" in bat and "run_spike" not in bat.replace("kerf-spike", "")
    assert "import serial" not in bat  # the probe does not need pyserial
