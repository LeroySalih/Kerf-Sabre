"""printer_probe.py against a pretend Moonraker on this machine: the read-only run, an upload without printing, and that
--start does nothing unless the operator types yes."""
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import printer_probe  # noqa: E402


class Fake(BaseHTTPRequestHandler):
    uploads: list = []

    def log_message(self, *a):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        p = self.path
        if p.startswith("/printer/info"):
            return self._json({"result": {"state": "ready", "software_version": "v0.12", "hostname": "K1"}})
        if p.startswith("/server/info"):
            return self._json({"result": {"moonraker_version": "v0.9", "klippy_state": "ready"}})
        if p.startswith("/printer/objects/query"):
            state = "printing" if any(u["print"] for u in Fake.uploads) else "standby"
            return self._json({"result": {"status": {"print_stats": {"state": state, "filename": "x"}, "extruder": {"temperature": 27.1},
                                                     "heater_bed": {"temperature": 25.2}, "toolhead": {"homed_axes": "", "axis_maximum": [220, 220, 250, 0]}}}})
        if p.startswith("/server/files/list"):
            return self._json({"result": [{"path": "a.gcode"}]})
        if p.startswith("/server/webcams/list"):
            return self._json({"result": {"webcams": []}})
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        n = int(self.headers["Content-Length"])
        body = self.rfile.read(n)
        if self.path == "/server/files/upload":
            Fake.uploads.append({"print": b'name="print"' in body, "size": n})
            return self._json({"item": {"path": "kerf-probe-t.gcode"}, "print_started": b'name="print"' in body}, 201)
        self.send_response(404)
        self.end_headers()


@pytest.fixture()
def moonraker():
    Fake.uploads = []
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield srv.server_address[1]
    srv.shutdown()


def run(tmp_path, port, *extra):
    code = printer_probe.main(["--host", "127.0.0.1", "--port", str(port), "--out", str(tmp_path), *extra])
    folder = next(p for p in tmp_path.iterdir() if p.is_dir())
    return code, json.loads((folder / "report.json").read_text()), folder


def test_read_only_run_checks_everything_and_writes_a_zip(tmp_path, moonraker, monkeypatch):
    monkeypatch.setattr(printer_probe, "TIMEOUT_S", 1)
    code, rep, folder = run(tmp_path, moonraker)
    names = {c["name"]: c["ok"] for c in rep["checks"]}
    assert names["Moonraker answers /printer/info"] and names["files: list the G-code files on the printer"]
    assert Fake.uploads == []  # nothing sent
    assert folder.with_suffix(".zip").exists() and (folder / "session.log").read_text()


def test_upload_does_not_print_and_start_needs_yes(tmp_path, moonraker, monkeypatch):
    g = tmp_path / "t.gcode"
    g.write_text("G28\n")
    run(tmp_path / "a", moonraker, "--upload", str(g))
    assert Fake.uploads[-1]["print"] is False
    monkeypatch.setattr("builtins.input", lambda *_: "no")
    run(tmp_path / "b", moonraker, "--upload", str(g), "--start")
    assert Fake.uploads[-1]["print"] is False
    monkeypatch.setattr("builtins.input", lambda *_: "yes")
    monkeypatch.setattr(printer_probe.time, "sleep", lambda s: None)
    code, rep, _ = run(tmp_path / "c", moonraker, "--upload", str(g), "--start")
    assert Fake.uploads[-1]["print"] is True
    assert any(c["name"] == "the printer reports the print started" and c["ok"] for c in rep["checks"])


def test_an_unreachable_printer_says_what_to_check(tmp_path):
    code, rep, _ = run(tmp_path, 1)
    assert code == 1 and "network" in rep["checks"][0]["name"] and not rep["checks"][0]["ok"]
