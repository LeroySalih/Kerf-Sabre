"""Serial ports and what we know about each. The spike found: the laser is a native USB ESP32-S3 (VID 303A / PID 4001, not a CH340), the COM
number differs per PC and can change, every unit's USB serial number is the same (123456) so only the USB *location* tells two apart, and each PC
also has a non-GRBL Intel AMT "SOL" port."""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass


@dataclass
class PortInfo:
    device: str
    description: str = ""
    vid: int | None = None
    pid: int | None = None
    serial: str | None = None
    location: str | None = None
    hwid: str = ""

    def doc(self) -> dict:
        return asdict(self)


NOT_GRBL = ("active management", "(sol", "bluetooth", "standard serial over")  # AMT SOL and friends: never probe them


def list_ports() -> list[PortInfo]:
    from serial.tools import list_ports as lp

    out = []
    for p in lp.comports():
        loc = getattr(p, "location", None)
        if not loc:
            m = re.search(r"LOCATION=(\S+)", p.hwid or "")
            loc = m.group(1) if m else None
        out.append(PortInfo(p.device, p.description or "", p.vid, p.pid, getattr(p, "serial_number", None), loc, p.hwid or ""))
    return out


def probably_not_grbl(p: PortInfo) -> bool:
    d = (p.description or "").lower()
    return any(k in d for k in NOT_GRBL)


def open_serial(port: str, baud: int):
    import serial

    return serial.Serial(port, baud, timeout=0.2, write_timeout=2)
