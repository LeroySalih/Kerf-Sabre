"""A pretend Cutter for trying the whole flow (Editor, queue, Station mode) without a laser.

    python -m kerf_server.devtools.fake_cutter --url http://localhost:8000 --token ks_... --station station-1
    python fake_cutter.py --url http://localhost:8000 --token ks_... --station station-1     (the downloaded copy; needs `pip install websockets`)

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
from pathlib import Path
import time
import urllib.request


async def run(args: argparse.Namespace) -> None:
    import websockets  # installed with uvicorn[standard]

    def say(text: str) -> None:
        print(f"{time.strftime('%H:%M:%S')}.{int(time.time() * 1000) % 1000:03d} {text}", flush=True)

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
            req = urllib.request.Request(base + path, headers={"Authorization": f"Bearer {args.token}", "User-Agent": "kerf-practice-cutter"})  # Cloudflare answers 403 to the default Python-urllib agent
            return urllib.request.urlopen(req).read().decode()

        async def cut(msg: dict) -> None:
            job_id = msg["jobId"]
            try:
                text = await asyncio.get_running_loop().run_in_executor(None, fetch_gcode, msg["gcodeUrl"])
            except Exception as exc:
                await send({"type": "ack", "jobId": job_id, "accepted": False, "reason": f"could not download the G-code: {exc}"})
                return
            gcode_lines = [ln for ln in text.splitlines() if ln.strip()]
            lines = text.count("\n")
            say(f"downloaded the G-code for {job_id}: {len(gcode_lines)} lines")
            await send({"type": "ack", "jobId": job_id, "accepted": True})
            state.update(state="Run", job=job_id, paused=False, stop=False)
            total_s = max(msg.get("estimatedS") or 5.0, 1.0) / args.speed
            t0, done_s = time.time(), 0.0
            print(f"[fake cutter] cutting {job_id}: {lines} lines, ~{total_s:.0f}s")
            shown = 0
            while done_s < total_s and not state["stop"]:
                await asyncio.sleep(0.5)
                upto = int(len(gcode_lines) * min((done_s + 0.5) / total_s, 1)) if not state["paused"] else shown
                for ln in gcode_lines[shown:upto]:
                    say(f"TX {ln}")  # what the real Cutter would send to the laser
                    say("RX ok")
                shown = max(shown, upto)
                if not state["paused"]:
                    done_s += 0.5
                await send({"type": "progress", "jobId": job_id, "line": int(lines * min(done_s / total_s, 1)), "totalLines": lines,
                            "estimatedS": total_s, "actualS": round(done_s, 1)})
            outcome = "cancelled" if state["stop"] else "done"
            if outcome == "done":
                cut_done["yes"] = True
            await send({"type": "result", "jobId": job_id, "outcome": outcome, "actualS": round(time.time() - t0, 1)})
            state.update(state="Idle", job=None, paused=False)
            print(f"[fake cutter] {job_id} {outcome}")

        def load(name: str) -> str:
            return base64.b64encode((Path(__file__).resolve().parent / name).read_bytes()).decode()

        pictures = {"plain": load("fake_bed.jpg"), "marked": load("fake_bed_marked.jpg") if args.marks_after_cut else ""}
        cut_done = {"yes": False}

        async def camera() -> None:
            while True:
                await send({"type": "camera", "jpegBase64": pictures["marked"] if cut_done["yes"] and pictures["marked"] else pictures["plain"]})
                await asyncio.sleep(1)

        cam = asyncio.create_task(camera())
        hb = asyncio.create_task(heartbeat())
        try:
            async for raw in ws:
                msg = json.loads(raw)
                say("SERVER -> " + json.dumps({k: v for k, v in msg.items() if k != "gcode"})[:300])
                if msg.get("type") == "run_job":
                    asyncio.create_task(cut(msg))
                elif msg.get("type") == "control":
                    cmd = msg.get("command")
                    print(f"[fake cutter] control: {cmd}")
                    if cmd == "frame":
                        b = msg["bounds"]
                        state["state"] = "Jog"  # tracing the outline with the laser off
                        for cmd_line in ("G21", "G90", f"G0 X{b['minX']:g} Y{b['minY']:g} S0", f"G0 X{b['maxX']:g} Y{b['minY']:g} S0", f"G0 X{b['maxX']:g} Y{b['maxY']:g} S0", f"G0 X{b['minX']:g} Y{b['maxY']:g} S0", f"G0 X{b['minX']:g} Y{b['minY']:g} S0"):
                            say(f"TX {cmd_line}")
                            say("RX ok")
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
    ap.add_argument("--marks-after-cut", action="store_true", help="after the first cut, send a camera picture that shows four 40 mm squares scored at bed (140,140), (260,140), (140,260), (260,260) (for trying or documenting camera calibration)")
    args = ap.parse_args()
    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        pass
    except Exception as exc:  # the server closes with 4000 when another Cutter connects as the same laser
        code = getattr(getattr(exc, "rcvd", None), "code", None)
        if code == 4000:
            raise SystemExit(f"[fake cutter] Another Cutter connected as {args.station} and replaced this one. Only one Cutter can run per laser: close the other one (an older Terminal window, or the real Cutter), then start this again.")
        if code == 4001:
            raise SystemExit(f"[fake cutter] {args.station} was disconnected from the Station page. Start this again to reconnect.")
        if code == 4403:
            raise SystemExit(f"[fake cutter] This token belongs to a different laser than {args.station}. Make a token for {args.station}: Admin > Stations > Cutter software, choose {args.station}.")
        if code == 4401:
            raise SystemExit("[fake cutter] The server refused the token. Download a new Cutter from Admin > Stations > Cutter software.")
        raise


if __name__ == "__main__":
    main()
