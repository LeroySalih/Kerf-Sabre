"""The Cutter's brain: one asyncio loop for the network and the state machine; the serial link and the camera run in their own threads.

States: starting -> disconnected (no laser found) -> connecting -> needs_home -> idle -> framing | running <-> paused -> idle; alarm; needs_attention.
Safety (the brief and cutter/PLAN.md): jobs and Frame are refused unless the laser is homed and idle; every G-code file is scanned again here before any
line is sent; Stop is `!` then reset from any state; any fault, lost server connection (after a short grace) or serial error means hold then reset and the
job FAILED with a reason; after any stop or fault the position is not trusted until homing has run again; a job is never resumed after a restart."""
from __future__ import annotations

import asyncio
import base64
import platform
from typing import Any

from . import __version__
from .camera.capture import CameraCapture
from .config import Config
from .devices.manager import DeviceManager
from .diag import bundle
from .grbl import gcode
from .grbl.jobrun import JobRunner
from .grbl.link import Link
from .grbl.state import decode, setting
from .logs import CutterLog
from .net import http
from .net.client import ServerLink, default_connect
from .progress import progress_ticker


class Station:
    def __init__(self, cfg: Config, log: CutterLog, *, devices: DeviceManager | None = None, camera: CameraCapture | None = None,
                 fetch=http.fetch_gcode, upload=http.upload_diagnostics, connect=default_connect, save_config=None, loop_sleep=asyncio.sleep):
        self.cfg, self.log = cfg, log
        self.devices = devices or DeviceManager(cfg, log)
        self.camera = camera or CameraCapture(cfg.camera, log)
        self.fetch, self.upload, self.save_config, self.sleep = fetch, upload, save_config, loop_sleep
        self.server = ServerLink(cfg, log, self._on_message, self._on_connected, self._on_disconnected, connect=connect)
        self.state = "starting"
        self.link: Link | None = None
        self.banner = ""
        self.settings: dict[str, str] = {}
        self.homed = False
        self.runner: JobRunner | None = None
        self.job_id: str | None = None
        self.last_status = None
        self._results: list[dict[str, Any]] = []   # job results not yet delivered (the socket was down)
        self._loss_task: asyncio.Task | None = None
        self._loss_reason = ""
        self._stop = False
        self._loop: asyncio.AbstractEventLoop | None = None
        self._base_state = "running"
        self._busy = False
        self._tasks: set[asyncio.Task] = set()

    # ------------------------------------------------------------------ machine
    def bed(self) -> tuple[float, float]:
        return setting(self.settings, "$130") or 0.0, setting(self.settings, "$131") or 0.0

    def set_state(self, state: str, **d: Any) -> None:
        if state != self.state:
            self.log.info("state", **{"from": self.state, "to": state}, **d)
            self.state = state

    async def connect_machine(self) -> bool:
        self.set_state("connecting")
        probe = await asyncio.to_thread(self.devices.connect)
        if probe is None:
            self.set_state("disconnected", ports=self.devices.describe())
            return False
        self.link, self.banner, self.settings = Link(probe.ser, self.log), probe.banner, probe.settings
        if self.save_config:
            self.save_config()
        s30, laser = setting(self.settings, "$30"), setting(self.settings, "$32")
        self.log.info("machine_ready", port=probe.port.device, banner=self.banner, s30=s30, laser_mode=laser, bed=self.bed(), homing=self.settings.get("$22"))
        self.homed = False
        await self.restore_position()
        return True

    async def restore_position(self) -> None:
        """After start-up, a stop or an alarm the position is not trusted: home (if the machine can, and we may) before the next job."""
        if self.link is None:
            return
        homing = self.settings.get("$22", "0") not in ("0", "0.000", "")
        st = await asyncio.to_thread(self.link.status)
        in_alarm = bool(st and st.state.startswith("Alarm"))
        if not homing:
            if in_alarm:
                await asyncio.to_thread(self.link.command, "$X", 5.0)  # no homing switches: unlock, position is whatever it says
            self.homed = True
            self.set_state("idle")
            return
        if not self.cfg.auto_home:
            self.set_state("needs_home")
            return
        self.log.info("homing")
        _lines, final = await asyncio.to_thread(self.link.command, "$H", 90.0)
        if final == "ok":
            self.homed = True
            self.set_state("idle")
        else:
            self.log.error("homing_failed", answer=final)
            self.set_state("needs_attention", reason=decode(final) if final != "timeout" else "homing timed out")

    # ------------------------------------------------------------------ server messages
    async def _on_connected(self) -> None:
        if self._loss_task:
            self._loss_task.cancel()
            self._loss_task = None
        await self.send_hello()
        for r in list(self._results):  # results that could not be delivered while the socket was down
            if await self.server.send(r):
                self._results.remove(r)

    async def send_hello(self) -> None:
        await self.server.send({"type": "hello", "cutterVersion": __version__, "grblBanner": self.banner, "grblSettings": self.settings,
                                "state": self.state, "homed": self.homed, "devices": self.devices.describe(), "camera": self.camera.state, "host": platform.node()})

    def _on_disconnected(self) -> None:
        if self.runner is not None and (self._loss_task is None or self._loss_task.done()):
            self._loss_task = asyncio.get_running_loop().create_task(self._lost_server())  # called from inside the event loop

    async def _lost_server(self) -> None:
        """The Server went away during a cut: wait a short grace period for a blip, then hold and reset."""
        await self.sleep(self.cfg.ws_loss_grace_s)
        if not self.server.connected and self.runner is not None:
            self._loss_reason = "The connection to the server was lost during the cut."
            self.log.error("lost_server_during_job", job_id=self.job_id)
            self.runner.stop()

    async def _on_message(self, msg: dict[str, Any]) -> None:
        kind = msg.get("type")
        if kind == "run_job" or (kind == "control" and msg.get("command") == "frame"):
            # A job (or a frame) runs for minutes. It must not run inside the receive loop, or Stop and Pause could never be heard.
            self._spawn(self.run_job(msg) if kind == "run_job" else self.frame(msg), ack_job=str(msg.get("jobId", "")) if kind == "run_job" else None)
        elif kind == "control":
            await self.control(msg)
        else:
            self.log.warning("unknown_server_message", type=str(kind)[:32])

    def _spawn(self, coro, ack_job: str | None = None) -> None:
        if self._busy:  # one thing at a time: a second job or frame while one is starting or running is refused, not queued
            coro.close()
            self.log.warning("refused_busy", job_id=ack_job)
            if ack_job is not None:  # the Server is waiting for an answer to a run_job
                asyncio.get_running_loop().create_task(self.ack(ack_job, False, "The laser is busy."))
            return
        self._busy = True

        async def guarded() -> None:
            try:
                await coro
            except Exception as exc:  # noqa: BLE001 - never let a bug leave the laser marked busy for ever
                self.log.error("task_failed", error=f"{type(exc).__name__}: {exc}")
            finally:
                self._busy = False

        task = asyncio.get_running_loop().create_task(guarded())
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def ack(self, job_id: str, accepted: bool, reason: str = "") -> None:
        await self.server.send({"type": "ack", "jobId": job_id, "accepted": accepted, **({"reason": reason} if reason else {})})

    def ready_for_motion(self) -> str:
        if self.link is None:
            return "The laser is not connected to this PC."
        if self.runner is not None:
            return "The laser is busy."
        if self.state != "idle" or not self.homed:
            return {"needs_home": "The laser needs homing first.", "alarm": "The laser is in an alarm.", "running": "The laser is busy.", "framing": "The laser is busy.",
                    "paused": "The laser is busy."}.get(self.state, f"The laser is not ready ({self.state}).")
        if setting(self.settings, "$32") != 1:
            return "GRBL laser mode ($32) is off. A teacher must fix it before cutting."
        return ""

    async def run_job(self, msg: dict[str, Any]) -> None:
        job_id = str(msg.get("jobId", ""))
        why = self.ready_for_motion()
        if why:
            self.log.warning("job_refused", job_id=job_id, reason=why)
            return await self.ack(job_id, False, why)
        try:
            text = await asyncio.to_thread(self.fetch, self.cfg, str(msg.get("gcodeUrl", "")), msg.get("gcodeSha256"))
        except Exception as exc:  # noqa: BLE001
            self.log.error("gcode_fetch_failed", job_id=job_id, error=str(exc))
            return await self.ack(job_id, False, str(exc))
        w, h = self.bed()
        s = gcode.scan(text, bed_w=w, bed_h=h, s30_max=setting(self.settings, "$30") or 0.0, laser_mode=True)
        want = msg.get("bounds")
        got = s.cut_bounds or s.bounds
        if s.ok and want and got and any(abs(a - b) > 2.0 for a, b in zip(got, (want["minX"], want["minY"], want["maxX"], want["maxY"]))):
            s.errors.append(f"the G-code cuts {tuple(round(v, 1) for v in got)} but the server said {tuple(round(want[k], 1) for k in ('minX', 'minY', 'maxX', 'maxY'))}")
        if not s.ok:
            reason = "The Cutter's own safety check refused this job: " + "; ".join(s.errors[:3])
            self.log.error("job_refused_by_scan", job_id=job_id, errors=s.errors)
            return await self.ack(job_id, False, reason)
        await self.ack(job_id, True)
        self.log.info("job_start", job_id=job_id, lines=len(s.lines), bounds=s.bounds, material=msg.get("material"), preset_version=msg.get("presetVersion"))
        await self.start_runner(job_id, s.lines, float(msg.get("estimatedS") or 0.0), "running")

    async def start_runner(self, job_id: str, lines: list[str], estimated_s: float, state: str) -> None:
        loop = asyncio.get_running_loop()
        self.job_id, self._loss_reason, self._base_state = job_id, "", state

        def on_progress(line: int, total: int, actual: float) -> None:
            if state == "running":
                asyncio.run_coroutine_threadsafe(self.server.send({"type": "progress", "jobId": job_id, "line": line, "totalLines": total, "estimatedS": estimated_s, "actualS": actual}), loop)

        def on_state(s: str) -> None:
            if s == "Hold" and self.state in ("running", "framing"):
                loop.call_soon_threadsafe(self.set_state, "paused")

        self.runner = JobRunner(self.link, self.log, job_id, lines, estimated_s=estimated_s, on_progress=on_progress, on_state=on_state)  # type: ignore[arg-type]
        self.set_state(state)
        await self.push_status()  # busy from this instant, not from the next poll
        runner = self.runner
        ticker = asyncio.create_task(progress_ticker(runner, lambda: self.runner is runner, self.server.send, job_id, estimated_s)) if state == "running" else None
        try:
            outcome, message, actual = await asyncio.to_thread(runner.run)
        finally:
            self.runner = None
            if ticker is not None:
                ticker.cancel()
        if self._loss_reason and outcome == "cancelled":
            outcome, message = "failed", self._loss_reason
        self.log.info("job_end", job_id=job_id, outcome=outcome, message=message, actual_s=actual)
        if state == "running":
            res = {"type": "result", "jobId": job_id, "outcome": outcome, **({"message": message} if message else {}), "actualS": actual}
            if not await self.server.send({"station": self.cfg.station, **res}):
                self._results.append({"station": self.cfg.station, **res})
        self.job_id = None
        if outcome == "done":
            self.set_state("idle")
        else:  # a stop or a fault: the machine was reset, so the position is lost until it is homed again
            self.homed = False
            self.set_state("needs_home")
            await self.restore_position()

    async def control(self, msg: dict[str, Any]) -> None:
        cmd = msg.get("command")
        self.log.info("control", command=cmd)
        if cmd == "stop":
            if self.runner:
                self.runner.stop()
        elif cmd == "pause":
            if self.runner:
                self.runner.pause()
        elif cmd == "resume":
            if self.runner:
                self.runner.resume()
                if self.state == "paused":
                    self.set_state(self._base_state)
        elif cmd == "set_log_level":
            self.log.set_level(str(msg.get("level", "INFO")))
        elif cmd == "diagnostic_bundle":
            await self.send_diagnostics()
        elif cmd == "frame":
            await self.frame(msg)
        else:
            self.log.warning("unknown_control", command=str(cmd)[:32])

    async def frame(self, msg: dict[str, Any]) -> None:
        why = self.ready_for_motion()
        b = msg.get("bounds") or {}
        if why:
            return self.log.warning("frame_refused", reason=why)
        try:
            x0, y0, x1, y1 = (float(b[k]) for k in ("minX", "minY", "maxX", "maxY"))
        except (KeyError, TypeError, ValueError):
            return self.log.warning("frame_refused", reason="no bounds")
        # trace the outline with the laser OFF (M5, rapids only), then come back to the start
        text = "\n".join(["G21", "G90", "M5", f"G0 X{x0:.3f} Y{y0:.3f}", f"G0 X{x1:.3f} Y{y0:.3f}", f"G0 X{x1:.3f} Y{y1:.3f}", f"G0 X{x0:.3f} Y{y1:.3f}", f"G0 X{x0:.3f} Y{y0:.3f}"])
        w, h = self.bed()
        s = gcode.scan(text, bed_w=w, bed_h=h, s30_max=setting(self.settings, "$30") or 0.0)
        if not s.ok:
            return self.log.error("frame_refused", reason="; ".join(s.errors))
        self.log.info("frame_start", job_id=msg.get("jobId"), bounds=b)
        await self.start_runner(str(msg.get("jobId") or "frame"), s.lines, 0.0, "framing")

    async def send_diagnostics(self) -> None:
        net = await asyncio.to_thread(bundle.network_test, self.cfg)
        data = bundle.build(self.cfg, self.log, banner=self.banner, settings=self.settings, devices=self.devices.describe(), camera_state=self.camera.state, state=self.state, network=net)
        try:
            await asyncio.to_thread(self.upload, self.cfg, data)
            self.log.info("diagnostics_uploaded", bytes=len(data))
        except Exception as exc:  # noqa: BLE001
            self.log.error("diagnostics_upload_failed", error=str(exc))

    # ------------------------------------------------------------------ background tasks
    def reported_state(self, grbl_state: str, sub: int | None = None) -> str:
        """What the Server is told. While we are streaming a job or tracing a frame the laser is BUSY, even in the instant GRBL's buffer is empty
        between two lines, so the Server never thinks it is Idle and lets a second job start on top."""
        if self.state == "framing" and grbl_state.startswith("Idle"):
            return "Jog"
        if self.state == "running" and grbl_state.startswith("Idle"):
            return "Run"
        return grbl_state if sub is None else f"{grbl_state}:{sub}"

    async def push_status(self) -> None:
        st = self.last_status
        msg: dict[str, Any] = {"type": "status", "state": self.reported_state(st.state if st else "Idle", st.sub if st else None)}
        if st and st.position and len(st.position) == 3:
            msg["mpos"] = st.position
        await self.server.send(msg)

    async def status_loop(self) -> None:
        while not self._stop:
            await self.sleep(0.5 if self.state in ("running", "framing", "paused") else 2.0)
            if self.link is None or not self.server.connected:
                continue
            try:
                st = await asyncio.to_thread(self.link.status, 1.0)
            except Exception as exc:  # noqa: BLE001 - the port is gone
                self.log.error("serial_lost", error=f"{type(exc).__name__}: {exc}")
                await self.machine_lost()
                continue
            if st is None:
                continue
            self.last_status = st
            if st.state.startswith("Alarm") and self.state == "idle":
                self.homed = False
                self.set_state("alarm")
                await self.restore_position()
            await self.push_status()

    async def machine_lost(self) -> None:
        try:
            if self.link:
                self.link.ser.close()
        except Exception:  # noqa: BLE001
            pass
        self.link, self.homed = None, False
        self.set_state("disconnected")

    async def machine_loop(self) -> None:
        while not self._stop:
            if self.link is None:
                if not await self.connect_machine():
                    await self.sleep(5.0)
                    continue
                await self.send_hello()
            await self.sleep(1.0)

    async def camera_loop(self) -> None:
        last = -1
        interval = 1.0 / max(0.2, float(self.cfg.camera.get("fps", 2.0)))
        while not self._stop:
            await self.sleep(interval)
            got = self.camera.latest()
            if got and got[0] != last and self.server.connected:
                last = got[0]
                await self.server.send({"type": "camera", "jpegBase64": base64.b64encode(got[1]).decode()})  # never queued: a slow link just drops frames

    async def logs_loop(self) -> None:
        while not self._stop:
            await self.sleep(2.0)
            if not self.server.connected:
                continue
            lines = self.log.drain(200)
            if lines and not await self.server.send({"type": "logs", "lines": lines}):
                self.log.requeue(lines)

    async def run(self) -> None:
        self._loop = asyncio.get_running_loop()
        self.log.add_secret(self.cfg.token)
        self.log.info("cutter_start", version=__version__, station=self.cfg.station, server=self.cfg.server_url, platform=platform.platform(), config=self.cfg.redacted())
        self.camera.start()
        tasks = [asyncio.create_task(c) for c in (self.server.run(), self.machine_loop(), self.status_loop(), self.camera_loop(), self.logs_loop())]
        try:
            await asyncio.gather(*tasks)
        finally:
            self._stop = True
            if self.runner:
                self.runner.stop()  # leaving mid-cut: hold and reset
            self.camera.stop()
            for t in tasks:
                t.cancel()
