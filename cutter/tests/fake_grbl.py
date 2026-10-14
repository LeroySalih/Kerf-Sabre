"""A simulated GRBL 1.1f controller on the pyserial surface (write / readline / close), built from what the spike observed on the four stations:
no banner on open, a soft reset gives `[MSG:...]` then the banner, `!` reports Hold:1 then Hold:0, a reset while moving gives ALARM:3 and needs homing."""
from __future__ import annotations

import re
from collections import deque

BANNER = "Grbl 1.1f ['$' for help]"


class FakeClock:
    """Time that only moves when the code under test looks at it or sleeps, so timeouts take no real time."""

    def __init__(self, step: float = 0.01):
        self.t, self.step = 0.0, step

    def __call__(self) -> float:
        self.t += self.step
        return self.t

    def sleep(self, s: float) -> None:
        self.t += s


def settings(bed=(400, 415), s30=1000, laser=1, homing=1) -> dict[int, str]:
    d = {i: "0" for i in range(0, 33)}
    d.update({22: str(homing), 30: f"{s30}.000", 32: str(laser), 130: f"{bed[0]}.000", 131: f"{bed[1]}.000", 110: "25000.000", 111: "8000.000", 120: "1000.000", 121: "1000.000"})
    return d


class FakeGrbl:
    def __init__(self, bed=(400, 415), s30=1000, laser=1, homing=1, banner_on_open=False, moves_per_line=2):
        self.rx: deque[str] = deque([BANNER] if banner_on_open else [])
        self.written: list[bytes] = []
        self.lines: list[str] = []          # every G-code/command line received, in order
        self.settings = settings(bed, s30, laser, homing)
        self.pos = [0.0, 0.0, 0.0]
        self.state = "Idle"
        self.hold = 0                       # 0 none; 2 = Hold:1 on the next status; 1 = Hold:0
        self.queued = 0                     # moves still "executing"
        self.moves_per_line = moves_per_line
        self.homed = False
        self.alarm = False
        self.closed = False
        # fault injection
        self.error_on: dict[str, str] = {}  # substring of a line -> the error to answer instead of ok
        self.alarm_after: int | None = None  # raise an alarm after this many motion lines
        self.fail_write_after: int | None = None  # raise OSError on write after this many writes
        self.silent_after: int | None = None  # stop answering after this many lines
        self.hold_blocks_ok = False
        self._motion_lines = 0
        self._held_oks = 0

    # ---- pyserial surface
    def write(self, data: bytes) -> int:
        if self.fail_write_after is not None and len(self.written) >= self.fail_write_after:
            raise OSError("write failed: device disconnected")
        self.written.append(data)
        if data == b"?":
            self._status()
        elif data == b"!":
            self.hold = 2
        elif data == b"~":
            self.hold = 0
            for _ in range(self._held_oks):
                self.rx.append("ok")
            self._held_oks = 0
        elif data == b"\x18":
            moving = self.queued > 0 or self.state in ("Run", "Hold")
            self.queued, self.hold, self._held_oks = 0, 0, 0
            self.rx.append("")
            self.rx.append("[MSG:Using cpu_map...esp32-s3]")
            self.rx.append(BANNER)
            if moving:
                self.rx.append("ALARM:3")
                self.alarm = True
            if moving or self.settings[22] == "1":
                self.homed = False
            self.state = "Alarm" if self.alarm else "Idle"
        else:
            for line in data.decode().splitlines():
                self._line(line.strip())
        return len(data)

    def readline(self) -> bytes:
        return (self.rx.popleft() + "\r\n").encode() if self.rx else b""

    def close(self) -> None:
        self.closed = True

    # ---- behaviour
    def _status(self) -> None:
        if self.alarm:
            state = "Alarm"
        elif self.hold:
            state = f"Hold:{1 if self.hold == 2 else 0}"
            if self.hold == 2:
                self.hold = 1
        elif self.queued > 0:
            self.queued -= 1
            state = "Run" if self.queued > 0 else "Idle"
        else:
            state = "Idle"
        x, y, z = self.pos
        self.rx.append(f"<{state}|MPos:{x:.3f},{y:.3f},{z:.3f}|FS:0,0>")

    def _answer(self, text: str) -> None:
        if self.hold and self.hold_blocks_ok and text == "ok":
            self._held_oks += 1
        else:
            self.rx.append(text)

    def _line(self, line: str) -> None:
        self.lines.append(line)
        if self.silent_after is not None and len(self.lines) > self.silent_after:
            return
        for sub, err in self.error_on.items():
            if sub in line:
                self._answer(err)
                return
        if line == "$$":
            self.rx.extend(f"${k}={v}" for k, v in self.settings.items())
            self.rx.append("ok")
        elif line == "$H":
            if self.settings[22] != "1":
                self.rx.append("error:5")
                return
            self.pos, self.homed, self.alarm, self.state = [0.025, 0.025, 0.0], True, False, "Idle"
            self.rx.append("ok")
        elif line == "$X":
            self.alarm = False
            self.rx.append("ok")
        elif self.alarm and not line.startswith("$"):
            self.rx.append("error:9")
        elif re.search(r"G[0-3](?!\d)", line) and re.search(r"[XY]-?\d", line):
            self._motion_lines += 1
            m = dict(re.findall(r"([XY])(-?\d+(?:\.\d+)?)", line))
            for axis, val in m.items():
                self.pos["XY".index(axis)] = float(val)
            self.queued += self.moves_per_line
            if self.alarm_after is not None and self._motion_lines >= self.alarm_after:
                self.alarm = True
            self._answer("ok")
        else:
            self._answer("ok")
