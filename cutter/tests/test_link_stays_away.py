"""When the Server closes the connection with 'stay away' (disconnected from the Station page, replaced by another Cutter, bad token), the Cutter must not reconnect."""
import asyncio
from types import SimpleNamespace

import pytest

from kerf_cutter.net.client import STAY_AWAY_CODES, ServerLink


class Closed(Exception):
    def __init__(self, code):
        self.rcvd = SimpleNamespace(code=code)


class Cfg:
    token, station = "ks_x", "station-1"
    def ws_url(self): return "wss://x/ws"


class Log:
    def __getattr__(self, name): return lambda *a, **k: None


def make(code, attempts):
    class Conn:
        async def __aenter__(self):
            attempts.append(1)
            raise Closed(code)
        async def __aexit__(self, *a): return False
    holder = {}
    async def sleep(s):
        attempts.append("slept")
        if len(attempts) > 6:
            holder["link"].stop()  # an ordinary drop keeps retrying; end the test after a few
        await asyncio.sleep(0)
    async def noop(*a): pass
    holder["link"] = ServerLink(Cfg(), Log(), noop, noop, connect=lambda url, token: Conn(), sleep=sleep)
    return holder["link"]


@pytest.mark.parametrize("code", sorted(STAY_AWAY_CODES))
def test_it_does_not_reconnect(code):
    attempts = []
    asyncio.run(asyncio.wait_for(make(code, attempts).run(), 2))
    assert attempts == [1]


def test_an_ordinary_drop_still_reconnects():
    attempts = []
    asyncio.run(asyncio.wait_for(make(1006, attempts).run(), 2))
    assert attempts.count(1) > 1 and "slept" in attempts
