"""Reading what GRBL says: status reports, `$$` settings, alarm and error codes. What the spike observed is in docs/spike-results.md."""
from __future__ import annotations

import re
from dataclasses import dataclass

BANNER_RE = re.compile(r"Grbl\s+\d")
_STATUS = re.compile(r"^<([A-Za-z]+)(?::(\d+))?\|(.*)>$")

ALARMS = {
    1: "Hard limit triggered", 2: "A move would go past the machine's limits (soft limit)", 3: "The machine was reset while moving, so its position may be lost: it needs homing",
    4: "Probe failed", 5: "Probe failed", 6: "Homing failed: the cycle was reset", 7: "Homing failed: a door opened", 8: "Homing failed: the machine did not leave its limit switch",
    9: "Homing failed: no limit switch was found", 10: "Limit switch hit unexpectedly",
}
ERRORS = {
    1: "G-code word not recognised", 2: "A number was missing or badly formed", 3: "Unknown $ setting command", 4: "A negative value where it must be positive", 5: "Homing is not enabled ($22)",
    8: "Not allowed while the machine is not idle", 9: "Locked: the machine is in an alarm and needs unlocking or homing", 10: "Soft limits need homing first", 11: "The line is too long",
    15: "Jog target is outside the machine limits", 20: "Unsupported or invalid G-code command", 21: "More than one G-code from the same group on one line", 22: "A feed rate is missing",
    23: "A G-code command needs a whole number", 24: "Two G-code commands both want the axis words", 33: "The target of that arc is not valid", 34: "An arc needs a radius", 35: "An arc needs an I, J or K offset",
}


@dataclass
class Status:
    state: str                      # Idle, Run, Hold, Jog, Home, Alarm, Door, Check, Sleep
    sub: int | None = None          # Hold:1 is slowing down, Hold:0 is stopped
    mpos: list[float] | None = None
    wpos: list[float] | None = None
    raw: str = ""

    @property
    def position(self) -> list[float] | None:
        return self.mpos or self.wpos

    @property
    def stopped_hold(self) -> bool:
        """Only at Hold:0 is the head really stopped (at F60 it ran on about 0.4 mm after `!`)."""
        return self.state == "Hold" and self.sub == 0


def parse_status(line: str) -> Status | None:
    """`<Idle|MPos:0.000,0.000,0.000|FS:0,0>` or `<Hold:0|...>`."""
    m = _STATUS.match(line.strip())
    if not m:
        return None
    st = Status(state=m.group(1), sub=int(m.group(2)) if m.group(2) is not None else None, raw=line.strip())
    for field in m.group(3).split("|"):
        key, _, value = field.partition(":")
        if key in ("MPos", "WPos"):
            try:
                setattr(st, key.lower(), [float(v) for v in value.split(",")])
            except ValueError:
                pass
    return st


def parse_settings(lines: list[str]) -> dict[str, str]:
    """`$30=1000.000` lines to {"$30": "1000.000"}."""
    out: dict[str, str] = {}
    for line in lines:
        m = re.match(r"^(\$\d+)=(.*)$", line.strip())
        if m:
            out[m.group(1)] = m.group(2).strip()
    return out


def setting(settings: dict[str, str], key: str) -> float | None:
    try:
        return float(settings[key])
    except (KeyError, ValueError):
        return None


def decode(final: str) -> str:
    """A readable reason for `ALARM:3` or `error:20`."""
    m = re.match(r"^(ALARM|error):(\d+)$", final.strip())
    if not m:
        return final
    n = int(m.group(2))
    table = ALARMS if m.group(1) == "ALARM" else ERRORS
    return f"{final.strip()}: {table.get(n, 'see the GRBL documentation')}"
