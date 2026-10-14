"""The Station's safety behaviour without a server: what it tells the Server, and what it does when things go wrong."""
from __future__ import annotations

import asyncio
import time

import pytest

from kerf_cutter.config import Config
from kerf_cutter.devices.manager import DeviceManager
from kerf_cutter.logs import CutterLog
from kerf_cutter.station import Station

from .fake_grbl import FakeGrbl
from .test_support import LASER

GOOD = "G21\nG90\nM4 S0\nM8\nG0 X19.9 Y19.9\nG1 X70.1 Y19.9 F180 S1000\nG1 X70.1 Y50.1\nG1 X19.9 Y50.1\nG1 X19.9 Y19.9\nM9\nM5\nG0 X0 Y0 S0\n"
BOUNDS = {"minX": 19.9, "minY": 19.9, "maxX": 70.1, "maxY": 50.1}


async def quick(s):
    await asyncio.sleep(min(s, 0.02))


class Rig:
    def __init__(self, tmp_path, sim=None, grace=0.1, fetch=None):
        self.sim = sim or FakeGrbl()
        self.cfg = Config(station="station-1", token="ks_x", camera={"enabled": False}, ws_loss_grace_s=grace)
        self.log = CutterLog(tmp_path, "station-1", level="DEBUG")
        self.sims = [self.sim]
        self.devices = DeviceManager(self.cfg, self.log, list_ports=lambda: [LASER], open_serial=lambda p, b: self.sims[-1])
        self.st = Station(self.cfg, self.log, devices=self.devices, loop_sleep=asyncio.sleep, fetch=fetch or (lambda cfg, path, sha: GOOD))
        self.sent: list[dict] = []
        self.online = True

        async def send(msg):
            if not self.online:
                return False
            self.sent.append(msg)
            return True

        self.st.server.send = send
        type(self.st.server).connected = property(lambda s: self.online)  # the rig decides whether the socket is "up"

    def of(self, kind):
        return [m for m in self.sent if m["type"] == kind]

    def run_job(self, jid="job-1", bounds=BOUNDS):
        return self.st._on_message({"type": "run_job", "jobId": jid, "gcodeUrl": "/x", "gcodeSha256": None, "bounds": bounds, "estimatedS": 5, "material": "Plywood", "presetVersion": 1})


async def wait(fn, timeout=10.0):
    end = time.time() + timeout
    while time.time() < end:
        if fn():
            return True
        await asyncio.sleep(0.02)
    raise AssertionError("timed out")


@pytest.fixture()
async def rig(tmp_path):
    r = Rig(tmp_path)
    assert await r.st.connect_machine()
    yield r
    r.st._stop = True
    r.log.close()


async def test_a_second_job_while_one_runs_is_refused_with_an_ack_and_the_first_is_untouched(rig):
    rig.sim.moves_per_line = 200
    await rig.run_job("job-1")
    await wait(lambda: rig.st.state == "running")
    await rig.run_job("job-2")
    await wait(lambda: any(m["jobId"] == "job-2" for m in rig.of("ack")))
    ack2 = next(m for m in rig.of("ack") if m["jobId"] == "job-2")
    assert ack2["accepted"] is False and "busy" in ack2["reason"]
    assert rig.st.job_id == "job-1" and rig.st.state == "running"
    await rig.st._on_message({"type": "control", "command": "stop"})
    await wait(lambda: rig.of("result"))
    assert rig.of("result")[0]["outcome"] == "cancelled"


async def test_losing_the_server_during_a_cut_holds_and_resets_after_the_grace_and_reports_failed(rig):
    rig.sim.moves_per_line = 300
    await rig.run_job("job-1")
    await wait(lambda: rig.st.state == "running")
    rig.online = False
    rig.st._on_disconnected()
    await wait(lambda: rig.st.runner is None, 10)
    assert b"!" in rig.sim.written and b"\x18" in rig.sim.written
    rig.online = True
    await rig.st._on_connected()  # the server is back: the result that could not be sent is delivered now
    res = rig.of("result")[0]
    assert res["jobId"] == "job-1" and res["outcome"] == "failed" and "connection to the server was lost" in res["message"]


async def test_a_blip_shorter_than_the_grace_does_not_stop_the_cut(tmp_path):
    r = Rig(tmp_path, grace=2.0)
    assert await r.st.connect_machine()
    r.sim.moves_per_line = 40
    await r.run_job("job-1")
    await wait(lambda: r.st.state == "running")
    r.online = False
    r.st._on_disconnected()
    await asyncio.sleep(0.2)
    r.online = True
    await r.st._on_connected()
    await wait(lambda: r.of("result"), 30)
    assert r.of("result")[0]["outcome"] == "done"
    r.st._stop = True
    r.log.close()


async def test_nothing_runs_until_the_laser_is_homed_and_idle(rig):
    rig.st.homed = False
    rig.st.set_state("needs_home")
    await rig.run_job("job-1")
    await wait(lambda: rig.of("ack"))
    assert rig.of("ack")[0]["accepted"] is False and "homing" in rig.of("ack")[0]["reason"]
    assert not any(l.startswith(("G1", "M4")) for l in rig.sim.lines)
    await rig.st._on_message({"type": "control", "command": "frame", "jobId": "job-1", "bounds": BOUNDS})
    await asyncio.sleep(0.2)
    assert not any(l.startswith("G0 X19") for l in rig.sim.lines)  # Frame is refused too


async def test_laser_mode_off_refuses_every_job(tmp_path):
    r = Rig(tmp_path, FakeGrbl(laser=0))
    assert await r.st.connect_machine()
    await r.run_job("job-1")
    await wait(lambda: r.of("ack"))
    assert r.of("ack")[0]["accepted"] is False and "laser mode" in r.of("ack")[0]["reason"]
    r.log.close()


async def test_a_serial_error_during_a_job_fails_it_and_the_result_says_why(rig):
    rig.sim.fail_write_after = len(rig.sim.written) + 12
    await rig.run_job("job-1")
    await wait(lambda: rig.of("result"))
    res = rig.of("result")[0]
    assert res["outcome"] == "failed" and "Lost the link" in res["message"]


async def test_bounds_that_do_not_match_what_the_server_said_are_refused(rig):
    await rig.run_job("job-1", bounds={"minX": 100.0, "minY": 100.0, "maxX": 150.0, "maxY": 150.0})
    await wait(lambda: rig.of("ack"))
    ack = rig.of("ack")[0]
    assert ack["accepted"] is False and "server said" in ack["reason"]
    assert not any(l.startswith("G1") for l in rig.sim.lines)


async def test_unplugging_the_laser_is_noticed_and_replugging_reconnects_it(tmp_path):
    r = Rig(tmp_path)
    assert await r.st.connect_machine()
    r.st.server.ws = object()
    first = r.sim
    first.fail_write_after = len(first.written)  # the cable comes out: every write now fails
    task = asyncio.create_task(r.st.status_loop())
    await wait(lambda: r.st.state == "disconnected")
    assert r.st.link is None
    r.sims.append(FakeGrbl())  # plugged back in (a fresh controller)
    assert await r.st.connect_machine() and r.st.state == "idle"
    r.st._stop = True
    task.cancel()
    r.log.close()
