from __future__ import annotations

import pytest

from kerf_cutter import config as cfgmod
from kerf_cutter.camera.capture import CameraCapture
from kerf_cutter.config import Config
from kerf_cutter.devices.manager import DeviceManager
from kerf_cutter.devices.ports import PortInfo, probably_not_grbl
from kerf_cutter.diag import bundle
from kerf_cutter.logs import CutterLog

from .fake_grbl import FakeGrbl

LASER = PortInfo("COM9", "USB Serial Device (COM9)", 0x303A, 0x4001, "123456", "1-5.1")
AMT = PortInfo("COM3", "Intel(R) Active Management Technology - SOL (COM3)", None, None, None, None)


class TestConfig:
    def test_defaults_round_trip_and_the_token_is_hidden_when_shown(self, tmp_path):
        p = tmp_path / "cutter.json"
        assert cfgmod.load(p).station == "station-1"  # no file yet: defaults
        c = Config(station="station-3", server_url="https://kerf.school/", token="ks_secret")
        cfgmod.save(c, p)
        got = cfgmod.load(p)
        assert (got.station, got.token, got.auto_home) == ("station-3", "ks_secret", True)
        assert got.ws_url() == "wss://kerf.school/api/v1/ws/cutter" and Config(server_url="http://h:8000").ws_url() == "ws://h:8000/api/v1/ws/cutter"
        assert "ks_secret" not in str(got.redacted())

    def test_an_older_file_with_missing_or_unknown_keys_still_loads(self, tmp_path):
        p = tmp_path / "cutter.json"
        p.write_text('{"station": "station-2", "camera": {"index": 1}, "someFutureThing": 5}')
        c = cfgmod.load(p)
        assert c.station == "station-2" and c.camera["index"] == 1 and c.camera["fps"] == 2.0


class TestLogs:
    def test_lines_are_json_redacted_rotated_and_shippable(self, tmp_path):
        log = CutterLog(tmp_path, "station-1", level="INFO", max_bytes=2000, backups=3)
        log.add_secret("ks_topsecret")
        log.info("hello", note="token is ks_topsecret", job_id="job-1")
        log.debug("quiet")  # below the level: nowhere
        log.serial("TX", "G21")  # DEBUG: nowhere at INFO
        text = (tmp_path / "cutter.jsonl").read_text()
        assert "ks_topsecret" not in text and "***" in text and '"job_id":"job-1"' in text and "quiet" not in text and '"G21"' not in text
        for i in range(60):
            log.info("fill", n=i, pad="x" * 100)
        assert len(list(tmp_path.glob("cutter.jsonl*"))) >= 2  # rotated
        shipped = log.drain(500)
        assert shipped[0]["event"] == "hello" and all({"timestamp", "level", "station", "event"} <= set(l) for l in shipped)
        log.requeue(shipped[:2])
        assert [l["event"] for l in log.drain(2)] == [shipped[0]["event"], shipped[1]["event"]]
        log.close()

    def test_remote_debug_switches_itself_off_and_serial_is_never_shipped(self, tmp_path):
        t = {"now": 0.0}
        log = CutterLog(tmp_path, "station-1", clock=lambda: t["now"])
        log.set_level("DEBUG", debug_minutes=10)
        log.serial("RX", "ok")
        assert any(l["event"] == "serial" for l in log.recent) and not any(l["event"] == "serial" for l in log.drain(100))
        t["now"] = 11 * 60
        log.serial("RX", "ok2")
        assert not any(l.get("data") == "ok2" for l in log.recent)
        log.close()


class TestDevices:
    def mgr(self, tmp_path, ports, sims, cfg=None):
        cfg = cfg or Config()
        log = CutterLog(tmp_path, "station-1")
        opened = []

        def open_serial(device, baud):
            opened.append(device)
            s = sims[device]
            if isinstance(s, Exception):
                raise s
            return s

        return DeviceManager(cfg, log, list_ports=lambda: ports, open_serial=open_serial), cfg, opened, log

    def test_the_amt_sol_port_is_never_probed_and_the_laser_is_found_and_remembered(self, tmp_path):
        sim = FakeGrbl()
        m, cfg, opened, log = self.mgr(tmp_path, [AMT, LASER], {"COM9": sim, "COM3": FakeGrbl()})
        got = m.connect()
        assert got.port.device == "COM9" and got.ser is sim and opened == ["COM9"] and probably_not_grbl(AMT)
        assert cfg.machine == {"vid": 0x303A, "pid": 0x4001, "location": "1-5.1", "lastPort": "COM9"}
        assert got.settings["$130"] == "400.000" and "Grbl" in got.banner

    def test_after_a_restart_the_saved_rule_finds_it_on_a_different_com_number(self, tmp_path):
        cfg = Config(machine={"vid": 0x303A, "pid": 0x4001, "location": "1-5.1", "lastPort": "COM5"})
        moved = PortInfo("COM7", "USB Serial Device (COM7)", 0x303A, 0x4001, "123456", "1-5.1")
        other = PortInfo("COM8", "USB Serial Device (COM8)", 0x303A, 0x4001, "123456", "1-6.2")  # another unit, same serial number: only the location differs
        m, cfg, opened, _ = self.mgr(tmp_path, [other, moved], {"COM7": FakeGrbl(), "COM8": FakeGrbl()}, cfg)
        assert m.connect().port.device == "COM7" and opened[0] == "COM7" and cfg.machine["lastPort"] == "COM7"

    def test_two_lasers_and_no_rule_is_not_guessed(self, tmp_path):
        other = PortInfo("COM8", "USB Serial Device", 0x303A, 0x4001, "123456", "1-6.2")
        m, cfg, _, _ = self.mgr(tmp_path, [LASER, other], {"COM9": FakeGrbl(), "COM8": FakeGrbl()})
        assert m.connect() is None and not cfg.machine

    def test_a_port_held_by_another_program_is_reported_as_busy_with_the_programs_named(self, tmp_path):
        m, _, _, _ = self.mgr(tmp_path, [LASER], {"COM9": PermissionError("could not open port 'COM9': PermissionError(13, 'Access is denied.')")})
        assert m.connect() is None
        r = m.last[0]
        assert r.state == "busy" and "LightBurn" in r.message and "LaserGRBL" in r.message and "Creality" in r.message

    def test_a_silent_port_and_a_dead_port_are_not_chosen(self, tmp_path):
        silent = FakeGrbl()
        silent.silent_after = -1  # never answers
        silent.write = lambda data: len(data)  # even the reset gets no banner
        m, _, _, _ = self.mgr(tmp_path, [LASER], {"COM9": silent})
        assert m.connect() is None and m.last[0].state == "silent"
        assert [d["state"] for d in m.describe()] == ["silent"]


class TestCamera:
    class Frame:
        shape = (480, 640, 3)

    class FakeCv2:
        IMWRITE_JPEG_QUALITY = 1
        CAP_DSHOW = 700

        class VideoCapture:
            def __init__(self, *a):
                self.n = 0

            def isOpened(self): return True
            def read(self):
                self.n += 1
                return True, TestCamera.Frame()
            def release(self): pass

        @staticmethod
        def resize(f, size): return f
        @staticmethod
        def imencode(ext, frame, params): return True, b"\xff\xd8fake-jpeg\xff\xd9"

    def test_frames_are_kept_in_memory_only_and_a_missing_library_is_just_unavailable(self, tmp_path):
        log = CutterLog(tmp_path, "station-1")
        cam = CameraCapture({"enabled": True, "fps": 50}, log, load_cv2=lambda: self.FakeCv2, sleep=lambda s: __import__("time").sleep(0.001))
        cam.start()
        import time
        for _ in range(200):
            if cam.latest():
                break
            time.sleep(0.01)
        cam.stop()
        seq, jpeg = cam.latest()
        assert jpeg.startswith(b"\xff\xd8") and cam.state == "ok"
        assert not [p for p in tmp_path.rglob("*") if p.suffix in (".jpg", ".jpeg", ".png")]  # nothing on disk
        off = CameraCapture({"enabled": True}, log, load_cv2=lambda: None)
        off.start(); time.sleep(0.1)
        assert off.state == "unavailable" and off.latest() is None
        assert CameraCapture({"enabled": False}, log).state == "off"


def test_the_diagnostic_bundle_has_what_support_needs_and_no_token(tmp_path):
    import io
    import json
    import zipfile

    cfg = Config(station="station-2", token="ks_verysecret", server_url="http://127.0.0.1:1")
    log = CutterLog(tmp_path, "station-2")
    log.info("something", note="ks_verysecret")  # even a leaked token in a log line is not in the bundle
    z = zipfile.ZipFile(io.BytesIO(bundle.build(cfg, log, banner="Grbl 1.1f", settings={"$30": "1000"}, devices=[{"device": "COM9"}], camera_state="ok", state="idle", network={"ok": False})))
    names = set(z.namelist())
    assert {"config.json", "grbl.json", "devices.json", "network.json", "environment.json", "logs/cutter.jsonl"} <= names
    assert all(b"ks_verysecret" not in z.read(n) for n in names)
    assert json.loads(z.read("grbl.json"))["settings"]["$30"] == "1000" and json.loads(z.read("environment.json"))["state"] == "idle"
