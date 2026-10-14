"""Finding the laser's serial port, and keeping the choice across restarts, replugs and a different USB socket.

The choice is saved as a match rule, not a bare COM name: {vid, pid, location, lastPort}. Order on start: the saved COM port if it still answers like
GRBL; else a port matching the rule; else probe every other port that could be GRBL. Two GRBL machines at once with no rule: do not guess.
A probe never holds a port: open, soft reset, expect the Grbl banner, read $$, close. The one we use stays open."""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from ..config import Config
from ..grbl.link import Link
from ..logs import CutterLog
from .ports import PortInfo, list_ports as default_list_ports, open_serial as default_open_serial, probably_not_grbl

BUSY_HINT = "Another program has this port open (LightBurn, LaserGRBL, Creality software, or a serial monitor). Close it and try again."


@dataclass
class Probe:
    port: PortInfo
    state: str                      # grbl | silent | busy | error
    message: str = ""
    banner: str = ""
    settings: dict[str, str] = field(default_factory=dict)
    ser: Any = None                 # left open only when asked to keep it


class DeviceManager:
    def __init__(self, cfg: Config, log: CutterLog, list_ports=default_list_ports, open_serial=default_open_serial, clock=time.monotonic, sleep=time.sleep):
        self.cfg, self.log, self.list_ports, self.open_serial, self.clock, self.sleep = cfg, log, list_ports, open_serial, clock, sleep
        self.last: list[Probe] = []

    def probe(self, port: PortInfo, keep: bool = False) -> Probe:
        self.log.info("probe_port", port=port.device, vid=port.vid, pid=port.pid, location=port.location)
        try:
            ser = self.open_serial(port.device, self.cfg.baud)
        except Exception as exc:  # noqa: BLE001
            text = f"{type(exc).__name__}: {exc}"
            busy = any(k in text.lower() for k in ("denied", "permissionerror", "busy", "in use"))
            self.log.warning("port_open_failed", port=port.device, error=text, busy=busy)
            return Probe(port, "busy" if busy else "error", BUSY_HINT if busy else f"Could not open {port.device}: {text}. Check the cable and the driver.")
        link = Link(ser, self.log, self.clock, self.sleep)
        try:
            banner = link.reset(timeout=3.0)
            if not banner:
                return self._close(ser, Probe(port, "silent", "No Grbl banner after a soft reset: not a GRBL laser."))
            settings = link.settings()
            self.log.info("probe_grbl", port=port.device, banner=banner, settings_read=len(settings))
            p = Probe(port, "grbl", "", banner, settings, ser if keep else None)
            return p if keep else self._close(ser, p)
        except Exception as exc:  # noqa: BLE001
            self.log.warning("probe_failed", port=port.device, error=f"{type(exc).__name__}: {exc}")
            return self._close(ser, Probe(port, "error", f"{type(exc).__name__}: {exc}"))

    @staticmethod
    def _close(ser, probe: Probe) -> Probe:
        try:
            ser.close()
        except Exception:  # noqa: BLE001
            pass
        return probe

    def order(self, ports: list[PortInfo]) -> list[PortInfo]:
        rule = self.cfg.machine or {}
        usable = [p for p in ports if not probably_not_grbl(p)]

        def rank(p: PortInfo) -> tuple[int, str]:
            if rule.get("lastPort") and p.device == rule["lastPort"]:
                return 0, p.device
            if rule and all(rule.get(k) in (None, getattr(p, k)) for k in ("vid", "pid", "location")) and any(rule.get(k) is not None for k in ("vid", "pid", "location")):
                return 1, p.device
            return (2 if p.vid is not None else 3), p.device

        return sorted(usable, key=rank)

    def connect(self) -> Probe | None:
        """The laser's port, open and ready (state "grbl"), or None. Remembers what it found in the config's machine rule (the caller saves it)."""
        ports = self.list_ports()
        self.log.info("ports", ports=[p.doc() for p in ports])
        self.last = []
        found: list[Probe] = []
        for p in self.order(ports):
            pr = self.probe(p, keep=True)
            self.last.append(pr)
            if pr.state == "grbl":
                found.append(pr)
                if (self.cfg.machine or {}).get("lastPort") == p.device or self._matches_rule(p):
                    break  # the machine we were told to use: no need to look further
                if len(found) > 1:
                    break
        if not found:
            return None
        if len(found) > 1 and not self.cfg.machine:
            for extra in found:
                self._close(extra.ser, extra)
            self.log.error("ambiguous_machine", ports=[f.port.device for f in found])
            return None
        chosen = found[0]
        for extra in found[1:]:
            self._close(extra.ser, extra)
        p = chosen.port
        self.cfg.machine = {"vid": p.vid, "pid": p.pid, "location": p.location, "lastPort": p.device}
        self.log.info("machine_chosen", **self.cfg.machine)
        return chosen

    def _matches_rule(self, p: PortInfo) -> bool:
        rule = self.cfg.machine or {}
        keys = [k for k in ("vid", "pid", "location") if rule.get(k) is not None]
        return bool(keys) and all(rule[k] == getattr(p, k) for k in keys)

    def describe(self) -> list[dict]:
        return [{**pr.port.doc(), "state": pr.state, "message": pr.message} for pr in self.last]
