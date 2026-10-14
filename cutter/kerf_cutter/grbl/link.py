"""The GRBL line protocol over a pyserial-like object. Ported from the spike's `Link` (spike/spike.py) and hardened:
- reset to banner (GRBL sends no banner on open: a soft reset 0x18 makes it),
- commands that can be interrupted (stop and pause must work while a line waits for its `ok`),
- one lock so the status poller and the job never interleave a command with a status read; realtime bytes (`!`, `~`, 0x18) skip the lock on purpose.
Every TX/RX line goes to the DEBUG log."""
from __future__ import annotations

import threading
import time
from collections.abc import Callable

from ..logs import CutterLog
from .state import BANNER_RE, Status, parse_settings, parse_status

HOLD = b"!"
RESUME = b"~"
RESET = b"\x18"


class Link:
    def __init__(self, ser, log: CutterLog, clock=time.monotonic, sleep=time.sleep):
        self.ser, self.log, self.clock, self.sleep = ser, log, clock, sleep
        self.lock = threading.RLock()

    # ---- raw
    def _write(self, payload: bytes) -> None:
        try:
            self.ser.write(payload)
        except Exception as exc:  # a dead port must be in the log, then dealt with by the caller
            self.log.error("serial_write_failed", payload=repr(payload), error=f"{type(exc).__name__}: {exc}")
            raise

    def tx(self, line: str) -> None:
        self.log.serial("TX", line)
        self._write((line + "\n").encode("ascii"))

    def realtime(self, byte: bytes) -> None:
        self.log.serial("TX", repr(byte))
        self._write(byte)

    def read_line(self) -> str | None:
        try:
            raw = self.ser.readline()
        except Exception as exc:
            self.log.error("serial_read_failed", error=f"{type(exc).__name__}: {exc}")
            raise
        if not raw:
            return None
        text = raw.decode("ascii", errors="replace").strip()
        if not raw.endswith(b"\n"):
            self.log.warning("partial_line", raw=repr(raw))
        self.log.serial("RX", text)
        return text or None

    # ---- commands
    def command(self, line: str, timeout: float = 5.0, abort: Callable[[], bool] | None = None, paused: Callable[[], bool] | None = None) -> tuple[list[str], str]:
        """Send a line and collect replies until ok / error / ALARM. Returns (lines, final) where final is that line, "timeout" or "aborted".
        While `paused()` the timeout does not run (in a hold GRBL may not answer until the hold ends)."""
        with self.lock:
            self.tx(line)
            lines: list[str] = []
            deadline = self.clock() + timeout
            while True:
                if abort and abort():
                    return lines, "aborted"
                if paused and paused():
                    deadline = self.clock() + timeout
                if self.clock() >= deadline:
                    self.log.warning("command_timeout", line=line, timeout_s=timeout, received=lines[-3:])
                    return lines, "timeout"
                text = self.read_line()
                if text is None:
                    continue
                lines.append(text)
                if text == "ok" or text.startswith("error") or text.startswith("ALARM"):
                    if text != "ok":
                        self.log.warning("grbl_refused", line=line, answer=text)
                    return lines, text

    def status(self, timeout: float = 1.5) -> Status | None:
        with self.lock:
            self.realtime(b"?")
            deadline = self.clock() + timeout
            while self.clock() < deadline:
                text = self.read_line()
                if text and text.startswith("<"):
                    st = parse_status(text)
                    if st:
                        return st
            self.log.warning("no_status", timeout_s=timeout)
            return None

    def wait_for_banner(self, timeout: float) -> str | None:
        deadline = self.clock() + timeout
        while self.clock() < deadline:
            text = self.read_line()
            if text and BANNER_RE.search(text):
                return text
        return None

    def reset(self, timeout: float = 4.0) -> str | None:
        """Soft reset, then wait for the banner. Opening the port gives no banner on these machines; this does."""
        with self.lock:
            self.realtime(RESET)
            banner = self.wait_for_banner(timeout)
            if banner is None:
                self.log.warning("no_banner", timeout_s=timeout)
            return banner

    def settings(self, timeout: float = 5.0) -> dict[str, str]:
        lines, final = self.command("$$", timeout=timeout)
        return parse_settings(lines) if final == "ok" else {}

    def wait_stopped(self, timeout: float = 5.0) -> Status | None:
        """After `!`: poll until Hold:0 (really stopped). Returns the last status seen."""
        deadline = self.clock() + timeout
        last = None
        while self.clock() < deadline:
            last = self.status()
            if last and (last.stopped_hold or last.state.startswith(("Idle", "Alarm"))):
                return last
            self.sleep(0.05)
        return last

    def wait_idle(self, timeout: float = 30.0, abort: Callable[[], bool] | None = None) -> Status | None:
        deadline = self.clock() + timeout
        last = None
        while self.clock() < deadline:
            if abort and abort():
                return last
            last = self.status()
            if last and last.state.startswith(("Idle", "Alarm")):
                return last
            self.sleep(0.1)
        return last
