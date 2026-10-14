"""Live state of the laser stations. Each Cutter opens an outbound WebSocket; this is what the Server knows about it."""
from __future__ import annotations

import asyncio
import json
import logging
import logging.handlers
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import WebSocket

from .db import iso, utcnow
from .errors import ApiError

LEVELS = {"DEBUG": 10, "INFO": 20, "WARNING": 30, "ERROR": 40}
MAX_LINE_FIELD = 2000


@dataclass
class Live:
    id: str
    ws: WebSocket | None = None
    state: str | None = None
    mpos: list[float] | None = None
    current_job: str | None = None
    cutter_version: str | None = None
    s30: float | None = None
    laser_mode: bool | None = None
    last_seen: datetime | None = None
    camera: bytes | None = None
    progress: dict[str, Any] | None = None
    acks: dict[str, asyncio.Future] = field(default_factory=dict)
    logs: deque = field(default_factory=lambda: deque(maxlen=5000))

    @property
    def online(self) -> bool:
        return self.ws is not None

    def doc(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "online": self.online,
            "state": self.state,
            "mpos": self.mpos,
            "currentJobId": self.current_job,
            "cutterVersion": self.cutter_version,
            "s30": self.s30,
            "laserMode": self.laser_mode,
            "progress": self.progress,
            "cameraAvailable": self.camera is not None,
            "lastSeen": iso(self.last_seen),
        }


class Hub:
    def __init__(self, log_dir: Path, max_bytes: int, backups: int):
        self.log_dir, self.max_bytes, self.backups = log_dir, max_bytes, backups
        self.stations: dict[str, Live] = {}
        self._files: dict[str, logging.Logger] = {}

    def get(self, station_id: str) -> Live:
        return self.stations.setdefault(station_id, Live(station_id))

    def online(self, station_id: str) -> Live:
        live = self.stations.get(station_id)
        if live is None or not live.online:
            raise ApiError(409, "station_offline", f"{station_id} is not connected. Check the Cutter is running on that PC.")
        return live

    async def send(self, station_id: str, msg: dict[str, Any]) -> None:
        live = self.online(station_id)
        try:
            await live.ws.send_json(msg)  # type: ignore[union-attr]
        except Exception as exc:  # the socket died between the check and the send
            live.ws = None
            raise ApiError(409, "station_offline", f"{station_id} stopped answering.") from exc

    def expect_ack(self, station_id: str, job_id: str) -> asyncio.Future:
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self.get(station_id).acks[job_id] = fut
        return fut

    # ---- logs
    def add_logs(self, station_id: str, lines: list[dict[str, Any]]) -> None:
        live = self.get(station_id)
        lg = self._file_logger(station_id)
        for raw in lines:
            if not isinstance(raw, dict):
                continue
            line = {k: (v[:MAX_LINE_FIELD] if isinstance(v, str) else v) for k, v in raw.items()}
            line["station"] = station_id
            live.logs.append(line)
            lg.info(json.dumps(line, separators=(",", ":")))

    def _file_logger(self, station_id: str) -> logging.Logger:
        lg = self._files.get(station_id)
        if lg is None:
            self.log_dir.mkdir(parents=True, exist_ok=True)
            lg = logging.getLogger(f"kerf.cutterlog.{id(self)}.{station_id}")
            lg.setLevel(logging.INFO)
            lg.propagate = False
            h = logging.handlers.RotatingFileHandler(self.log_dir / f"{station_id}.jsonl", maxBytes=self.max_bytes, backupCount=self.backups, encoding="utf-8")
            h.setFormatter(logging.Formatter("%(message)s"))
            lg.addHandler(h)
            self._files[station_id] = lg
        return lg

    def recent_logs(self, station_id: str, limit: int, level: str | None) -> list[dict[str, Any]]:
        floor = LEVELS.get(level or "DEBUG", 10)
        rows = [l for l in self.get(station_id).logs if LEVELS.get(str(l.get("level", "INFO")).upper(), 20) >= floor]
        return rows[-limit:]

    def server_log(self, station_id: str, level: str, event: str, job_id: str | None = None) -> None:
        """The server's own entries in a station's log, so one file tells the whole story."""
        self.add_logs(station_id, [{"timestamp": utcnow().isoformat(), "level": level, "job_id": job_id, "event": event, "origin": "server"}])

    def close(self) -> None:
        for lg in self._files.values():
            for h in list(lg.handlers):
                h.close()
                lg.removeHandler(h)
        self._files.clear()
