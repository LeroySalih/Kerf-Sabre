"""The diagnostic bundle: everything someone needs to work out what went wrong on a PC they cannot sit at. One zip: recent logs, the `$$` dump, the
banner, the config with the token removed, ports, cameras, a network test and the environment. No camera frames, no token."""
from __future__ import annotations

import io
import json
import platform
import sys
import urllib.request
import zipfile
from pathlib import Path
from typing import Any

from .. import __version__
from ..config import Config
from ..logs import CutterLog, utc_now


def network_test(cfg: Config, timeout: float = 5.0) -> dict[str, Any]:
    url = cfg.server_url.rstrip("/") + "/health"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return {"url": url, "ok": True, "status": r.status, "body": r.read(200).decode("utf-8", "replace")}
    except Exception as exc:  # noqa: BLE001
        return {"url": url, "ok": False, "error": f"{type(exc).__name__}: {exc}"}


def environment() -> dict[str, Any]:
    return {"cutter_version": __version__, "python": sys.version, "executable": sys.executable, "platform": platform.platform(), "machine": platform.machine(),
            "argv": [a if not a.startswith("ks_") else "***" for a in sys.argv], "time": utc_now()}


def build(cfg: Config, log: CutterLog, *, banner: str = "", settings: dict[str, str] | None = None, devices: list[dict] | None = None,
          camera_state: str = "", state: str = "", network: dict[str, Any] | None = None) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(Path(log.dir).glob("cutter.jsonl*")):  # the log and its rotated files
            text = f.read_text(encoding="utf-8", errors="replace")
            if cfg.token:
                text = text.replace(cfg.token, "***")
            z.writestr(f"logs/{f.name}", text)
        z.writestr("config.json", json.dumps(cfg.redacted(), indent=2))
        z.writestr("grbl.json", json.dumps({"banner": banner, "settings": settings or {}}, indent=2))
        z.writestr("devices.json", json.dumps({"ports": devices or [], "camera": camera_state}, indent=2))
        z.writestr("network.json", json.dumps(network or network_test(cfg), indent=2))
        z.writestr("environment.json", json.dumps({**environment(), "state": state}, indent=2))
        z.writestr("README.txt", "Kerf Cutter diagnostic bundle. The token has been removed. There are no camera pictures in here.\n")
    return buf.getvalue()
