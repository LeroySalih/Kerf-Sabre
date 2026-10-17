#!/usr/bin/env python3
"""Kerf Spike 2: find out how a station's laser (GCC Mercury III, probably a Ruida controller, driven by Techsoft 2D Design) is connected.

READ-ONLY. It never sends anything to the laser, never moves it and never fires it. It only asks Windows what is plugged in and
installed, and asks the operator to unplug and replug the laser's USB cable so the laser's own device can be told apart from the
rest. Everything is written to output/<station>_<time>/ and zipped, like spike.py. Needs no install and no administrator rights.

Run it with run_mercury_probe.bat (or `python mercury_probe.py`). It reuses SessionLog and bundle() from spike.py (same folder).
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

try:
    from spike import SessionLog, bundle, utc_now
except ImportError:  # run from another folder: find spike.py next to this file
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from spike import SessionLog, bundle, utc_now  # type: ignore[no-redef]

PROBE_VERSION = "0.1.0"
IS_WINDOWS = os.name == "nt"
#: Words that mark software, services and folders that may drive or configure this laser.
KEYWORDS = ("techsoft", "2d design", "2ddesign", "gcc", "laserpro", "mercury", "ruida", "rdworks", "rd works", "lightburn",
            "lasergrbl", "lasercut", "smartcut", "meerk40t", "k40", "thunderlaser", "cutter")
CONFIG_EXT = (".ini", ".cfg", ".config", ".xml", ".json", ".txt")
MAX_CONFIG_BYTES = 100_000
MAX_CONFIG_FILES = 40
PASS, FAIL, SKIPPED = "ok", "error", "skipped"


def default_run(cmd: list[str], timeout: float = 30.0) -> str:
    """Run a command and return its text output (decoded leniently). Raises on a missing program or a timeout."""
    out = subprocess.run(cmd, capture_output=True, timeout=timeout, check=False)
    return (out.stdout or b"").decode("utf-8", "replace") + (out.stderr or b"").decode("utf-8", "replace")


def powershell_json(script: str, run=default_run) -> list[dict]:
    """Run a PowerShell snippet that ends in `| ConvertTo-Json` and return a list of dicts (PowerShell returns one object unwrapped)."""
    prefix = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ErrorActionPreference='SilentlyContinue'; "
    text = run(["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", prefix + script]).strip()
    if not text:
        return []
    data = json.loads(text)
    return data if isinstance(data, list) else [data]


def default_list_ports() -> list[dict]:
    from serial.tools import list_ports

    return [{"device": p.device, "description": p.description, "vid": p.vid, "pid": p.pid, "serial": p.serial_number, "hwid": p.hwid,
             "location": p.location} for p in list_ports.comports()]


def matches(*texts: object) -> bool:
    blob = " ".join(str(t or "") for t in texts).lower()
    return any(k in blob for k in KEYWORDS)


def usb_key(d: dict) -> str:
    return str(d.get("PNPDeviceID") or d.get("id") or "")


def diff_devices(before: list[dict], after: list[dict], key=usb_key) -> dict[str, list[dict]]:
    """Which devices appeared and which went away between two snapshots."""
    b, a = {key(d): d for d in before}, {key(d): d for d in after}
    return {"gone": [b[k] for k in b if k not in a], "new": [a[k] for k in a if k not in b]}


def interpret(usb_gone: list[dict], ports_gone: list[dict], printers: list[dict], software: list[dict]) -> list[str]:
    """Plain-language reading of what was found, to steer the next spike. These are hints, not conclusions."""
    notes: list[str] = []
    if not usb_gone and not ports_gone:
        notes.append("Unplugging the laser's USB cable changed nothing Windows could see. Either the cable was not the one in use, the laser was already "
                     "unplugged, or it is connected another way (network or printer port). Check the answers and the printer list.")
    for d in usb_gone:
        svc = str(d.get("Service") or "").lower()
        name = d.get("Name") or d.get("PNPDeviceID")
        if svc in ("usbser", "ch341ser", "ch341ser_a64", "ch341ser_a", "silabser", "ftdibus", "ftser2k", "cp210x"):
            notes.append(f"The laser's USB device ({name}) uses the serial driver '{svc}': Windows gives it a COM port, so a serial probe is possible.")
        elif svc in ("winusb", "libusb0", "libusbk", "usbccgp") or "winusb" in svc:
            notes.append(f"The laser's USB device ({name}) uses '{svc}': Python can talk to it directly over USB (pyusb) without a driver change.")
        elif svc:
            notes.append(f"The laser's USB device ({name}) uses the vendor driver '{svc}'. Python cannot reach it without that driver's own DLL, or a driver swap "
                         "(which needs administrator rights). The Cutter may have to go through the vendor software or drivers instead.")
        else:
            notes.append(f"The laser's USB device ({name}) has no driver service listed (not installed or not working).")
        if d.get("ConfigManagerErrorCode"):
            notes.append(f"Windows reports a problem with that device (error code {d['ConfigManagerErrorCode']}).")
    for p in ports_gone:
        notes.append(f"A COM port disappeared with the cable: {p.get('device')} ({p.get('description')}).")
    gcc = [p for p in printers if matches(p.get("Name"), p.get("DriverName"), p.get("PortName"))]
    if gcc:
        notes.append("A printer entry looks laser-related (" + "; ".join(f"{p.get('Name')} / driver {p.get('DriverName')} / port {p.get('PortName')}" for p in gcc)
                     + "). Techsoft 2D Design may send jobs through that Windows driver, which is a different route from G-code.")
    if software:
        notes.append("Laser-related software installed: " + ", ".join(sorted({str(s.get('DisplayName')) for s in software})) + ".")
    return notes


class Probe:
    def __init__(self, args, out_dir: Path, *, run=default_run, list_ports=default_list_ports, prompt=input, say=print, sleep=time.sleep,
                 windows: bool = IS_WINDOWS):
        self.args, self.out_dir = args, out_dir
        self.run, self.list_ports, self._prompt, self._say, self.sleep, self.windows = run, list_ports, prompt, say, sleep, windows
        self.session: SessionLog | None = None
        self.steps: list[dict] = []
        self.data: dict = {}

    # ---- screen and keyboard, both recorded
    def say(self, text: str = "") -> None:
        if self.session:
            self.session.write("SAY", text)
        try:
            self._say(text)
        except UnicodeEncodeError:
            self._say(str(text).encode("ascii", "replace").decode())

    def ask(self, question: str) -> str:
        if self.session:
            self.session.write("SAY", question)
        answer = self._prompt(question)
        if self.session:
            self.session.write("IN", answer)
        return answer

    def step(self, name: str, fn, *, needs_windows: bool = False):
        """Run one probe step. A failure is recorded and never stops the others."""
        rec = {"step": name, "status": PASS, "seconds": 0.0}
        t0 = time.monotonic()
        self.say(f"\n--- {name} ---")
        if self.session:
            self.session.event("step_start", step=name)
        try:
            if needs_windows and not self.windows:
                rec["status"], rec["note"] = SKIPPED, "not Windows"
                result = None
            else:
                result = fn()
                self.data[name] = result
        except Exception as exc:  # noqa: BLE001
            rec["status"], rec["note"] = FAIL, f"{type(exc).__name__}: {exc}"
            result = None
            if self.session:
                self.session.error(f"step {name} failed", exc)
        rec["seconds"] = round(time.monotonic() - t0, 2)
        self.steps.append(rec)
        if self.session:
            self.session.event("step_end", **rec)
        self.say(f"    -> {rec['status']}" + (f" ({rec['note']})" if rec.get("note") else ""))
        return result

    # ---- snapshots
    def usb(self) -> list[dict]:
        return powershell_json("Get-CimInstance Win32_PnPEntity | Where-Object { $_.PNPDeviceID -like 'USB*' -or $_.PNPDeviceID -like 'FTDIBUS*' } | "
                               "Select-Object Name, Manufacturer, PNPClass, PNPDeviceID, Service, Status, ConfigManagerErrorCode | ConvertTo-Json -Depth 3", self.run)

    def ports(self) -> list[dict]:
        return self.list_ports()

    def printers(self) -> list[dict]:
        return powershell_json("Get-CimInstance Win32_Printer | Select-Object Name, DriverName, PortName, Local, Network, WorkOffline, PrinterStatus | ConvertTo-Json", self.run)

    def printer_drivers(self) -> list[dict]:
        return powershell_json("Get-CimInstance Win32_PrinterDriver | Select-Object Name, SupportedPlatform, Version | ConvertTo-Json", self.run)

    def software(self) -> list[dict]:
        script = ("$k='HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',"
                  "'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'; Get-ItemProperty $k | Where-Object { $_.DisplayName } | "
                  "Select-Object DisplayName, DisplayVersion, Publisher, InstallLocation | ConvertTo-Json")
        return powershell_json(script, self.run)

    def processes(self) -> list[dict]:
        rows = powershell_json("Get-Process | Select-Object ProcessName, Id, Path | ConvertTo-Json", self.run)
        return [r for r in rows if matches(r.get("ProcessName"), r.get("Path"))]

    def services(self) -> list[dict]:
        rows = powershell_json("Get-CimInstance Win32_Service | Select-Object Name, DisplayName, State, PathName | ConvertTo-Json", self.run)
        return [r for r in rows if matches(r.get("Name"), r.get("DisplayName"), r.get("PathName"))]

    def network(self) -> str:
        return self.run(["ipconfig", "/all"])

    # ---- files: names always; small settings files are copied (not documents)
    def folders(self, software: list[dict]) -> dict:
        roots: list[Path] = []
        for s in software:
            loc = str(s.get("InstallLocation") or "").strip().strip('"')
            if loc and matches(s.get("DisplayName"), s.get("Publisher")):
                roots.append(Path(loc))
        for env in ("ProgramFiles", "ProgramFiles(x86)", "ProgramData", "APPDATA", "LOCALAPPDATA"):
            base = os.environ.get(env)
            if base and Path(base).is_dir():
                roots += [p for p in Path(base).iterdir() if p.is_dir() and matches(p.name)]
        seen, listing, copied = set(), {}, []
        dest = self.out_dir / "collected"
        for root in roots:
            if str(root).lower() in seen or not root.is_dir():
                continue
            seen.add(str(root).lower())
            files = []
            for p in sorted(root.rglob("*")):
                if len(files) >= 400:
                    break
                try:
                    if p.is_file():
                        files.append({"path": str(p.relative_to(root)), "bytes": p.stat().st_size})
                        if p.suffix.lower() in CONFIG_EXT and p.stat().st_size <= MAX_CONFIG_BYTES and len(copied) < MAX_CONFIG_FILES:
                            target = dest / root.name / p.relative_to(root)
                            target.parent.mkdir(parents=True, exist_ok=True)
                            shutil.copy2(p, target)
                            copied.append(str(p))
                except OSError:
                    continue
            listing[str(root)] = files
        return {"folders": listing, "copied_files": copied}

    # ---- the guided unplug/replug
    def unplug_test(self) -> dict:
        self.say("\nSwitch the laser ON, leave its USB cable plugged in, then press Enter.")
        self.ask("Ready (Enter)? ")
        before = {"usb": self.usb(), "ports": self.ports(), "printers": self.printers()}
        self.say("\nNow UNPLUG the laser's USB cable from the PC (the end in the PC). Wait 5 seconds, then press Enter.")
        self.ask("Unplugged (Enter)? ")
        self.sleep(2)
        during = {"usb": self.usb(), "ports": self.ports(), "printers": self.printers()}
        self.say("\nNow PLUG the cable back into the SAME USB socket and wait 10 seconds (Windows may say it is setting up the device), then press Enter.")
        self.ask("Plugged back in (Enter)? ")
        self.sleep(2)
        after = {"usb": self.usb(), "ports": self.ports(), "printers": self.printers()}
        usb = diff_devices(before["usb"], during["usb"])
        ports = diff_devices(before["ports"], during["ports"], key=lambda d: str(d.get("device")))
        back = diff_devices(during["usb"], after["usb"])
        self.say(f"\nWhen the cable was unplugged, {len(usb['gone'])} USB device(s) and {len(ports['gone'])} COM port(s) went away; "
                 f"{len(back['new'])} USB device(s) came back when it was plugged in.")
        return {"before": before, "during": during, "after": after, "usb_gone": usb["gone"], "usb_new_while_unplugged": usb["new"], "ports_gone": ports["gone"],
                "usb_back": back["new"]}

    QUESTIONS = (
        ("label", "What is printed on the machine's label (model and laser power, e.g. 'Mercury III 60W')? "),
        ("controller", "What does the machine's own control panel / display say (brand or model, e.g. Ruida, RDC, GCC)? "),
        ("send_method", "In 2D Design, which menu/button do you use to send a job to the laser, and what is it called? "),
        ("output_device", "In that dialog, what 'device', 'port' or 'printer' name is shown (type exactly what you see)? "),
        ("start_from", "After sending, does the job start by itself, or do you press Start on the machine? "),
        ("usb_stick", "Does the machine have a USB flash-drive socket or an Ethernet socket as well? (describe) "),
        ("axes", "Does the table move up/down (motorised Z) and is there air assist? How is air turned on (software or a switch)? "),
        ("notes", "Anything else that seems odd about how this laser is used? (Enter to skip) "),
    )

    def questions(self) -> dict:
        self.say("\nA few questions. Type the answer and press Enter. 'don't know' is a fine answer.")
        return {key: self.ask(q).strip() for key, q in self.QUESTIONS}

    # ---- the run
    def start(self) -> None:
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self.session = SessionLog(self.out_dir / "session.log")
        self.session.write("INFO", f"Kerf Mercury probe {PROBE_VERSION} started; station={self.args.station!r}")
        self.session.write("INFO", f"python {sys.version.split()[0]} on {platform.platform()}; windows={self.windows}; argv={sys.argv}")

    def run_all(self) -> None:
        self.step("environment", lambda: {"probe_version": PROBE_VERSION, "os": platform.platform(), "python": sys.version, "hostname": platform.node(),
                                          "machine": platform.machine(), "cwd": os.getcwd(), "started": utc_now()})
        self.step("usb_devices", self.usb, needs_windows=True)
        self.step("serial_ports", self.ports)
        self.step("printers", self.printers, needs_windows=True)
        self.step("printer_drivers", self.printer_drivers, needs_windows=True)
        sw = self.step("installed_software", self.software, needs_windows=True) or []
        keyed = [s for s in sw if matches(s.get("DisplayName"), s.get("Publisher"))]
        self.data["laser_related_software"] = keyed
        self.step("running_processes", self.processes, needs_windows=True)
        self.step("services", self.services, needs_windows=True)
        self.step("network_adapters", self.network, needs_windows=True)
        self.step("software_folders", lambda: self.folders(sw), needs_windows=True)
        self.step("unplug_test", self.unplug_test, needs_windows=True)
        self.step("operator_answers", self.questions)

    def write_reports(self) -> None:
        unplug = self.data.get("unplug_test") or {}
        notes = interpret(unplug.get("usb_gone", []), unplug.get("ports_gone", []), self.data.get("printers") or [], self.data.get("laser_related_software") or [])
        self.data["reading"] = notes
        (self.out_dir / "probe.json").write_text(json.dumps({"station": self.args.station, "steps": self.steps, "data": self.data}, indent=2, default=str), encoding="utf-8")
        sw = self.data.get("installed_software") or []
        (self.out_dir / "installed_software.txt").write_text("\n".join(sorted(f"{s.get('DisplayName')}  {s.get('DisplayVersion') or ''}  [{s.get('Publisher') or ''}]" for s in sw)), encoding="utf-8")
        lines = [f"Kerf Mercury probe {PROBE_VERSION}: station {self.args.station}", f"Finished: {utc_now()}", "", "Steps:"]
        lines += [f"  [{s['status']:7}] {s['step']}" + (f"  {s.get('note', '')}" if s.get("note") else "") for s in self.steps]
        lines += ["", "What the probe makes of it (hints, not conclusions):"] + [f"  - {n}" for n in notes]
        answers = self.data.get("operator_answers") or {}
        if answers:
            lines += ["", "Operator answers:"] + [f"  {k}: {v}" for k, v in answers.items()]
        lines += ["", "Nothing was sent to the laser. Please send back the .zip next to this folder. session.log has the timeline."]
        (self.out_dir / "report.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
        (self.out_dir / "env.txt").write_text(json.dumps(self.data.get("environment"), indent=2), encoding="utf-8")

    def close(self) -> None:
        if self.session:
            self.session.close()


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Kerf Mercury probe: read-only identification of how a laser is connected")
    p.add_argument("--station", help="station name, e.g. station5")
    p.add_argument("--out", default="output", help="folder for result folders (default: ./output)")
    return p


def main(argv=None, **deps) -> int:
    args = build_parser().parse_args(argv)
    prompt, say = deps.get("prompt", input), deps.get("say", print)
    if not args.station:
        args.station = prompt("Station name (e.g. station5): ").strip() or "station5"
    out_dir = Path(args.out) / f"{args.station}_mercury_{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    probe = Probe(args, out_dir, **deps)
    probe.start()
    say(f"Kerf Mercury probe {PROBE_VERSION}. Results folder: {out_dir}")
    probe.say("This test only LOOKS. It sends nothing to the laser and does not move it. Close 2D Design and any laser software first.")
    try:
        probe.run_all()
    except KeyboardInterrupt:
        probe.say("Stopped with Ctrl-C. What was found so far is still saved.")
    except Exception as exc:  # noqa: BLE001
        probe.say(f"Error: {exc}")
        if probe.session:
            probe.session.error(f"the run stopped with {type(exc).__name__}: {exc}", exc)
    finally:
        try:
            probe.write_reports()
        except Exception as exc:  # noqa: BLE001
            if probe.session:
                probe.session.error("writing the reports failed", exc)
        probe.close()
    zip_path = bundle(out_dir)
    say(f"\nDone. Report: {out_dir / 'report.txt'}")
    if zip_path:
        say(f"Send this ONE file back for diagnosis: {zip_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
