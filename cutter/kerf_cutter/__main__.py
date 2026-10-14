"""python -m kerf_cutter [--url URL --token TOKEN --station ID] [--devices] [--diag] [--config cutter.json]

First run: give --url, --token and --station once; they are saved in cutter.json (next to this program) and used from then on.
--devices  list the serial ports, probe which one is the laser, and remember it (use --assign COM5 to choose by hand).
--diag     write a diagnostic bundle (logs, settings, ports, network test; no token, no pictures) to diag-<time>.zip and exit."""
from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import datetime
from pathlib import Path

from . import __version__
from . import config as cfgmod
from .devices.manager import DeviceManager
from .devices.ports import PortInfo
from .diag import bundle
from .logs import CutterLog
from .station import Station


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="kerf_cutter", description=__doc__.splitlines()[0])
    ap.add_argument("--config", default=cfgmod.DEFAULT_PATH, help="settings file (default cutter.json beside the program)")
    ap.add_argument("--url", help="the Kerf Server's address, e.g. http://192.168.1.20:8000 (saved)")
    ap.add_argument("--token", help="this laser's station token (saved; never logged)")
    ap.add_argument("--station", help="this laser's ID, e.g. station-1 (saved)")
    ap.add_argument("--devices", action="store_true", help="list serial ports, find the laser, remember it")
    ap.add_argument("--assign", metavar="PORT", help="with --devices: use this port, e.g. COM5")
    ap.add_argument("--diag", action="store_true", help="write a diagnostic bundle and exit")
    ap.add_argument("--version", action="version", version=f"kerf-cutter {__version__}")
    return ap


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    path = Path(args.config)
    cfg = cfgmod.load(path)
    changed = False
    for attr, val in (("server_url", args.url), ("token", args.token), ("station", args.station)):
        if val and getattr(cfg, attr) != val:
            setattr(cfg, attr, val)
            changed = True
    if changed or not path.exists():
        cfgmod.save(cfg, path)
    log = CutterLog(path.resolve().parent / "logs", cfg.station, cfg.log_level)
    log.add_secret(cfg.token)
    try:
        if args.devices:
            return devices(cfg, log, path, args.assign)
        if args.diag:
            out = path.resolve().parent / f"diag-{datetime.now().strftime('%Y%m%d-%H%M%S')}.zip"
            out.write_bytes(bundle.build(cfg, log))
            print(f"Wrote {out}")
            return 0
        if not cfg.token:
            print("No token yet. Run once with: --url http://SERVER:8000 --token ks_... --station station-1", file=sys.stderr)
            return 2
        station = Station(cfg, log, save_config=lambda: cfgmod.save(cfg, path))
        print(f"BISAK Kerf Cutter {__version__}: {cfg.station} -> {cfg.server_url}   (Ctrl+C to stop; a cut in progress is held and reset)")
        try:
            asyncio.run(station.run())
        except KeyboardInterrupt:
            pass
        return 0
    finally:
        log.close()


def devices(cfg, log, path: Path, assign: str | None) -> int:
    mgr = DeviceManager(cfg, log)
    ports = mgr.list_ports()
    print(f"{len(ports)} serial port(s):")
    for p in ports:
        print(f"  {p.device:8} {p.description}  [VID {p.vid} PID {p.pid} location {p.location}]")
    if assign:
        match = next((p for p in ports if p.device.lower() == assign.lower()), PortInfo(assign))
        pr = mgr.probe(match)
        print(f"  {assign}: {pr.state} {pr.message or pr.banner}")
        if pr.state != "grbl":
            return 1
        cfg.machine = {"vid": match.vid, "pid": match.pid, "location": match.location, "lastPort": match.device}
        cfgmod.save(cfg, path)
        print(f"Saved: the laser is on {match.device}.")
        return 0
    pr = mgr.connect()
    for r in mgr.last:
        print(f"  {r.port.device}: {r.state} {r.message or r.banner}")
    if pr is None:
        print("No laser found. Check the USB cable, and that LightBurn/LaserGRBL are closed. Use --assign PORT to choose by hand.")
        return 1
    try:
        pr.ser.close()
    except Exception:  # noqa: BLE001
        pass
    cfgmod.save(cfg, path)
    print(f"Found the laser on {pr.port.device} ({pr.banner}). Saved.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
