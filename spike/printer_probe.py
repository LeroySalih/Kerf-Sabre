#!/usr/bin/env python3
"""Spike 3: can a school PC reach a 3D printer's Moonraker (Creality K1 with Klipper) over the network?

Python 3.8+ standard library only (nothing to install). Run on a school PC on the same network as the printer:

    python printer_probe.py --host 192.168.68.105                    # read-only: status, temperatures, files, cameras
    python printer_probe.py --host 192.168.68.105 --upload test.gcode # also uploads a file (does not print it)
    python printer_probe.py --host 192.168.68.105 --upload test.gcode --start   # uploads and starts it (asks first)

Nothing moves and nothing heats unless --start is given and the operator types "yes" after checking the bed is clear.
Every request and answer is written to output/printer_<time>/ (session.log, report.json) and zipped, so the result can be
sent back as one file. Pupil names are never involved; no camera pictures are saved, only whether a stream answers.
"""
from __future__ import annotations

import argparse
import json
import platform
import socket
import sys
import time
import traceback
import urllib.error
import urllib.request
import uuid
import zipfile
from pathlib import Path

TIMEOUT_S = 8


class Probe:
    def __init__(self, host: str, port: int, out: Path) -> None:
        self.base = f"http://{host}:{port}"
        self.host = host
        self.out = out
        self.report: dict = {"host": host, "port": port, "started": time.strftime("%Y-%m-%d %H:%M:%S"), "pc": platform.node(),
                             "python": sys.version.split()[0], "os": platform.platform(), "checks": []}
        self.log = open(out / "session.log", "w", encoding="utf-8")

    def say(self, text: str) -> None:
        line = f"{time.strftime('%H:%M:%S')} {text}"
        print(line, flush=True)
        self.log.write(line + "\n")
        self.log.flush()

    def check(self, name: str, ok: bool, detail: str = "", data=None) -> bool:
        self.report["checks"].append({"name": name, "ok": ok, "detail": detail, "data": data})
        self.say(f"{'PASS' if ok else 'FAIL'}  {name}{': ' + detail if detail else ''}")
        self.save()
        return ok

    def save(self) -> None:
        (self.out / "report.json").write_text(json.dumps(self.report, indent=2, default=str), encoding="utf-8")

    def request(self, method: str, path: str, body: bytes | None = None, headers: dict | None = None, timeout: float = TIMEOUT_S):
        url = self.base + path
        self.say(f"-> {method} {path}{f' ({len(body)} bytes)' if body else ''}")
        req = urllib.request.Request(url, data=body, method=method, headers={"User-Agent": "kerf-printer-probe", **(headers or {})})
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                status = r.status
        except urllib.error.HTTPError as e:
            raw, status = e.read(), e.code
        ms = int((time.time() - t0) * 1000)
        text = raw.decode("utf-8", errors="replace")
        self.say(f"<- {status} in {ms} ms: {text[:400]}")
        try:
            return status, json.loads(text)
        except ValueError:
            return status, text

    # ---- the checks

    def tcp(self) -> bool:
        try:
            with socket.create_connection((self.host, int(self.base.rsplit(':', 1)[1])), timeout=TIMEOUT_S):
                return self.check("network: the PC reaches the printer's Moonraker port", True)
        except OSError as e:
            return self.check("network: the PC reaches the printer's Moonraker port", False,
                              f"{e}. Check the IP address, that this PC is on the printer's network, and that the school network does not block devices from each other.")

    def info(self) -> None:
        s, j = self.request("GET", "/printer/info")
        r = j.get("result", {}) if isinstance(j, dict) else {}
        self.check("Moonraker answers /printer/info", s == 200, f"state={r.get('state')} klipper={r.get('software_version')} host={r.get('hostname')}", r)
        s, j = self.request("GET", "/server/info")
        r = j.get("result", {}) if isinstance(j, dict) else {}
        self.check("Moonraker /server/info", s == 200, f"moonraker={r.get('moonraker_version')} klippy={r.get('klippy_state')}", r)

    def status(self) -> None:
        s, j = self.request("GET", "/printer/objects/query?print_stats&extruder&heater_bed&toolhead&virtual_sdcard&display_status")
        st = j.get("result", {}).get("status", {}) if isinstance(j, dict) else {}
        ps, ex, bed, th = st.get("print_stats", {}), st.get("extruder", {}), st.get("heater_bed", {}), st.get("toolhead", {})
        self.check("status: print state, temperatures, build volume", s == 200,
                   f"print={ps.get('state')} nozzle={ex.get('temperature')}C bed={bed.get('temperature')}C homed={th.get('homed_axes')!r} "
                   f"min={th.get('axis_minimum')} max={th.get('axis_maximum')}", st)

    def files(self) -> None:
        s, j = self.request("GET", "/server/files/list?root=gcodes")
        files = j.get("result", []) if isinstance(j, dict) else []
        self.check("files: list the G-code files on the printer", s == 200, f"{len(files)} file(s)", [f.get("path") for f in files][:50])

    def cameras(self) -> None:
        s, j = self.request("GET", "/server/webcams/list")
        cams = j.get("result", {}).get("webcams", []) if isinstance(j, dict) else []
        self.check("cameras: configured in Moonraker", s == 200, f"{len(cams)} camera(s)", cams)
        for full in self.camera_urls(cams):
            try:
                with urllib.request.urlopen(urllib.request.Request(full, headers={"User-Agent": "kerf-printer-probe"}), timeout=TIMEOUT_S) as r:
                    head = r.read(4)
                    ok = head[:2] == b"\xff\xd8"
                self.check(f"camera picture from {full}", ok, "a JPEG came back (not saved)" if ok else f"not a JPEG ({head!r})")
                return
            except Exception as e:  # noqa: BLE001
                self.check(f"camera picture from {full}", False, f"{type(e).__name__}: {e}")

    def camera_urls(self, cams: list) -> list[str]:
        """Where a still picture might be: what Moonraker lists (a path is served by Fluidd's web server on 4408), then the K1's usual stream port."""
        urls = []
        for c in cams:
            u = c.get("snapshot_url") or ""
            if u.startswith("http"):
                urls.append(u)
            elif u.startswith("/"):
                urls.append(f"http://{self.host}:4408{u}")
        urls.append(f"http://{self.host}:8080/?action=snapshot")
        return list(dict.fromkeys(urls))

    def upload(self, path: Path, start: bool) -> None:
        data = path.read_bytes()
        name = f"kerf-probe-{path.name}"
        boundary = uuid.uuid4().hex
        body = b"".join([
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"root\"\r\n\r\ngcodes\r\n".encode(),
            *([f"--{boundary}\r\nContent-Disposition: form-data; name=\"print\"\r\n\r\ntrue\r\n".encode()] if start else []),
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\nContent-Type: application/octet-stream\r\n\r\n".encode(),
            data, f"\r\n--{boundary}--\r\n".encode(),
        ])
        s, j = self.request("POST", "/server/files/upload", body, {"Content-Type": f"multipart/form-data; boundary={boundary}"}, timeout=120)
        r = j.get("result", j) if isinstance(j, dict) else j
        self.check(f"upload {path.name} ({len(data)} bytes){' and start it' if start else ''}", s in (200, 201), json.dumps(r)[:300], r)
        if start and s in (200, 201):
            for _ in range(10):
                time.sleep(3)
                s2, j2 = self.request("GET", "/printer/objects/query?print_stats&display_status")
                ps = j2.get("result", {}).get("status", {}).get("print_stats", {}) if isinstance(j2, dict) else {}
                if ps.get("state") in ("printing", "error", "complete"):
                    break
            self.check("the printer reports the print started", ps.get("state") == "printing", f"print_stats.state={ps.get('state')} file={ps.get('filename')}", ps)
            self.say("The print is running. Cancel it from the printer's screen or Fluidd if this was only a test.")

    def close(self) -> Path:
        self.report["finished"] = time.strftime("%Y-%m-%d %H:%M:%S")
        self.report["passed"] = sum(c["ok"] for c in self.report["checks"])
        self.report["failed"] = sum(not c["ok"] for c in self.report["checks"])
        self.save()
        self.say(f"Done: {self.report['passed']} passed, {self.report['failed']} failed.")
        self.log.close()
        zpath = self.out.with_suffix(".zip")
        with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
            for f in self.out.iterdir():
                z.write(f, f"{self.out.name}/{f.name}")
        return zpath


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--host", required=True, help="the printer's IP address, e.g. 192.168.68.105")
    ap.add_argument("--port", type=int, default=7125, help="Moonraker's port (default 7125)")
    ap.add_argument("--upload", type=Path, help="a small .gcode file to upload (it is NOT printed unless --start is also given)")
    ap.add_argument("--start", action="store_true", help="start printing the uploaded file (asks you to confirm the bed is clear)")
    ap.add_argument("--out", type=Path, default=Path("output"), help="where the results folder and zip go")
    args = ap.parse_args(argv)
    out = args.out / f"printer_{time.strftime('%Y%m%d-%H%M%S')}"
    out.mkdir(parents=True, exist_ok=True)
    p = Probe(args.host, args.port, out)
    try:
        if p.tcp():
            p.info()
            p.status()
            p.files()
            p.cameras()
            if args.upload:
                start = False
                if args.start:
                    answer = input("The printer will heat up and start printing. Is the bed clear and filament loaded? Type yes: ").strip().lower()
                    p.say(f"operator answered {answer!r}")
                    start = answer == "yes"
                p.upload(args.upload, start)
    except KeyboardInterrupt:
        p.say("stopped by the operator (Ctrl-C)")
    except Exception:  # noqa: BLE001 - the report must still be written
        p.say("ERROR\n" + traceback.format_exc())
    print(f"\nResults: {p.close()}  (send this zip back)")
    return 0 if p.report.get("failed", 1) == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
