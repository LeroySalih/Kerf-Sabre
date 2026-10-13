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
    folders = list(tmp_path.glob("s9_*"))
    assert len(folders) == 1 and (folders[0] / "report.txt").exists()
    assert b"\x18" in mock.written  # left in safe state
