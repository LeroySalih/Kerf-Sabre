"""Minimal GRBL 1.1f simulator exposing the pyserial surface the spike uses."""
from collections import deque
import re

BANNER = "Grbl 1.1f ['$' for help]"
SETTINGS = {i: "0" for i in range(0, 33)} | {30: "1000", 32: "1", 22: "1", 130: "400", 131: "400"}


class MockGrbl:
    def __init__(self, homing_enabled=True, silent=False, jog_error=None):
        self.rx = deque()
        self.written = []
        self.pos = [0.0, 0.0, 0.0]
        self.state = "Idle"
        self.busy = 0
        self.homing_enabled = homing_enabled
        self.silent = silent
        self.jog_error = jog_error
        self.closed = False
        if not silent:
            self.rx.append(BANNER)

    # pyserial surface
    def write(self, data: bytes) -> int:
        self.written.append(data)
        if data == b"?":
            self._status()
        elif data == b"!":
            self.state = "Hold:0"
        elif data == b"~":
            self.state = "Run" if self.busy else "Idle"
        elif data == b"\x18":
            if self.silent:
                return len(data)
            self.state, self.busy = "Idle", 0
            self.rx.append("")
            self.rx.append(BANNER)
        else:
            for line in data.decode().splitlines():
                self._line(line.strip())
        return len(data)

    def readline(self) -> bytes:
        return (self.rx.popleft() + "\r\n").encode() if self.rx else b""

    def close(self) -> None:
        self.closed = True

    # behaviour
    def _status(self):
        if self.busy > 0 and not self.state.startswith("Hold"):
            self.busy -= 1
            if self.busy == 0:
                self.state = "Idle"
        x, y, z = self.pos
        self.rx.append(f"<{self.state}|MPos:{x:.3f},{y:.3f},{z:.3f}|FS:0,0>")

    def _line(self, line):
        if line == "$$":
            self.rx.extend(f"${k}={v}" for k, v in SETTINGS.items())
            self.rx.append("ok")
        elif line == "$H":
            if not self.homing_enabled:
                self.rx.append("error:9")
                return
            self.pos = [0.0, 0.0, 0.0]
            self.state, self.busy = "Home", 2
            self.rx.append("ok")
        elif line == "$X":
            self.state = "Idle"
            self.rx.append("ok")
        elif line.startswith("$J="):
            if self.jog_error:
                self.rx.append(self.jog_error)
                return
            m = re.findall(r"([XY])(-?\d+(?:\.\d+)?)", line)
            for axis, val in m:
                self.pos["XY".index(axis)] += float(val)
            slow = "F60" in line
            self.state, self.busy = "Jog", 100 if slow else 2
            self.rx.append("ok")
        elif "G1" in line and "X" in line:
            self.state, self.busy = "Run", 100 if "F60" in line else 2
            self.rx.append("ok")
        else:
            self.rx.append("ok")
