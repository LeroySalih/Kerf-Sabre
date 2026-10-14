"""The Cutter's settings: one plain JSON file next to the program, kept across updates. The token is never logged."""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

DEFAULT_PATH = "cutter.json"


@dataclass
class Config:
    station: str = "station-1"
    server_url: str = "http://localhost:8000"
    token: str = ""
    baud: int = 115200
    #: How the laser's port is found again after a restart: {"vid", "pid", "location", "lastPort"} (see devices/manager.py).
    machine: dict[str, Any] = field(default_factory=dict)
    camera: dict[str, Any] = field(default_factory=lambda: {"enabled": True, "index": 0, "fps": 2.0, "maxWidth": 640, "quality": 70})
    log_level: str = "INFO"
    #: Home ($H) after start-up, a stop or an alarm, so the position is known again before the next job.
    auto_home: bool = True
    #: How long a lost server connection is tolerated during a cut before holding and resetting.
    ws_loss_grace_s: float = 5.0

    def ws_url(self) -> str:
        base = self.server_url.rstrip("/")
        return base.replace("https://", "wss://", 1).replace("http://", "ws://", 1) + "/api/v1/ws/cutter"

    def redacted(self) -> dict[str, Any]:
        d = asdict(self)
        d["token"] = "***" if self.token else ""
        return d


def load(path: str | Path = DEFAULT_PATH) -> Config:
    p = Path(path)
    if not p.exists():
        return Config()
    raw = json.loads(p.read_text(encoding="utf-8"))
    known = {k: v for k, v in raw.items() if k in Config.__dataclass_fields__}
    cam = {**Config().camera, **(known.pop("camera", None) or {})}
    return Config(**known, camera=cam)


def save(cfg: Config, path: str | Path = DEFAULT_PATH) -> None:
    p = Path(path)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(asdict(cfg), indent=2) + "\n", encoding="utf-8")
    tmp.replace(p)  # never leave a half-written file if the PC loses power
