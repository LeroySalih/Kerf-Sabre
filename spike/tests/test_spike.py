import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import spike  # noqa: E402
from mock_grbl import MockGrbl  # noqa: E402

CH340 = {"device": "COM3", "description": "USB-SERIAL CH340 (COM3)", "vid": 0x1A86, "pid": 0x7523, "hwid": "USB VID:PID=1A86:7523"}


class FakeCap:
    def __init__(self, idx):
        self.idx = idx

    def isOpened(self):
        return self.idx == 1

    def read(self):
        return True, "frame"

    def release(self):
        pass


class FakeCv2:
    __version__ = "fake"
    VideoCapture = FakeCap

    @staticmethod
    def imwrite(path, frame):
        Path(path).write_bytes(b"jpg")


def make_runner(tmp_path, mock=None, ports=None, cv2=None, answers=None, enable_fire=False, url="https://k.example"):
    mock = mock or MockGrbl()
    args = spike.build_parser().parse_args(
        ["--mode", "auto", "--station", "t1", "--server-url", url] + (["--enable-fire"] if enable_fire else []))
    answers = list(answers if answers is not None else ["y", "y"])
    runner = spike.Runner(
        args, tmp_path / "out",
        list_ports=lambda: [CH340] if ports is None else ports,
        open_serial=lambda port, baud: mock,
        load_cv2=lambda: (cv2, None) if cv2 else (None, "ImportError: no cv2"),
        http_get=lambda url, timeout=10: 200,
        prompt=lambda msg="": answers.pop(0) if answers else "",
        say=lambda *a, **k: None,
        sleep=lambda s: None,
    )
    runner.start()
    return runner, mock


def statuses(runner):
    return {r["test"]: r["status"] for r in runner.results}


def test_happy_path(tmp_path):
    runner, mock = make_runner(tmp_path, cv2=FakeCv2)
    runner.run_all()
    runner.write_reports()
    runner.close()
    s = statuses(runner)
    assert s == {1: "pass", 2: "pass", 3: "pass", 4: "pass", 5: "pass", 6: "pass", 7: "pass", 8: "pass",
                 9: "pass", 10: "pass", 11: "skipped"}
    out = tmp_path / "out"
    for name in ("report.json", "report.txt", "serial.log", "settings.txt", "camera.jpg", "env.txt"):
        assert (out / name).exists(), name
    assert json.loads((out / "report.json").read_text())["summary"]["fail"] == 0
    first = json.loads((out / "serial.log").read_text().splitlines()[0])
    assert {"ts", "dir", "data"} <= first.keys()


def test_homing_disabled_continues(tmp_path):
    runner, _ = make_runner(tmp_path, mock=MockGrbl(homing_enabled=False))
    runner.run_all()
    s = statuses(runner)
    assert s[5] == "fail"
    assert s[6] == "pass" and s[8] == "pass"  # later tests still ran
    runner.close()


def test_no_ports_skips_dependents(tmp_path):
    runner, _ = make_runner(tmp_path, ports=[])
    runner.run_all()
    s = statuses(runner)
    assert s[1] == "fail"
    assert all(s[n] == "skipped" for n in (2, 3, 4, 5, 6, 7, 8, 11))
    assert "dependency" in runner.results[1]["details"]["reason"]
    runner.close()


def test_no_banner_fails_open(tmp_path):
    runner, _ = make_runner(tmp_path, mock=MockGrbl(silent=True))
    ticks = iter(x * 0.5 for x in range(10_000))
    runner.clock = lambda: next(ticks)  # fake clock so timeouts elapse instantly
    runner.run_all()
    s = statuses(runner)
    assert s[2] == "fail" and s[3] == "skipped"
    runner.close()


def test_opencv_missing_does_not_crash(tmp_path):
    runner, _ = make_runner(tmp_path, cv2=None)
    runner.run_all()
    runner.write_reports()
    r9 = next(r for r in runner.results if r["test"] == 9)
    assert r9["status"] == "skipped"
    assert "OpenCV unavailable" in r9["details"]["reason"]
    assert "ImportError" in (tmp_path / "out" / "env.txt").read_text()
    runner.close()


def test_no_usb_camera_recorded(tmp_path):
    class NoCam(FakeCv2):
        class VideoCapture(FakeCap):
            def isOpened(self):
                return False

    runner, _ = make_runner(tmp_path, cv2=NoCam)
    runner.run_all()
    r9 = next(r for r in runner.results if r["test"] == 9)
    assert "no USB camera found" in r9["details"]["outcome"]
    runner.close()


def test_air_assist_operator_no(tmp_path):
    runner, _ = make_runner(tmp_path, answers=["n", "n"])
    runner.run_all()
    assert statuses(runner)[7] == "fail"
    runner.close()


def test_jog_limit_error_fails_not_crashes(tmp_path):
    runner, _ = make_runner(tmp_path, mock=MockGrbl(jog_error="error:15"))
    runner.run_all()
    assert statuses(runner)[6] == "fail"
    runner.close()


def test_fire_requires_phrase(tmp_path):
    runner, mock = make_runner(tmp_path, enable_fire=True, answers=["y", "y", "nope"])
    runner.run_all()
    r11 = next(r for r in runner.results if r["test"] == 11)
    assert r11["status"] == "skipped"
    assert not any(b"M4" in w for w in mock.written)
    runner.close()


def test_fire_with_phrase_runs_low_power(tmp_path):
    runner, mock = make_runner(tmp_path, enable_fire=True, answers=["y", "y", spike.FIRE_PHRASE])
    runner.run_all()
    assert statuses(runner)[11] == "pass"
    sent = b"".join(mock.written).decode()
    assert "S50" in sent  # 5% of $30=1000
    assert sent.rindex("M5") > sent.rindex("G1")
    runner.close()


def test_fire_never_by_default(tmp_path):
    runner, mock = make_runner(tmp_path)
    runner.run_all()
    assert not any(b"M4" in w for w in mock.written)
    runner.close()


def test_ctrl_c_sends_hold_then_reset_and_writes_report(tmp_path):
    runner, mock = make_runner(tmp_path)

    def boom():
        raise KeyboardInterrupt

    runner.test_4 = boom
    runner.run_all()
    runner.write_reports()
    assert runner.aborted
    tail = [w for w in mock.written if w in (b"!", b"\x18")]
    assert tail[-2:] == [b"!", b"\x18"]
    assert statuses(runner)[4] == "fail"
    assert all(statuses(runner)[n] == "skipped" for n in (5, 6, 7, 8, 9, 10, 11))
    assert (tmp_path / "out" / "report.json").exists()
    runner.close()


def test_exception_in_test_is_recorded_and_continues(tmp_path):
    runner, _ = make_runner(tmp_path)

    def bad():
        raise RuntimeError("kaput")

    runner.test_3 = bad
    runner.run_all()
    s = statuses(runner)
    assert s[3] == "fail" and s[5] == "pass"
    runner.close()


def test_never_uses_g92_or_enables_laser_outside_test_11(tmp_path):
    runner, mock = make_runner(tmp_path)
    runner.run_all()
    sent = b"".join(mock.written).decode()
    assert "G92" not in sent and "M3" not in sent and "M4" not in sent
    runner.close()


def test_parse_status():
    s = spike.parse_status("<Idle|MPos:1.000,2.500,0.000|FS:0,0>")
    assert s["state"] == "Idle" and s["mpos"] == [1.0, 2.5, 0.0]
    assert spike.parse_status("<Hold:0|WPos:1,2,3>")["wpos"] == [1.0, 2.0, 3.0]
    assert spike.parse_status("ok") is None


def test_main_end_to_end(tmp_path, monkeypatch):
    mock = MockGrbl()
    rc = spike.main(
        ["--mode", "auto", "--station", "s9", "--server-url", "", "--out", str(tmp_path)],
        list_ports=lambda: [CH340], open_serial=lambda p, b: mock,
        load_cv2=lambda: (None, "ImportError"), prompt=lambda m="": "y", say=lambda *a: None,
        sleep=lambda s: None,
    )
    assert rc == 0
    folders = [p for p in tmp_path.glob("s9_*") if p.is_dir()]
    assert len(folders) == 1 and (folders[0] / "report.txt").exists()
    assert b"\x18" in mock.written  # left in safe state


# ---- logging: everything must be recoverable from the files, so problems can be diagnosed afterwards --------------

def test_session_log_is_one_readable_timeline_of_everything(tmp_path):
    runner, mock = make_runner(tmp_path, cv2=FakeCv2)
    runner.run_all()
    runner.write_reports()
    runner.close()
    log = (tmp_path / "out" / "session.log").read_text()
    for needle in ("INFO Kerf Spike", "pyserial", "EVT  ports_found", "EVT  opening_port", "EVT  banner", "TX   $$", "RX   ok",
                   "EVT  test_start", "EVT  test_end", "EVT  report_written", "SAY  ", "IN   y", "session closed"):
        assert needle in log, needle
    # every line is "HH:MM:SS.mmm +seconds KIND text", in time order
    import re

    times = [float(m.group(1)) for m in (re.match(r"\d\d:\d\d:\d\d\.\d{3} \+\s*([\d.]+)s ", line) for line in log.splitlines()) if m]
    assert len(times) > 50 and times == sorted(times)


def test_results_are_saved_as_they_happen_not_only_at_the_end(tmp_path):
    runner, mock = make_runner(tmp_path, cv2=FakeCv2)
    runner.run_all()
    out = tmp_path / "out"
    rows = [json.loads(line) for line in (out / "results.jsonl").read_text().splitlines()]
    assert [r["test"] for r in rows] == list(range(1, 12))
    partial = json.loads((out / "report.json").read_text())  # no write_reports() yet: this is what a crash would leave behind
    assert partial["partial"] is True and partial["finished"] is None and len(partial["results"]) == 11
    assert partial["settings"]["$30"] == "1000"
    runner.write_reports()
    assert json.loads((out / "report.json").read_text())["partial"] is False
    runner.close()


def test_environment_and_crash_log_exist_from_the_start(tmp_path):
    runner, _ = make_runner(tmp_path)
    out = tmp_path / "out"
    env = (out / "env.txt").read_text()  # written by start(), before any test ran
    for needle in ("pyserial:", "hostname:", "argv:", "timezone:", "python:"):
        assert needle in env, needle
    assert (out / "crash.log").exists()
    runner.close()


def test_serial_log_keeps_raw_bytes_when_they_differ_from_the_text(tmp_path):
    mock = MockGrbl(silent=True)
    runner, _ = make_runner(tmp_path, mock=mock)
    mock.rx.append("ok\r")  # a stray carriage return
    runner.link = spike.Link(mock, runner.log_file, session=runner.session, sleep=lambda s: None)
    runner.link.read_line()
    runner.close()
    recs = [json.loads(line) for line in (tmp_path / "out" / "serial.log").read_text().splitlines()]
    assert recs[-1]["dir"] == "RX" and "raw" in recs[-1] and "t" in recs[-1]


class _Port:
    """A serial port that behaves badly in a chosen way."""

    def __init__(self, reads=(), fail_write=False):
        self.reads = list(reads)
        self.fail_write = fail_write

    def write(self, data):
        if self.fail_write:
            raise OSError("the device does not recognize the command")

    def readline(self):
        return self.reads.pop(0) if self.reads else b""

    def close(self):
        pass


def test_timeouts_partial_lines_and_error_replies_are_flagged_in_the_log(tmp_path):
    runner, _ = make_runner(tmp_path)
    t = iter(range(0, 1000))
    link = spike.Link(_Port([b"partial", b"error:20\n"]), runner.log_file, clock=lambda: next(t) * 0.5, session=runner.session, sleep=lambda s: None)
    link.read_line()
    link.command("G0 X1", timeout=2.0)
    link.command("$$", timeout=1.0)  # nothing more to read: times out
    link.status(timeout=1.0)
    runner.close()
    log = (tmp_path / "out" / "session.log").read_text()
    assert "WARN partial line" in log and "answered 'G0 X1' with 'error:20'" in log
    assert "timeout after 1s waiting for ok to '$$'" in log and "no status report" in log


def test_a_dead_port_write_is_logged_with_a_traceback_then_raised(tmp_path):
    runner, _ = make_runner(tmp_path)
    link = spike.Link(_Port(fail_write=True), runner.log_file, session=runner.session)
    with pytest.raises(OSError):
        link.tx("$$")
    runner.close()
    log = (tmp_path / "out" / "session.log").read_text()
    assert "ERR  serial write failed" in log and "OSError" in log and "Traceback" in log


def test_cannot_open_port_explains_what_to_check_and_logs_it(tmp_path):
    def boom(port, baud):
        raise PermissionError("could not open port 'COM3': PermissionError(13, 'Access is denied.')")

    args = spike.build_parser().parse_args(["--mode", "auto", "--station", "t1", "--server-url", ""])
    runner = spike.Runner(args, tmp_path / "out", list_ports=lambda: [CH340], open_serial=boom, load_cv2=lambda: (None, "x"),
                          prompt=lambda m="": "", say=lambda *a: None, sleep=lambda s: None)
    runner.start()
    runner.run_all()
    runner.write_reports()
    runner.close()
    report = json.loads((tmp_path / "out" / "report.json").read_text())
    err = next(r for r in report["results"] if r["test"] == 2)["details"]["error"]
    assert "Close it" in err and "LightBurn" in err
    log = (tmp_path / "out" / "session.log").read_text()
    assert "could not open" in log and "Access is denied" in log


def test_main_makes_one_zip_with_everything_to_send_back(tmp_path):
    import zipfile

    messages = []
    rc = spike.main(["--mode", "auto", "--station", "s9", "--server-url", "", "--out", str(tmp_path)],
                    list_ports=lambda: [CH340], open_serial=lambda p, b: MockGrbl(), load_cv2=lambda: (None, "ImportError"),
                    prompt=lambda m="": "y", say=lambda *a: messages.append(" ".join(map(str, a))), sleep=lambda s: None)
    assert rc == 0
    [zip_path] = tmp_path.glob("s9_*.zip")
    names = {n.split("/", 1)[1] for n in zipfile.ZipFile(zip_path).namelist()}
    assert {"session.log", "serial.log", "report.json", "report.txt", "env.txt", "results.jsonl", "crash.log", "settings.txt"} <= names
    assert any("Send this ONE file back" in m and str(zip_path) in m for m in messages)


def test_an_unexpected_crash_in_main_is_logged_with_its_traceback_and_still_zipped(tmp_path):
    def explode(*a):
        raise RuntimeError("driver exploded")

    rc = spike.main(["--mode", "console", "--station", "s9", "--server-url", "", "--out", str(tmp_path)],
                    list_ports=lambda: [CH340], open_serial=lambda p, b: MockGrbl(), load_cv2=lambda: (None, "x"),
                    prompt=explode, say=lambda *a: None, sleep=lambda s: None)
    assert rc == 0
    [folder] = [p for p in tmp_path.glob("s9_*") if p.is_dir()]
    log = (folder / "session.log").read_text()
    assert "driver exploded" in log and "Traceback" in log
    assert list(tmp_path.glob("s9_*.zip"))


def test_hunts_through_ports_until_grbl_answers(tmp_path):
    amt = {"device": "COM3", "description": "Intel(R) Active Management Technology - SOL (COM3)", "vid": None, "pid": None, "hwid": "PCI\\VEN_8086"}
    esp = {"device": "COM5", "description": "USB Serial Device (COM5)", "vid": 0x303A, "pid": 0x4001, "hwid": "USB VID:PID=303A:4001"}
    mock, silent, opened = MockGrbl(), MockGrbl(), []
    silent.readline = lambda *a, **k: b""; silent.write = lambda data: len(data)  # a port that never answers
    runner, _ = make_runner(tmp_path, mock=mock, ports=[amt, esp])
    runner.open_serial = lambda port, baud: (opened.append(port), mock if port == "COM3" else silent)[1]
    runner.select_port()
    assert runner.candidates == ["COM5", "COM3"]  # USB device ranked before the AMT port
    runner.open_link()
    assert runner.port == "COM3" and opened == ["COM5", "COM3"]  # silent COM5 rejected, COM3 answered
    runner.close()
