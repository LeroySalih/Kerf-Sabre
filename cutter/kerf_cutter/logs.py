"""JSON-lines logging for a PC nobody can debug in person: every event goes to a rotating local file (even with no network), to a
ring buffer, and to a queue the network client ships to the Server. The token and any registered secret are never written.
No camera frames, ever. Pupil IDs only, never names."""
from __future__ import annotations

import json
import logging
import logging.handlers
import threading
import time
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

LEVELS = {"DEBUG": 10, "INFO": 20, "WARNING": 30, "ERROR": 40}
MAX_FIELD = 2000


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class CutterLog:
    def __init__(self, directory: Path | str, station: str, level: str = "INFO", max_bytes: int = 10_000_000, backups: int = 10, clock=time.monotonic, echo=None):
        self.dir = Path(directory)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.station = station
        #: A text stream (stdout) that gets a readable line for every event and EVERY serial command and reply, whatever the file level.
        self.echo = echo
        self.level = LEVELS.get(level.upper(), 20)
        self._debug_until: float | None = None
        self.clock = clock
        self._lock = threading.Lock()
        self._secrets: list[str] = []
        self.recent: deque[dict[str, Any]] = deque(maxlen=5000)
        self.ship: deque[dict[str, Any]] = deque(maxlen=5000)  # lines not yet sent to the Server
        self._logger = logging.getLogger(f"kerf.cutter.{id(self)}")
        self._logger.setLevel(logging.DEBUG)
        self._logger.propagate = False
        self.path = self.dir / "cutter.jsonl"
        self._handler = logging.handlers.RotatingFileHandler(self.path, maxBytes=max_bytes, backupCount=backups, encoding="utf-8")
        self._handler.setFormatter(logging.Formatter("%(message)s"))
        self._logger.addHandler(self._handler)

    def add_secret(self, secret: str) -> None:
        if secret and secret not in self._secrets:
            self._secrets.append(secret)

    def _clean(self, v: Any) -> Any:
        if isinstance(v, str):
            for s in self._secrets:
                v = v.replace(s, "***")
            return v[:MAX_FIELD]
        if isinstance(v, (int, float, bool)) or v is None:
            return v
        if isinstance(v, dict):
            return {str(k): self._clean(x) for k, x in v.items()}
        if isinstance(v, (list, tuple)):
            return [self._clean(x) for x in v[:200]]
        return self._clean(repr(v))

    def _effective_level(self) -> int:
        if self._debug_until is not None and self.clock() >= self._debug_until:
            self._debug_until, self.level = None, LEVELS["INFO"]  # remote DEBUG switches itself off
        return self.level

    def _echo(self, line: dict[str, Any]) -> None:
        """One readable line on stdout: `12:34:56.789 TX  G1 X10 Y10 S500`, or `12:34:56.789 INFO frame_start job_id=... bounds=...`."""
        if self.echo is None:
            return
        when = line["timestamp"][11:23]
        if line["event"] == "serial":
            out = f"{when} {line['dir']:<2} {line['data']}"
        else:
            rest = " ".join(f"{k}={v}" for k, v in line.items() if k not in ("timestamp", "level", "station", "event") and v is not None)
            out = f"{when} {line['level']:<7} {line['event']} {rest}".rstrip()
        try:
            print(out, file=self.echo, flush=True)
        except Exception:  # a closed console must never stop a cut
            self.echo = None

    def log(self, level: str, event: str, job_id: str | None = None, **detail: Any) -> None:
        n = LEVELS.get(level.upper(), 20)
        wanted = n >= self._effective_level()
        if not wanted and not (self.echo is not None and event == "serial"):
            return
        line = {"timestamp": utc_now(), "level": level.upper(), "station": self.station, "job_id": job_id, "event": event, **self._clean(detail)}
        self._echo(line)
        if not wanted:
            return  # raw serial traffic with the level at INFO: shown on the console only
        text = json.dumps(line, separators=(",", ":"), default=str)
        with self._lock:
            self._logger.log(logging.INFO, text)
            self.recent.append(line)
            if n >= LEVELS["INFO"]:
                self.ship.append(line)

    def debug(self, event: str, **d: Any) -> None: self.log("DEBUG", event, **d)
    def info(self, event: str, **d: Any) -> None: self.log("INFO", event, **d)
    def warning(self, event: str, **d: Any) -> None: self.log("WARNING", event, **d)
    def error(self, event: str, **d: Any) -> None: self.log("ERROR", event, **d)

    def serial(self, direction: str, data: str) -> None:
        """Raw serial traffic: DEBUG only (and not shipped), so it is there when someone turns DEBUG on to chase a problem."""
        self.log("DEBUG", "serial", dir=direction, data=data)

    def set_level(self, level: str, debug_minutes: float = 30.0) -> None:
        """Set the level (remote control). DEBUG expires after `debug_minutes` so a forgotten setting cannot fill the disk."""
        lv = LEVELS.get(str(level).upper())
        if lv is None:
            return
        self.level = lv
        self._debug_until = self.clock() + debug_minutes * 60 if lv < LEVELS["INFO"] else None
        self.log("INFO", "log_level_set", new_level=str(level).upper())

    def drain(self, limit: int = 200) -> list[dict[str, Any]]:
        with self._lock:
            return [self.ship.popleft() for _ in range(min(limit, len(self.ship)))]

    def requeue(self, lines: list[dict[str, Any]]) -> None:
        """Put lines back at the front when sending them failed."""
        with self._lock:
            self.ship.extendleft(reversed(lines))

    def close(self) -> None:
        self._handler.close()
        self._logger.removeHandler(self._handler)
