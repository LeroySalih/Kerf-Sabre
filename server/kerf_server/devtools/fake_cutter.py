"""A pretend Cutter for trying the whole flow (Editor, queue, Station mode) without a laser.

    python -m kerf_server.devtools.fake_cutter --url http://localhost:8000 --token ks_... --station station-1

It connects like the real Cutter will (outbound WebSocket, station token), reports GRBL-style status, answers frame and
run_job, "cuts" for the job's estimated time (sped up with --speed) while reporting progress, and obeys stop/pause/resume.
It also sends a test camera picture (`fake_bed.jpg`, once a second): a 640x480 view of a 400x400 mm bed whose corners
(0,0), (400,0), (400,400), (0,400) are at camera pixels (110,430), (540,425), (500,40), (150,45), so camera calibration and
design placement can be tried without a camera. It never touches a serial port. The head position it reports (`--x`, `--y`) is where `current-position` jobs get placed.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
from importlib import resources
import time
import urllib.request


async def run(args: argparse.Namespace) -> None:
    import websockets  # installed with uvicorn[standard]

    base = args.url.rstrip("/")
    ws_url = base.replace("http", "ws", 1) + "/api/v1/ws/cutter"
    state = {"state": "Idle", "job": None, "paused": False, "stop": False}
    head = [args.x, args.y, 0.0]

    async with websockets.connect(ws_url, additional_headers={"Authorization": f"Bearer {args.token}"}, max_size=2**22) as ws:
        async def send(msg: dict) -> None:
            await ws.send(json.dumps({"station": args.station, **msg}))

        await send({"type": "hello", "cutterVersion": "fake-0", "grblBanner": "Grbl 1.1h (fake)", "grblSettings": {"$30": str(args.s30), "$32": "1"}})
        print(f"[fake cutter] {args.station} connected to {ws_url}")

        async def heartbeat() -> None:
            while True:
                await send({"type": "status", "state": state["state"], "mpos": head})
                await asyncio.sleep(1)

        def fetch_gcode(path: str) -> str:
            req = urllib.request.Request(base + path, headers={"Authorization": f"Bearer {args.token}"})
            return urllib.request.urlopen(req).read().decode()

        async def cut(msg: dict) -> None:
            job_id = msg["jobId"]
            try:
                text = await asyncio.get_running_loop().run_in_executor(None, fetch_gcode, msg["gcodeUrl"])
            except Exception as exc:
                await send({"type": "ack", "jobId": job_id, "accepted": False, "reason": f"could not download the G-code: {exc}"})
                return
            lines = text.count("\n")
            await send({"type": "ack", "jobId": job_id, "accepted": True})
            state.update(state="Run", job=job_id, paused=False, stop=False)
            total_s = max(msg.get("estimatedS") or 5.0, 1.0) / args.speed
            t0, done_s = time.time(), 0.0
            print(f"[fake cutter] cutting {job_id}: {lines} lines, ~{total_s:.0f}s")
            while done_s < total_s and not state["stop"]:
                await asyncio.sleep(0.5)
                if not state["paused"]:
                    done_s += 0.5
                await send({"type": "progress", "jobId": job_id, "line": int(lines * min(done_s / total_s, 1)), "totalLines": lines,
                            "estimatedS": total_s, "actualS": round(done_s, 1)})
            outcome = "cancelled" if state["stop"] else "done"
            await send({"type": "result", "jobId": job_id, "outcome": outcome, "actualS": round(time.time() - t0, 1)})
            state.update(state="Idle", job=None, paused=False)
            print(f"[fake cutter] {job_id} {outcome}")

        picture = base64.b64encode(resources.files("kerf_server.devtools").joinpath("fake_bed.jpg").read_bytes()).decode()

        async def camera() -> None:
            while True:
                await send({"type": "camera", "jpegBase64": picture})
                await asyncio.sleep(1)

        cam = asyncio.create_task(camera())
        hb = asyncio.create_task(heartbeat())
        try:
            async for raw in ws:
                msg = json.loads(raw)
                if msg.get("type") == "run_job":
                    asyncio.create_task(cut(msg))
                elif msg.get("type") == "control":
                    cmd = msg.get("command")
                    print(f"[fake cutter] control: {cmd}")
                    if cmd == "frame":
                        b = msg["bounds"]
                        state["state"] = "Jog"  # tracing the outline with the laser off
                        await asyncio.sleep(args.frame_s)
                        state["state"] = "Idle"
                    elif cmd == "stop":
                        state["stop"] = True
                    elif cmd == "pause":
                        state["paused"], state["state"] = True, "Hold"
                    elif cmd == "resume":
                        state["paused"], state["state"] = False, "Run"
        finally:
            hb.cancel()
            cam.cancel()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--url", default="http://localhost:8000")
    ap.add_argument("--token", required=True, help="a station token (kerf-admin create-token --role station --id station-1)")
    ap.add_argument("--station", default="station-1")
    ap.add_argument("--speed", type=float, default=10.0, help="cut this many times faster than the estimate")
    ap.add_argument("--s30", type=int, default=1000, help="the $30 value to report; must match the machine profile")
    ap.add_argument("--x", type=float, default=100.0, help="head position X to report (mm)")
    ap.add_argument("--y", type=float, default=100.0, help="head position Y to report (mm)")
    ap.add_argument("--frame-s", type=float, default=2.0, help="how long framing takes")
    asyncio.run(run(ap.parse_args()))


if __name__ == "__main__":
    main()
