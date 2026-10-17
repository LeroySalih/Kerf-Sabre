import json
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import mercury_probe as mp  # noqa: E402

LASER = {"Name": "USB Device", "PNPDeviceID": "USB\\VID_1A86&PID_5512\\5&1", "Service": "RdUsb", "ConfigManagerErrorCode": 0}
MOUSE = {"Name": "USB Input Device", "PNPDeviceID": "USB\\VID_046D&PID_C077\\6&2", "Service": "HidUsb", "ConfigManagerErrorCode": 0}
HUB = {"Name": "USB Root Hub", "PNPDeviceID": "USB\\ROOT_HUB30\\4&1", "Service": "USBHUB3", "ConfigManagerErrorCode": 0}


class Fake:
    """Pretends to be Windows: the laser's USB device exists until `unplugged` is set."""

    def __init__(self):
        self.unplugged = False
        self.commands = []

    def run(self, cmd, timeout=30.0):
        self.commands.append(cmd)
        text = " ".join(cmd)
        if "Win32_PnPEntity" in text:
            return json.dumps([MOUSE, HUB] if self.unplugged else [MOUSE, HUB, LASER])
        if "Win32_PrinterDriver" in text:
            return json.dumps({"Name": "GCC LaserPro Mercury III", "SupportedPlatform": "Windows x64"})
        if "Win32_Printer" in text:
            return json.dumps([{"Name": "GCC Mercury III", "DriverName": "GCC LaserPro Mercury III", "PortName": "USB001"}, {"Name": "Office", "DriverName": "HP", "PortName": "IP_1"}])
        if "Uninstall" in text:
            return json.dumps([{"DisplayName": "2D Design V2", "Publisher": "Techsoft", "InstallLocation": ""}, {"DisplayName": "Chrome", "Publisher": "Google"}])
        if "Get-Process" in text:
            return json.dumps([{"ProcessName": "2DDesign", "Id": 4, "Path": "C:\\x\\2DDesign.exe"}, {"ProcessName": "explorer", "Id": 5, "Path": "C:\\Windows\\explorer.exe"}])
        if "Win32_Service" in text:
            return json.dumps([{"Name": "Spooler", "DisplayName": "Print Spooler", "State": "Running", "PathName": "spoolsv.exe"}])
        if cmd[0] == "ipconfig":
            return "Ethernet adapter: media disconnected"
        return ""


def run_probe(tmp_path, fake, answers):
    answers = iter(answers)
    shown = []

    def prompt(q):
        if "UNPLUG" in "".join(shown[-3:]).upper() and "Unplugged" in q:
            fake.unplugged = True
        if "Plugged back" in q:
            fake.unplugged = False
        return next(answers)

    say = shown.append
    rc = mp.main(["--station", "station5", "--out", str(tmp_path)], run=fake.run, list_ports=lambda: [], prompt=prompt, say=say, sleep=lambda s: None, windows=True)
    return rc, shown


def test_a_full_run_finds_the_laser_and_writes_everything(tmp_path):
    fake = Fake()
    rc, shown = run_probe(tmp_path, fake, ["", "", "", "Mercury III 60W", "Ruida", "File > Laser output", "GCC Mercury III on USB001", "press start", "no", "no, switch", ""])
    assert rc == 0
    out = next(tmp_path.glob("station5_mercury_*/"))
    for name in ("session.log", "probe.json", "report.txt", "env.txt", "installed_software.txt"):
        assert (out / name).is_file(), name
    data = json.loads((out / "probe.json").read_text())["data"]
    assert [d["Name"] for d in data["unplug_test"]["usb_gone"]] == ["USB Device"]  # the laser is what went away
    assert data["laser_related_software"][0]["DisplayName"] == "2D Design V2"
    assert [p["ProcessName"] for p in data["running_processes"]] == ["2DDesign"]
    assert data["operator_answers"]["controller"] == "Ruida"
    report = (out / "report.txt").read_text()
    assert "vendor driver 'rdusb'" in report and "Printer entry" not in report and "laser-related (GCC Mercury III" in report
    assert "Nothing was sent to the laser" in report
    assert list(tmp_path.glob("station5_mercury_*.zip"))
    assert any("Send this ONE file" in s for s in shown)


def test_nothing_is_ever_sent_to_the_laser(tmp_path):
    fake = Fake()
    run_probe(tmp_path, fake, [""] * 3 + ["x"] * 8)
    # only Windows information commands are run: PowerShell queries and ipconfig
    assert {c[0] for c in fake.commands} <= {"powershell", "ipconfig"}
    src = (Path(mp.__file__)).read_text()
    assert "serial.Serial" not in src and ".write(b" not in src and "Serial(" not in src


def test_a_failing_step_does_not_stop_the_others(tmp_path):
    fake = Fake()
    real = fake.run

    def broken(cmd, timeout=30.0):
        if "Win32_Printer" in " ".join(cmd):
            raise TimeoutError("powershell hung")
        return real(cmd, timeout)

    answers = iter([""] * 3 + ["x"] * 8)
    mp.main(["--station", "s", "--out", str(tmp_path)], run=broken, list_ports=lambda: [], prompt=lambda q: next(answers), say=lambda s: None, sleep=lambda s: None, windows=True)
    out = next(tmp_path.glob("s_mercury_*/"))
    steps = {s["step"]: s for s in json.loads((out / "probe.json").read_text())["steps"]}
    assert steps["printers"]["status"] == "error" and "hung" in steps["printers"]["note"]
    assert steps["usb_devices"]["status"] == "ok" and steps["operator_answers"]["status"] == "ok"
    assert "ERR" in (out / "session.log").read_text()


def test_not_windows_skips_the_windows_steps(tmp_path):
    answers = iter(["x"] * 12)
    mp.main(["--station", "mac", "--out", str(tmp_path)], run=lambda c, t=30: "", list_ports=lambda: [], prompt=lambda q: next(answers), say=lambda s: None, sleep=lambda s: None, windows=False)
    out = next(tmp_path.glob("mac_mercury_*/"))
    steps = {s["step"]: s["status"] for s in json.loads((out / "probe.json").read_text())["steps"]}
    assert steps["usb_devices"] == "skipped" and steps["unplug_test"] == "skipped" and steps["serial_ports"] == "ok"


def test_the_reading_of_the_results():
    serial = mp.interpret([{"Name": "USB-SERIAL CH340", "Service": "CH341SER"}], [{"device": "COM7", "description": "CH340"}], [], [])
    assert any("COM port" in n and "serial probe is possible" in n for n in serial)
    winusb = mp.interpret([{"Name": "Laser", "Service": "WinUSB"}], [], [], [])
    assert any("pyusb" in n for n in winusb)
    nothing = mp.interpret([], [], [], [])
    assert "changed nothing" in nothing[0]
    assert mp.diff_devices([LASER, MOUSE], [MOUSE]) == {"gone": [LASER], "new": []}
