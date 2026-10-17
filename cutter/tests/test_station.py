"""The real Cutter against the real Kerf Server (in-process, over a real WebSocket), with a simulated GRBL on the serial side.
Skipped if the server package is not installed."""
from __future__ import annotations

import asyncio
import json
import socket
import threading
import time
import urllib.error
import urllib.request

import pytest

pytest.importorskip("kerf_server")
uvicorn = pytest.importorskip("uvicorn")

from kerf_cutter.config import Config  # noqa: E402
from kerf_cutter.devices.manager import DeviceManager  # noqa: E402
from kerf_cutter.logs import CutterLog  # noqa: E402
from kerf_cutter.station import Station  # noqa: E402

from .fake_grbl import FakeGrbl  # noqa: E402
from .test_support import LASER  # noqa: E402


@pytest.fixture()
def server(tmp_path):
    from kerf_server.app import create_app
    from kerf_server.config import Settings
    from kerf_server.security import issue_token

    app = create_app(Settings.from_env(data_dir=tmp_path / "server", auth_mode="pins"))  # the Cutter uses a station token; people sign in with DINO, not under test here
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    srv = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", ws="websockets"))
    t = threading.Thread(target=srv.run, daemon=True)
    t.start()
    for _ in range(200):
        if srv.started:
            break
        time.sleep(0.05)
    assert srv.started
    tokens = {r: issue_token(app.state.db, r, i) for r, i in (("pupil", "P001"), ("teacher", "T001"), ("station", "station-1"))}
    yield {"url": f"http://127.0.0.1:{port}", "tokens": tokens, "app": app}
    srv.should_exit = True
    t.join(5)


def api(srv, method, path, who, body=None):
    req = urllib.request.Request(srv["url"] + "/api/v1" + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {srv['tokens'][who]}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw and r.headers.get_content_type() == "application/json" else raw.decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def rect(oid, x, y, w, h):
    segs = [{"type": "line", "to": [x + w, y]}, {"type": "line", "to": [x + w, y + h]}, {"type": "line", "to": [x, y + h]}, {"type": "line", "to": [x, y]}]
    return {"id": oid, "layer": "cut", "closed": True, "start": [x, y], "segments": segs, "matrix": [1, 0, 0, 1, 0, 0]}


def approved_job(srv, x=20, y=20):
    doc = {"schemaVersion": "0.2.12", "id": "x", "pupilId": "P001", "createdAt": "2026-10-14T09:00:00Z", "status": "draft", "preset": {"id": "ply-3mm", "version": 1},
           "station": None, "origin": {"mode": "absolute"}, "objects": [rect("a", x, y, 50, 30)]}
    code, r = api(srv, "POST", "/jobs", "pupil", doc)
    assert code == 201, r
    jid = r["id"]
    assert api(srv, "POST", f"/jobs/{jid}/submit", "pupil")[0] == 200
    assert api(srv, "POST", f"/jobs/{jid}/approve", "teacher")[0] == 200
    return jid


async def _poll(fn, timeout):
    end = time.time() + timeout
    while time.time() < end:
        v = await asyncio.to_thread(fn)
        if v:
            return v
        await asyncio.sleep(0.05)
    raise AssertionError("timed out")


@pytest.fixture()
async def cutter(server, tmp_path):
    sim = FakeGrbl(bed=(400, 415))
    cfg = Config(station="station-1", server_url=server["url"], token=server["tokens"]["station"], camera={"enabled": False})
    log = CutterLog(tmp_path / "logs", "station-1", level="DEBUG")
    devices = DeviceManager(cfg, log, list_ports=lambda: [LASER], open_serial=lambda p, b: sim)

    async def quick(s):  # the real loops wait seconds between polls; tests do not
        await asyncio.sleep(min(s, 0.05))

    st = Station(cfg, log, devices=devices, loop_sleep=quick)
    task = asyncio.create_task(st.run())
    await _poll(lambda: api(server, "GET", "/stations/station-1", "pupil")[1].get("online") and api(server, "GET", "/stations/station-1", "pupil")[1].get("state") == "Idle", 20)
    yield st, sim, log
    st._stop = True
    task.cancel()
    try:
        await task
    except (asyncio.CancelledError, Exception):
        pass
    log.close()


async def test_it_homes_says_hello_and_reports_the_machines_real_settings(server, cutter):
    st, sim, _ = cutter
    assert st.state == "idle" and st.homed and "$H" in sim.lines and st.bed() == (400.0, 415.0)
    info = api(server, "GET", "/stations/station-1", "pupil")[1]
    assert info["online"] and info["s30"] == 1000 and info["laserMode"] is True and info["cutterVersion"] and info["mpos"] is not None


async def test_frame_then_start_runs_the_whole_job_and_the_server_sees_it_done(server, cutter):
    st, sim, _ = cutter
    jid = approved_job(server)
    code, body = await asyncio.to_thread(api, server, "POST", f"/jobs/{jid}/frame", "station", {"station": "station-1"})
    assert code == 202, body
    await _poll(lambda: "G0 X19.900 Y50.100" in sim.lines, 10)  # the job's outline: 20..70 by 20..50 mm, 0.1 mm wider each way (the kerf offset)
    assert "M5" in sim.lines  # the frame traces with the laser off
    assert not any(l.startswith(("M3", "M4")) for l in sim.lines)
    await _poll(lambda: api(server, "GET", "/stations/station-1", "pupil")[1].get("state") == "Idle", 10)
    framed_lines = len(sim.lines)
    code, body = await asyncio.to_thread(api, server, "POST", f"/jobs/{jid}/assign", "station", {"station": "station-1", "materialConfirmed": True, "allowUntested": True})
    assert code in (200, 422), body
    if code == 422:  # an untested material is only refused for stations; the teacher may override
        code, body = await asyncio.to_thread(api, server, "POST", f"/jobs/{jid}/assign", "teacher", {"station": "station-1", "materialConfirmed": True, "allowUntested": True})
    assert code == 200, body
    await _poll(lambda: api(server, "GET", f"/jobs/{jid}", "teacher")[1]["status"] == "done", 30)
    gcode = api(server, "GET", f"/jobs/{jid}/gcode?station=station-1", "teacher")[1]
    cut_lines = [l.split(";")[0].strip() for l in gcode.splitlines() if l.split(";")[0].strip()]
    assert sim.lines[framed_lines:framed_lines + len(cut_lines)] == cut_lines  # every line of the job reached the laser, in order
    assert sim.lines[-2:] == ["M5", "M9"] and st.state == "idle" and st.job_id is None


async def test_stop_halts_resets_fails_nothing_else_and_it_homes_again(server, cutter):
    st, sim, _ = cutter
    jid = approved_job(server)
    assert (await asyncio.to_thread(api, server, "POST", f"/jobs/{jid}/frame", "teacher", {"station": "station-1"}))[0] == 202
    await _poll(lambda: st.state == "idle" and api(server, "GET", "/stations/station-1", "pupil")[1].get("state") == "Idle" and sim.lines.count("G0 X19.900 Y19.900") > 1, 15)
    sim.moves_per_line = 300  # a long cut: still "moving" after every line has been sent
    code, body = await asyncio.to_thread(api, server, "POST", f"/jobs/{jid}/assign", "teacher", {"station": "station-1", "materialConfirmed": True, "allowUntested": True})
    assert code == 200, body
    await _poll(lambda: st.state == "running", 10)
    homes = sim.lines.count("$H")
    code, _ = await asyncio.to_thread(api, server, "POST", "/stations/station-1/control", "teacher", {"command": "stop"})
    assert code == 202
    await _poll(lambda: api(server, "GET", f"/jobs/{jid}", "teacher")[1]["status"] in ("cancelled", "failed"), 20)
    assert b"!" in sim.written and b"\x18" in sim.written
    await _poll(lambda: st.state == "idle" and sim.lines.count("$H") > homes, 20)  # reset means the position is lost: it homes again before the next job
    assert st.homed


async def test_a_job_the_cutters_own_scan_refuses_never_reaches_the_laser(server, cutter, monkeypatch):
    st, sim, _ = cutter
    jid = approved_job(server)
    await asyncio.to_thread(api, server, "POST", f"/jobs/{jid}/frame", "teacher", {"station": "station-1"})
    await _poll(lambda: api(server, "GET", "/stations/station-1", "pupil")[1].get("state") == "Idle", 30)
    monkeypatch.setattr(st, "fetch", lambda cfg, path, sha: "G21\nG90\nM4 S0\nG1 X900 Y20 S500 F900\nM5\n")  # tampered: off the bed
    before = len(sim.lines)
    code, body = await asyncio.to_thread(api, server, "POST", f"/jobs/{jid}/assign", "teacher", {"station": "station-1", "materialConfirmed": True, "allowUntested": True})
    assert code >= 400 and "safety check" in json.dumps(body)
    assert len(sim.lines) == before  # nothing was sent to GRBL
    assert api(server, "GET", f"/jobs/{jid}", "teacher")[1]["status"] in ("approved", "assigned")


async def test_a_damaged_download_is_refused_by_its_checksum(server, cutter, monkeypatch):
    st, sim, _ = cutter
    from kerf_cutter.net import http

    jid = approved_job(server)
    await asyncio.to_thread(api, server, "POST", f"/jobs/{jid}/frame", "teacher", {"station": "station-1"})
    await _poll(lambda: api(server, "GET", "/stations/station-1", "pupil")[1].get("state") == "Idle", 30)
    real = http.fetch_gcode
    monkeypatch.setattr(st, "fetch", lambda cfg, path, sha: real(cfg, path, "0" * 64))
    code, body = await asyncio.to_thread(api, server, "POST", f"/jobs/{jid}/assign", "teacher", {"station": "station-1", "materialConfirmed": True, "allowUntested": True})
    assert code >= 400 and "checksum" in json.dumps(body)


async def test_logs_reach_the_server_and_never_contain_the_token(server, cutter):
    st, sim, log = cutter
    await _poll(lambda: len(server["app"].state.hub.get("station-1").logs) > 0, 10)
    shipped = json.dumps(list(server["app"].state.hub.get("station-1").logs))
    assert "machine_ready" in shipped and server["tokens"]["station"] not in shipped
    assert server["tokens"]["station"] not in (log.path.read_text())


async def test_the_server_can_change_the_log_level_and_ask_for_a_diagnostic_bundle(server, cutter, tmp_path):
    st, sim, log = cutter
    code, _ = await asyncio.to_thread(api, server, "PUT", "/stations/station-1/log-level", "teacher", {"level": "DEBUG"})
    assert code == 204
    await _poll(lambda: log.level == 10, 10)
    code, _ = await asyncio.to_thread(api, server, "POST", "/stations/station-1/diagnostics", "teacher")
    assert code == 202
    stored = server["app"].state.settings.data_dir / "diagnostics" / "station-1"
    await _poll(lambda: list(stored.glob("*.zip")) if stored.exists() else None, 15)
