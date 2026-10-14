#!/usr/bin/env python3
"""Kerf Cutter Spike: prove we can talk to a Creality Falcon laser from a station PC.

Throwaway connectivity test (Track A step 1). Terminal only.
Requires pyserial. OpenCV is optional (camera test is skipped without it).

Modes: auto (full test sequence + report) and console (type raw GRBL commands).
The laser stays at S0 in every step except the optional test 11.
"""
from __future__ import annotations

import argparse
import faulthandler
import json
import os
import platform
import socket
import re
import sys
import time
import traceback
import urllib.error
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

SPIKE_VERSION = "0.1.0"
BANNER_RE = re.compile(r"Grbl (1\.1\w*)")
SETTING_RE = re.compile(r"^\$(\d+)=(\S+)")
FIRE_PHRASE = "FIRE LASER"
POSITION_TOLERANCE_MM = 0.5

PASS, FAIL, SKIPPED = "pass", "fail", "skipped"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def parse_status(line: str) -> dict | None:
    """Parse a GRBL status report like <Idle|MPos:0.000,0.000,0.000|FS:0,0>."""
    m = re.match(r"^<([A-Za-z]+(?::\d+)?)\|(.*)>$", line.strip())
    if not m:
        return None
    result = {"state": m.group(1), "mpos": None, "wpos": None, "raw": line.strip()}
    for field in m.group(2).split("|"):
        key, _, value = field.partition(":")
        if key in ("MPos", "WPos"):
            try:
                result[key.lower()] = [float(v) for v in value.split(",")]
            except ValueError:
                pass
    return result


def position_of(status: dict) -> list[float] | None:
    return status.get("mpos") or status.get("wpos")


class SessionLog:
    """Everything that happens, in order, in one readable file (session.log), flushed line by line so a crash loses nothing.

    Columns: wall-clock time, seconds since the start, a kind, then the text. Kinds: TX/RX (serial), SAY (what the screen
    showed), IN (what the operator typed), EVT (a step happened), WARN, ERR (with traceback), INFO.
    """

    def __init__(self, path: Path, clock=time.monotonic):
        self.f = open(path, "a", encoding="utf-8", buffering=1)
        self.clock = clock
        self.t0 = clock()

    def write(self, kind: str, text: str = "") -> None:
        if not self.f:
            return
        now = datetime.now().strftime("%H:%M:%S.%f")[:-3]
        body = str(text).replace("\r", "\\r").rstrip("\n")
        for i, line in enumerate(body.split("\n") or [""]):  # keep multi-line text (tracebacks) readable
            self.f.write(f"{now} +{self.clock() - self.t0:9.3f}s {kind:4} {line if i == 0 else '    ' + line}\n")
        self.f.flush()

    def event(self, what: str, /, **data) -> None:
        self.write("EVT", f"{what} {json.dumps(data, default=str)}" if data else what)

    def error(self, what: str, exc: BaseException | None = None) -> None:
        self.write("ERR", what + ("\n" + "".join(traceback.format_exception(exc)) if exc else ""))

    def close(self) -> None:
        if self.f:
            self.f.close()
            self.f = None


class Link:
    """GRBL line protocol over a pyserial-like object, logging every TX/RX line."""

    def __init__(self, ser, log_file, clock=time.monotonic, sleep=time.sleep, session: SessionLog | None = None):
        self.ser = ser
        self.log_file = log_file
        self.clock = clock
        self.sleep = sleep
        self.session = session
        self.t0 = clock()

    def log(self, direction: str, data: str, raw: bytes | None = None) -> None:
        if self.log_file:
            rec = {"ts": utc_now(), "t": round(self.clock() - self.t0, 3), "dir": direction, "data": data}
            if raw is not None and raw != (data + "\n").encode("ascii", "replace"):
                rec["raw"] = repr(raw)  # only when the bytes differ from the text (odd characters, \r\n, partial line)
            self.log_file.write(json.dumps(rec) + "\n")
            self.log_file.flush()
        if self.session:
            self.session.write(direction, data)

    def _write(self, payload: bytes) -> None:
        try:
            self.ser.write(payload)
        except Exception as exc:  # noqa: BLE001 - a dead port must be visible in the log, then handled by the caller
            if self.session:
                self.session.error(f"serial write failed ({payload!r}): {type(exc).__name__}: {exc}", exc)
            raise

    def tx(self, line: str) -> None:
        self.log("TX", line)
        self._write((line + "\n").encode("ascii"))

    def realtime(self, byte: bytes) -> None:
        self.log("TX", repr(byte))
        self._write(byte)

    def read_line(self) -> str | None:
        try:
            raw = self.ser.readline()
        except Exception as exc:  # noqa: BLE001
            if self.session:
                self.session.error(f"serial read failed: {type(exc).__name__}: {exc}", exc)
            raise
        if not raw:
            return None
        text = raw.decode("ascii", errors="replace").strip()
        if not text:
            self.log("RX", "", raw)  # a blank line: GRBL sends these; also shows stray bytes such as a lone \r
            return None
        if not raw.endswith(b"\n") and self.session:
            self.session.write("WARN", f"partial line (no newline before the read timed out): {raw!r}")
        self.log("RX", text, raw)
        return text

    def command(self, line: str, timeout: float = 5.0) -> tuple[list[str], str]:
        """Send a line, collect replies until ok / error / ALARM. Returns (lines, final)."""
        self.tx(line)
        lines: list[str] = []
        deadline = self.clock() + timeout
        while self.clock() < deadline:
            text = self.read_line()
            if text is None:
                continue
            lines.append(text)
            if text == "ok" or text.startswith("error") or text.startswith("ALARM"):
                if self.session and text != "ok":
                    self.session.write("WARN", f"GRBL answered {line!r} with {text!r}")
                return lines, text
        if self.session:
            self.session.write("WARN", f"timeout after {timeout:g}s waiting for ok to {line!r}; {len(lines)} line(s) received: {lines[-3:]}")
        return lines, "timeout"

    def status(self, timeout: float = 1.5) -> dict | None:
        self.realtime(b"?")
        deadline = self.clock() + timeout
        while self.clock() < deadline:
            text = self.read_line()
            if text and text.startswith("<"):
                parsed = parse_status(text)
                if parsed:
                    return parsed
        if self.session:
            self.session.write("WARN", f"no status report within {timeout:g}s of '?'")
        return None

    def wait_idle(self, timeout: float = 30.0) -> dict | None:
        """Poll until Idle (or Alarm). Returns the last status seen."""
        deadline = self.clock() + timeout
        last = None
        while self.clock() < deadline:
            last = self.status()
            if last and (last["state"].startswith("Idle") or last["state"].startswith("Alarm")):
                return last
            self.sleep(0.1)
        return last

    def wait_for_banner(self, timeout: float) -> str | None:
        deadline = self.clock() + timeout
        while self.clock() < deadline:
            text = self.read_line()
            if text and BANNER_RE.search(text):
                return text
        if self.session:
            self.session.write("WARN", f"no GRBL banner within {timeout:g}s")
        return None


def default_list_ports():
    from serial.tools import list_ports

    return [
        {"device": p.device, "description": p.description, "vid": p.vid, "pid": p.pid, "hwid": p.hwid}
        for p in list_ports.comports()
    ]


def default_open_serial(port: str, baud: int):
    import serial

    return serial.Serial(port, baud, timeout=0.2, write_timeout=2)


def default_load_cv2():
    try:
        import cv2

        return cv2, None
    except Exception as exc:  # noqa: BLE001 - spike must never crash on missing OpenCV
        return None, f"{type(exc).__name__}: {exc}"


def default_http_get(url: str, timeout: float = 10.0) -> int:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return resp.status
    except urllib.error.HTTPError as exc:
        return exc.code  # server answered: the connection itself worked


def _pos_of(status: dict | None) -> str | None:
    m = re.search(r"[MW]Pos:[^|>]*", status["raw"]) if status else None
    return m.group() if m else None


def is_ch340(port: dict) -> bool:
    text = f"{port.get('description', '')} {port.get('hwid', '')}".upper()
    return port.get("vid") == 0x1A86 or "CH340" in text or "1A86" in text


class TestSkip(Exception):
    """Raised by a test to report 'skipped' with a reason."""


class Runner:
    TESTS = [
        (1, "List serial ports", []),
        (2, "Open port and read GRBL banner", [1]),
        (3, "Read settings ($$)", [2]),
        (4, "Status reports (?)", [2]),
        (5, "Home ($H)", [2]),
        (6, "Jog 10 mm X/Y and back", [2, 4]),
        (7, "Air assist M8/M9", [2]),
        (8, "Feed hold, resume, soft reset", [2, 4]),
        (9, "Camera probe", []),
        (10, "Outbound HTTPS to server", []),
        (11, "Optional laser fire (10 mm square, <=5% power)", [2, 3]),
    ]

    def __init__(self, args, out_dir: Path, *, list_ports=default_list_ports,
                 open_serial=default_open_serial, load_cv2=default_load_cv2,
                 http_get=default_http_get, prompt=input, say=print,
                 clock=time.monotonic, sleep=time.sleep):
        self.args = args
        self.out_dir = out_dir
        self.list_ports = list_ports
        self.open_serial = open_serial
        self.load_cv2 = load_cv2
        self.http_get = http_get
        self._prompt = prompt
        self._say = say
        self.session: SessionLog | None = None
        self.crash_file = None
        self.clock = clock
        self.sleep = sleep
        self.log_file = None
        self.link: Link | None = None
        self.port: str | None = None
        self.candidates: list[str] = []
        self.ports: list[dict] = []
        self.banner: str | None = None
        self.settings: dict[int, str] = {}
        self.camera_indices_tried: list[dict] = []
        self.cv2_error: str | None = None
        self.results: list[dict] = []
        self.aborted = False

    # ---- screen and keyboard, both recorded -----------------------------------
    def say(self, text: str = "") -> None:
        if self.session:
            self.session.write("SAY", text)
        try:
            self._say(text)
        except UnicodeEncodeError:  # a Windows console that can't show a character must not stop the test
            self._say(str(text).encode("ascii", "replace").decode())

    def prompt(self, question: str) -> str:
        if self.session:
            self.session.write("SAY", question)
        answer = self._prompt(question)
        if self.session:
            self.session.write("IN", answer)
        return answer

    def event(self, what: str, /, **data) -> None:
        if self.session:
            self.session.event(what, **data)

    # ---- setup / teardown -------------------------------------------------
    def start(self) -> None:
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self.log_file = open(self.out_dir / "serial.log", "a", encoding="utf-8")
        self.session = SessionLog(self.out_dir / "session.log", self.clock)
        # native crashes (a camera driver, the serial driver) and hangs leave a stack trace here instead of nothing
        self.crash_file = open(self.out_dir / "crash.log", "a", encoding="utf-8")
        try:
            faulthandler.enable(file=self.crash_file)
        except Exception:  # noqa: BLE001
            pass
        self.session.write("INFO", f"Kerf Spike {SPIKE_VERSION} started; station={self.args.station!r} mode={getattr(self.args, 'mode', None)!r} "
                                   f"port={self.args.port!r} baud={self.args.baud} server_url={getattr(self.args, 'server_url', None)!r}")
        self.session.write("INFO", f"python {sys.version.split()[0]} on {platform.platform()}; pyserial {self._pyserial_version()}; argv={sys.argv}")
        self.write_env()  # so there is an environment record even if the run never finishes

    @staticmethod
    def _pyserial_version() -> str:
        try:
            import serial

            return getattr(serial, "__version__", "unknown")
        except Exception as exc:  # noqa: BLE001
            return f"unavailable ({type(exc).__name__}: {exc})"

    def emergency_stop(self) -> None:
        """Feed hold then soft reset. Safe to call at any time."""
        if self.link:
            self.event("emergency_stop", sends="! (feed hold) then 0x18 (soft reset)")
            for byte in (b"!", b"\x18"):
                try:
                    self.link.realtime(byte)
                except Exception as exc:  # noqa: BLE001
                    if self.session:
                        self.session.error(f"emergency stop could not send {byte!r}", exc)

    def close(self) -> None:
        if self.link:
            try:
                self.link.ser.close()
                self.event("port_closed", port=self.port)
            except Exception as exc:  # noqa: BLE001
                if self.session:
                    self.session.error("closing the serial port failed", exc)
        try:
            faulthandler.cancel_dump_traceback_later()
            faulthandler.disable()
        except Exception:  # noqa: BLE001
            pass
        if self.crash_file:
            self.crash_file.close()
            self.crash_file = None
        if self.log_file:
            self.log_file.close()
            self.log_file = None
        if self.session:
            self.session.write("INFO", "session closed")
            self.session.close()
            self.session = None

    # ---- shared steps -------------------------------------------------------
    def select_port(self) -> str:
        self.ports = self.list_ports()
        self.event("ports_found", ports=self.ports)
        for p in self.ports:
            self.say(f"  {p['device']}: {p['description']} (VID {p['vid']}, PID {p['pid']})")
        if self.args.port:
            self.port = self.args.port
            self.candidates = [self.port]
            return self.port
        if not self.ports:
            raise RuntimeError("No serial ports found. Is the laser plugged in and the USB driver installed?")
        # Hunt: every port is a candidate, most likely first (CH340, then other USB devices, then the rest).
        ranked = sorted(self.ports, key=lambda p: (0 if is_ch340(p) else 1 if p.get("vid") is not None else 2))
        self.candidates = [p["device"] for p in ranked]
        self.say(f"Will try these ports in turn until one answers like GRBL: {', '.join(self.candidates)}")
        self.port = self.candidates[0]
        return self.port

    def open_link(self) -> str:
        ports = self.candidates or [self.port]
        errors: list[str] = []
        for port in ports:
            self.port = port
            self.say(f"Trying {port} ...")
            try:
                banner = self.try_port(port)
            except RuntimeError as exc:
                errors.append(str(exc))
                self.say(f"  {port}: no GRBL ({exc})")
                self.event("port_rejected", port=port, reason=str(exc))
                self.close_link()
                continue
            self.banner = banner
            self.event("banner", banner=banner, port=port)
            return banner
        raise RuntimeError(" | ".join(errors) or "no ports to try")

    def close_link(self) -> None:
        if self.link:
            try:
                self.link.ser.close()
            except Exception:  # noqa: BLE001
                pass
            self.link = None

    def try_port(self, port: str) -> str:
        self.event("opening_port", port=port, baud=self.args.baud)
        try:
            ser = self.open_serial(port, self.args.baud)
        except Exception as exc:  # noqa: BLE001
            hint = ("Access denied: another program (LightBurn, LaserGRBL, a serial monitor, another spike) has the port open. Close it."
                    if "denied" in str(exc).lower() or "busy" in str(exc).lower() else "Check the cable, the driver and the port name.")
            if self.session:
                self.session.error(f"could not open {port}: {type(exc).__name__}: {exc}. {hint}", exc)
            raise RuntimeError(f"Could not open {port}: {exc}. {hint}") from exc
        self.link = Link(ser, self.log_file, self.clock, self.sleep, self.session)
        banner = self.link.wait_for_banner(2.0)
        if not banner:
            self.event("no_banner_sending_soft_reset", port=port)
            self.link.realtime(b"\x18")  # soft reset provokes the banner
            banner = self.link.wait_for_banner(5.0)
        if not banner:
            raise RuntimeError(f"No 'Grbl 1.1x' banner received on {port} within timeout")
        return banner

    # ---- tests ----------------------------------------------------------------
    def test_1(self):
        port = self.select_port()
        ch340 = [p["device"] for p in self.ports if is_ch340(p)]
        details = {"selected": port, "ports": self.ports, "ch340_ports": ch340}
        if port not in ch340:  # informational: the banner test decides whether it really is the laser
            details["note"] = "selected port is not a CH340-type port"
        return PASS, details

    def test_2(self):
        banner = self.open_link()
        return PASS, {"banner": banner}

    def test_3(self):
        lines, final = self.link.command("$$", timeout=8.0)
        for line in lines:
            m = SETTING_RE.match(line)
            if m:
                self.settings[int(m.group(1))] = m.group(2)
        (self.out_dir / "settings.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
        details = {
            "final": final,
            "count": len(self.settings),
            "$30": self.settings.get(30),
            "$32": self.settings.get(32),
            "$130": self.settings.get(130),
            "$131": self.settings.get(131),
        }
        return (PASS if final == "ok" and len(self.settings) >= 10 else FAIL), details

    def test_4(self):
        states = []
        for _ in range(5):
            s = self.link.status()
            states.append(s["raw"] if s else None)
            self.sleep(0.1)
        ok = all(states)
        return (PASS if ok else FAIL), {"reports": states}

    def test_5(self):
        link = self.link
        link.command("M5")
        details: dict = {}
        _, final = link.command("$H", timeout=90.0)
        details["home_reply"] = final
        if final != "ok":
            details["hint"] = ("error:9 means homing is disabled ($22=0); ALARM means a limit/hard fault. "
                               "Trying $X unlock so later tests can continue.")
            _, unlock = link.command("$X")
            details["unlock_reply"] = unlock
            return FAIL, details
        status = link.wait_idle(60.0)
        details["final_status"] = status["raw"] if status else None
        if status and status["state"].startswith("Alarm"):
            _, unlock = link.command("$X")
            details["unlock_reply"] = unlock
            return FAIL, details
        return (PASS if status and status["state"].startswith("Idle") else FAIL), details

    def _jog(self, axis: str, dist: float) -> tuple[bool, str]:
        _, final = self.link.command(f"$J=G21G91{axis}{dist:g}F1000", timeout=10.0)
        self.link.wait_idle(20.0)
        return final == "ok", final

    def test_6(self):
        link = self.link
        link.command("M5")
        start = link.status()
        if not start or not position_of(start):
            return FAIL, {"error": "no position in status report"}
        details: dict = {"start": position_of(start), "moves": []}
        ok_all = True
        for axis, idx in (("X", 0), ("Y", 1)):
            before = position_of(link.status())
            moved = None
            for sign in (1, -1):  # try the other direction if the first hits a travel limit
                ok, reply = self._jog(axis, 10 * sign)
                if ok:
                    moved = sign
                    break
                details["moves"].append({"axis": axis, "sign": sign, "reply": reply})
            if moved is None:
                ok_all = False
                continue
            after = position_of(link.status())
            delta = after[idx] - before[idx]
            good = abs(delta - 10 * moved) <= POSITION_TOLERANCE_MM
            self._jog(axis, -10 * moved)
            back = position_of(link.status())
            returned = abs(back[idx] - before[idx]) <= POSITION_TOLERANCE_MM
            details["moves"].append({"axis": axis, "commanded": 10 * moved, "measured": round(delta, 3),
                                     "returned": returned})
            ok_all = ok_all and good and returned
        return (PASS if ok_all else FAIL), details

    def test_7(self):
        link = self.link
        _, on = link.command("M8")
        self.say("\n>>> Air assist test: look and listen at the laser head.")
        answer = self.prompt("Did the air assist start when M8 was sent? (y/n): ").strip().lower()
        _, off = link.command("M9")
        answer2 = self.prompt("Did it stop after M9? (y/n): ").strip().lower()
        details = {"M8_reply": on, "M9_reply": off, "started": answer, "stopped": answer2}
        return (PASS if answer.startswith("y") and answer2.startswith("y") else FAIL), details

    def test_8(self):
        link = self.link
        link.command("M5")
        # A normal G1 move (like a cut at S0), not $J: some GRBL ports ignore feed hold during a jog.
        _, final = link.command("G21 G91 G1 X30 F60", timeout=5.0)
        observed: dict = {"move_reply": final}
        running = None
        for _ in range(10):
            running = link.status()
            if running and running["state"].startswith(("Jog", "Run")):
                break
            self.sleep(0.1)
        observed["before_hold"] = running["raw"] if running else None
        link.realtime(b"!")
        self.sleep(0.2)
        hold = link.status()
        # GRBL reports Hold:1 while still decelerating and Hold:0 once stopped; only compare positions once stopped.
        for _ in range(30):
            if hold and hold["state"].startswith("Hold") and not hold["state"].endswith(":1"):
                break
            self.sleep(0.1)
            hold = link.status()
        observed["after_hold"] = hold["raw"] if hold else None
        self.sleep(0.5)
        hold2 = link.status()  # position must not creep while held
        observed["after_hold_0.5s"] = hold2["raw"] if hold2 else None
        observed["held_still"] = _pos_of(hold) is not None and _pos_of(hold) == _pos_of(hold2)
        link.realtime(b"~")
        self.sleep(0.2)
        resumed = link.status()
        observed["after_resume"] = resumed["raw"] if resumed else None
        link.realtime(b"\x18")
        banner = link.wait_for_banner(5.0)
        observed["banner_after_reset"] = banner
        if banner:
            link.command("G90")  # the move above left relative mode on
        after = link.status()
        observed["after_reset"] = after["raw"] if after else None
        if after and after["state"].startswith("Alarm"):
            _, unlock = link.command("$X")
            observed["unlock_reply"] = unlock
            observed["note"] = "Position may be lost after reset; re-home before further use."
        ok = bool(
            hold and hold["state"].startswith("Hold")
            and observed["held_still"]
            and resumed and (resumed["state"].startswith(("Jog", "Run", "Idle")))
            and banner
        )
        return (PASS if ok else FAIL), observed

    def test_9(self):
        cv2, error = self.load_cv2()
        if cv2 is None:
            self.cv2_error = error
            raise TestSkip(f"OpenCV unavailable: {error}")
        for idx in range(5):
            entry = {"index": idx, "opened": False, "frame": False}
            try:
                cap = cv2.VideoCapture(idx)
                entry["opened"] = bool(cap.isOpened())
                if entry["opened"]:
                    ok, frame = cap.read()
                    entry["frame"] = bool(ok)
                    if ok:
                        cv2.imwrite(str(self.out_dir / "camera.jpg"), frame)
                        self.camera_indices_tried.append(entry)
                        cap.release()
                        return PASS, {"outcome": "camera captured", "index": idx}
                cap.release()
            except Exception as exc:  # noqa: BLE001
                entry["error"] = f"{type(exc).__name__}: {exc}"
            self.camera_indices_tried.append(entry)
        return PASS, {"outcome": "no USB camera found (possibly network-only)",
                      "tried": self.camera_indices_tried}

    def test_10(self):
        url = self.args.server_url
        if not url:
            raise TestSkip("no server URL configured")
        start = self.clock()
        try:
            status = self.http_get(url)
        except Exception as exc:  # noqa: BLE001
            return FAIL, {"url": url, "error": f"{type(exc).__name__}: {exc}"}
        return PASS, {"url": url, "http_status": status, "latency_ms": round((self.clock() - start) * 1000)}

    def test_11(self):
        if not self.args.enable_fire:
            raise TestSkip("skipped by default (use --enable-fire to allow)")
        s30 = self.settings.get(30)
        if not s30:
            raise TestSkip("$30 unknown, cannot compute 5% power")
        self.say("\n!!! LASER FIRE TEST !!!  Place a scrap of cuttable material, wear eye protection,")
        self.say("    stay at the machine. A 10 mm square will be drawn at 5% power.")
        if self.prompt(f"Type {FIRE_PHRASE} to continue, anything else to skip: ").strip() != FIRE_PHRASE:
            raise TestSkip("confirmation phrase not entered")
        power = max(1, int(float(s30) * 0.05))
        link = self.link
        replies = []
        try:
            # Spike only: relative moves (G91) so we do not need work-coordinate offsets.
            for line in ("G21", "G91", "M4 S0", f"G1 X10 F600 S{power}", "G1 Y10", "G1 X-10", "G1 Y-10"):
                _, reply = link.command(line, timeout=15.0)
                replies.append((line, reply))
        finally:
            link.command("M5")
            link.command("G90")
        status = link.wait_idle(30.0)
        ok = all(r == "ok" for _, r in replies)
        return (PASS if ok else FAIL), {"power_s": power, "replies": replies,
                                        "final_status": status["raw"] if status else None}

    # ---- sequencing -------------------------------------------------------------
    def run_all(self) -> list[dict]:
        status_by_id: dict[int, str] = {}
        for number, name, requires in self.TESTS:
            if self.aborted:
                self._record(number, name, SKIPPED, {"reason": "aborted"}, 0.0, status_by_id)
                continue
            blocked = [r for r in requires if status_by_id.get(r) != PASS]
            if blocked:
                self._record(number, name, SKIPPED,
                             {"reason": f"skipped (dependency): test(s) {blocked} did not pass"}, 0.0, status_by_id)
                continue
            self.say(f"\n--- Test {number}: {name} ---")
            self.event("test_start", test=number, name=name)
            try:  # a test stuck for 3 minutes dumps where it is stuck into crash.log
                if self.crash_file:
                    faulthandler.dump_traceback_later(180, repeat=False, file=self.crash_file)
            except Exception:  # noqa: BLE001
                pass
            started = self.clock()
            try:
                status, details = getattr(self, f"test_{number}")()
            except TestSkip as skip:
                status, details = SKIPPED, {"reason": str(skip)}
            except KeyboardInterrupt:
                self.aborted = True
                self.emergency_stop()
                status, details = FAIL, {"error": "interrupted by operator (Ctrl-C)"}
            except Exception as exc:  # noqa: BLE001
                status, details = FAIL, {"error": f"{type(exc).__name__}: {exc}",
                                         "traceback": traceback.format_exc()}
                if self.session:
                    self.session.error(f"test {number} raised {type(exc).__name__}: {exc}", exc)
            self._record(number, name, status, details, self.clock() - started, status_by_id)
            self.say(f"    -> {status.upper()}")
        return self.results

    def _record(self, number, name, status, details, duration, status_by_id):
        status_by_id[number] = status
        row = {"test": number, "name": name, "status": status, "duration_s": round(duration, 3), "details": details}
        self.results.append(row)
        self.event("test_end", test=number, name=name, status=status, duration_s=row["duration_s"], details=details)
        try:  # results are saved as they happen, so a hang or crash later on still leaves what was learned
            with open(self.out_dir / "results.jsonl", "a", encoding="utf-8") as f:
                f.write(json.dumps({"ts": utc_now(), **row}, default=str) + "\n")
            self._write_report_json(partial=True)
        except Exception as exc:  # noqa: BLE001
            if self.session:
                self.session.error("could not save partial results", exc)

    # ---- reporting ----------------------------------------------------------------
    def _write_report_json(self, partial: bool = False) -> dict:
        summary = {s: sum(1 for r in self.results if r["status"] == s) for s in (PASS, FAIL, SKIPPED)}
        report = {
            "spike_version": SPIKE_VERSION,
            "station": self.args.station,
            "finished": None if partial else utc_now(),
            "partial": partial,
            "aborted": self.aborted,
            "banner": self.banner,
            "settings": {f"${k}": v for k, v in sorted(self.settings.items())},
            "summary": summary,
            "results": self.results,
        }
        (self.out_dir / "report.json").write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")
        return report

    def write_reports(self) -> None:
        report = self._write_report_json()
        summary = report["summary"]
        self.event("report_written", summary=summary, aborted=self.aborted)

        lines = [f"Kerf Spike report: station {self.args.station}", f"Finished: {report['finished']}",
                 f"GRBL banner: {self.banner}", ""]
        for r in self.results:
            reason = r["details"].get("reason") or r["details"].get("error") or ""
            lines.append(f"[{r['status'].upper():7}] {r['test']:>2}. {r['name']}  {reason}")
        lines += ["", f"Totals: {summary[PASS]} passed, {summary[FAIL]} failed, {summary[SKIPPED]} skipped",
                  "Please send back the .zip next to this folder (or the whole folder). session.log has the full timeline."]
        (self.out_dir / "report.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
        self.write_env()

    def write_env(self) -> None:
        cv2_version = None
        cv2, error = self.load_cv2()
        if cv2 is not None:
            cv2_version = getattr(cv2, "__version__", "unknown")
        else:
            error = error or self.cv2_error
        lines = [
            f"spike_version: {SPIKE_VERSION}",
            f"station: {self.args.station}",
            f"os: {platform.platform()}",
            f"python: {sys.version}",
            f"executable: {sys.executable}",
            f"opencv: {cv2_version or 'unavailable: ' + str(error)}",
            f"pyserial: {self._pyserial_version()}",
            f"machine: {platform.machine()}  processor: {platform.processor()}",
            f"hostname: {socket.gethostname()}",
            f"working directory: {os.getcwd()}",
            f"argv: {sys.argv}",
            f"timezone: {time.tzname}  utc offset: {-time.timezone // 3600} h",
            f"started: {utc_now()}",
            f"serial port chosen: {self.port}  baud: {self.args.baud}",
            "serial ports:",
        ]
        for p in self.ports:
            lines.append(f"  {p['device']}  vid={p['vid']} pid={p['pid']}  {p['description']}  [{p.get('hwid')}]")
        lines.append(f"camera indices tried: {json.dumps(self.camera_indices_tried)}")
        (self.out_dir / "env.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")

    # ---- console mode ----------------------------------------------------------------
    def console(self) -> None:
        self.select_port()
        self.say(f"Opening {self.port} ...")
        self.say(f"Banner: {self.open_link()}")
        self.say("Type a GRBL command and press Enter. Special: ?  !  ~  reset (soft reset)  quit")
        while True:
            try:
                line = self.prompt("grbl> ").strip()
            except EOFError:
                break
            if line in ("quit", "exit"):
                self.event("console_quit")
                break
            if line in ("?", "!", "~"):
                self.link.realtime(line.encode())
                self.say(self.link.read_line() or "(no reply)")
            elif line == "reset":
                self.link.realtime(b"\x18")
                self.say(self.link.read_line() or "(no reply)")
            elif line:
                lines, final = self.link.command(line)
                for text in lines:
                    self.say(text)
                if final == "timeout":
                    self.say("(timed out waiting for ok)")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Kerf Cutter spike: laser connectivity test")
    p.add_argument("--mode", choices=("auto", "console"), help="auto test or raw console")
    p.add_argument("--port", help="serial port, e.g. COM3 (default: hunt through all ports)")
    p.add_argument("--baud", type=int, default=115200)
    p.add_argument("--station", help="station name, e.g. station1")
    p.add_argument("--server-url", dest="server_url", help="Kerf Server URL for the HTTPS test")
    p.add_argument("--out", default="output", help="folder for result folders (default: ./output)")
    p.add_argument("--enable-fire", action="store_true", help="allow the optional laser fire test (11)")
    return p


def main(argv=None, **deps) -> int:
    args = build_parser().parse_args(argv)
    prompt = deps.get("prompt", input)
    say = deps.get("say", print)
    if not args.mode:
        args.mode = "console" if prompt("Mode: [A]uto test or [C]onsole? (a/c): ").strip().lower().startswith("c") else "auto"
    if not args.station:
        args.station = prompt("Station name (e.g. station1): ").strip() or "station"
    if args.server_url is None:
        args.server_url = prompt("Kerf Server URL for network test (blank to skip): ").strip()
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    out_dir = Path(args.out) / f"{args.station}_{stamp}"

    runner = Runner(args, out_dir, **deps)
    runner.start()
    runner.event("operator_choices", mode=args.mode, station=args.station, server_url=args.server_url or None)
    say(f"Kerf Spike {SPIKE_VERSION}. Results folder: {out_dir}")
    runner.say("Make sure LightBurn, LaserGRBL and Creality software are CLOSED. Stay at the machine.")
    try:
        if args.mode == "console":
            runner.console()
        else:
            runner.run_all()
    except KeyboardInterrupt:
        runner.aborted = True
        runner.event("interrupted", by="Ctrl-C")
        runner.emergency_stop()
    except Exception as exc:  # noqa: BLE001
        runner.say(f"Error: {exc}")
        if runner.session:
            runner.session.error(f"the run stopped with {type(exc).__name__}: {exc}", exc)
        runner.emergency_stop()
    finally:
        try:
            if runner.link and args.mode == "auto":
                runner.emergency_stop()  # leave the machine in a known, safe state
            if args.mode == "auto":
                runner.write_reports()
            else:
                runner.write_env()
        except Exception as exc:  # noqa: BLE001 - reporting must never hide the real problem
            if runner.session:
                runner.session.error("writing the final reports failed", exc)
        runner.close()
    zip_path = bundle(out_dir)
    if args.mode == "auto":
        say(f"\nDone. Report: {out_dir / 'report.txt'}")
    say(f"Everything is saved in: {out_dir}")
    if zip_path:
        say(f"Send this ONE file back for diagnosis: {zip_path}")
    return 0


def bundle(out_dir: Path) -> Path | None:
    """Zip the whole results folder next to it, so there is one file to send back."""
    try:
        zip_path = out_dir.with_suffix(".zip") if out_dir.suffix == "" else Path(str(out_dir) + ".zip")
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
            for p in sorted(out_dir.rglob("*")):
                if p.is_file():
                    z.write(p, Path(out_dir.name) / p.relative_to(out_dir))
        return zip_path
    except Exception as exc:  # noqa: BLE001
        print(f"(Could not make the zip: {exc}. Send the whole folder instead.)")
        return None


if __name__ == "__main__":
    sys.exit(main())
