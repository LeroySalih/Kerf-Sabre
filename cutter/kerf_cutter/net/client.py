"""The one outbound WebSocket to the Server (/api/v1/ws/cutter). It reconnects forever with capped, jittered backoff, sends `hello` on every
connect, and never listens on a network port. Messages in and out are the JSON of shared/openapi.yaml (CutterMessage / ServerMessage)."""
from __future__ import annotations

import asyncio
import json
import random
from collections.abc import Awaitable, Callable
from typing import Any

from ..config import Config
from ..logs import CutterLog


def default_connect(url: str, token: str):
    import websockets

    headers = {"Authorization": f"Bearer {token}"}
    try:
        return websockets.connect(url, additional_headers=headers, max_size=2**22, ping_interval=20, ping_timeout=20)
    except TypeError:  # older websockets
        return websockets.connect(url, extra_headers=headers, max_size=2**22, ping_interval=20, ping_timeout=20)


#: Close codes after which the Cutter must not reconnect by itself.
STAY_AWAY_CODES = {4000: "another Cutter connected as this laser and replaced this one", 4001: "disconnected from the Server page", 4401: "the token was refused", 4403: "this token is for a different laser"}


class ServerLink:
    def __init__(self, cfg: Config, log: CutterLog, on_message: Callable[[dict[str, Any]], Awaitable[None]], on_connected: Callable[[], Awaitable[None]],
                 on_disconnected: Callable[[], None] | None = None, connect=default_connect, sleep=asyncio.sleep):
        self.cfg, self.log, self.on_message, self.on_connected, self.on_disconnected = cfg, log, on_message, on_connected, on_disconnected
        self.connect, self.sleep = connect, sleep
        self.ws: Any = None
        self._stop = False
        self.connected_since: float | None = None

    @property
    def connected(self) -> bool:
        return self.ws is not None

    async def send(self, msg: dict[str, Any]) -> bool:
        ws = self.ws
        if ws is None:
            return False
        try:
            await ws.send(json.dumps({"station": self.cfg.station, **msg}))
            return True
        except Exception as exc:  # noqa: BLE001 - the socket died between the check and the send
            self.log.warning("ws_send_failed", error=f"{type(exc).__name__}: {exc}")
            return False

    def stop(self) -> None:
        self._stop = True

    async def run(self) -> None:
        delay = 1.0
        while not self._stop:
            started = asyncio.get_running_loop().time()
            try:
                async with self.connect(self.cfg.ws_url(), self.cfg.token) as ws:
                    self.ws = ws
                    self.log.info("ws_connected", url=self.cfg.ws_url())
                    await self.on_connected()
                    async for raw in ws:
                        try:
                            msg = json.loads(raw)
                        except ValueError:
                            self.log.warning("ws_bad_json")
                            continue
                        if isinstance(msg, dict):
                            await self.on_message(msg)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - refused, dropped, DNS, proxy: all the same to us: wait and try again
                self.log.warning("ws_error", error=f"{type(exc).__name__}: {exc}")
                code = getattr(getattr(exc, "rcvd", None), "code", None)
                if code in STAY_AWAY_CODES:  # the Server asked us to stop (or another Cutter took this laser): reconnecting would only fight
                    self.log.warning("ws_stay_away", code=code, why=STAY_AWAY_CODES[code])
                    self._stop = True
            finally:
                was = self.ws is not None
                self.ws = None
                if was:
                    self.log.warning("ws_disconnected")
                    if self.on_disconnected:
                        self.on_disconnected()
            if self._stop:
                break
            lived = asyncio.get_running_loop().time() - started
            delay = 1.0 if lived > 30 else min(30.0, delay * 2)
            await self.sleep(delay * (0.75 + random.random() * 0.5))
