"""The two plain HTTP calls the Cutter makes, with the standard library only: fetch a job's G-code (and check its SHA-256), upload a diagnostic bundle."""
from __future__ import annotations

import hashlib
import urllib.error
import urllib.request
import uuid

from ..config import Config


class FetchError(Exception):
    pass


def _open(req: urllib.request.Request, timeout: float):
    try:
        return urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as exc:
        raise FetchError(f"The server answered {exc.code} for {req.full_url.split('?')[0]}") from exc
    except Exception as exc:  # noqa: BLE001
        raise FetchError(f"Could not reach the server: {type(exc).__name__}: {exc}") from exc


def fetch_gcode(cfg: Config, path: str, sha256: str | None, timeout: float = 30.0) -> str:
    """The G-code at `path` on the server, checked against its hash. Raises FetchError on any problem (and on a mismatch)."""
    req = urllib.request.Request(cfg.server_url.rstrip("/") + path, headers={"Authorization": f"Bearer {cfg.token}"})
    with _open(req, timeout) as resp:
        data = resp.read()
    got = hashlib.sha256(data).hexdigest()
    if sha256 and got != sha256:
        raise FetchError("The G-code does not match its checksum, so it was damaged or changed on the way. Not running it.")
    return data.decode("utf-8")


def upload_diagnostics(cfg: Config, zip_bytes: bytes, timeout: float = 60.0) -> str:
    boundary = uuid.uuid4().hex
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="bundle.zip"\r\nContent-Type: application/zip\r\n\r\n').encode() + zip_bytes + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(f"{cfg.server_url.rstrip('/')}/api/v1/stations/{cfg.station}/diagnostics/upload", data=body, method="POST",
                                 headers={"Authorization": f"Bearer {cfg.token}", "Content-Type": f"multipart/form-data; boundary={boundary}"})
    with _open(req, timeout) as resp:
        return resp.read().decode("utf-8", "replace")
