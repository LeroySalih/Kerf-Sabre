"""The Cutter's two plain HTTP calls must not look like Python's default client: Cloudflare in front of the school's server answers 403 to it."""
from __future__ import annotations

import hashlib
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from kerf_cutter.config import Config
from kerf_cutter.net import http

GCODE = "G21\nG90\nM2\n"


class Handler(BaseHTTPRequestHandler):
    seen: list[dict[str, str]] = []

    def _answer(self, ok_body: bytes) -> None:
        self.seen.append(dict(self.headers))
        if (self.headers.get("User-Agent") or "").startswith("Python-urllib"):  # what Cloudflare does
            self.send_response(403)
            self.end_headers()
            self.wfile.write(b"error code: 1010")
            return
        self.send_response(200)
        self.end_headers()
        self.wfile.write(ok_body)

    def do_GET(self) -> None:  # noqa: N802
        self._answer(GCODE.encode())

    def do_POST(self) -> None:  # noqa: N802
        self.rfile.read(int(self.headers.get("Content-Length", "0")))
        self._answer(b"ok")

    def log_message(self, *a) -> None:  # noqa: D401
        pass


@pytest.fixture()
def server():
    Handler.seen = []
    srv = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()


def test_gcode_download_names_itself_and_is_not_blocked(server):
    cfg = Config(server_url=server, token="ks_secret")
    text = http.fetch_gcode(cfg, "/api/v1/jobs/job-1/gcode?station=station-1", hashlib.sha256(GCODE.encode()).hexdigest())
    assert text == GCODE
    sent = Handler.seen[0]
    assert sent["User-Agent"].startswith("kerf-cutter/")
    assert sent["Authorization"] == "Bearer ks_secret"


def test_diagnostic_upload_names_itself_too(server):
    cfg = Config(server_url=server, token="ks_secret")
    assert http.upload_diagnostics(cfg, b"zip") == "ok"
    assert Handler.seen[0]["User-Agent"].startswith("kerf-cutter/")


def test_a_refusal_says_what_the_other_end_said(server, monkeypatch):
    monkeypatch.setattr(http, "USER_AGENT", "Python-urllib/3.11")  # pretend we are the blocked default agent
    cfg = Config(server_url=server, token="t")
    with pytest.raises(http.FetchError) as e:
        http.fetch_gcode(cfg, "/api/v1/jobs/job-1/gcode?station=station-1", None)
    assert "403" in str(e.value) and "error code: 1010" in str(e.value) and "station=" not in str(e.value)
