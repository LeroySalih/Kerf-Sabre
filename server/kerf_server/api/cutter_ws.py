"""/ws/cutter: opened outbound by each Cutter with its station token."""
from __future__ import annotations

import base64
import binascii
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .. import services_run as run
from .. import services_presets as sp
from ..db import utcnow
from ..security import bearer, lookup

router = APIRouter()
MAX_JPEG = 1_500_000


def _num(v: Any) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def on_hello(hub, live, m: dict[str, Any]) -> None:
    live.cutter_version = str(m.get("cutterVersion", ""))[:64] or None
    st = m.get("grblSettings") or {}
    live.s30 = _num(st.get("$30"))
    mode = st.get("$32")
    live.laser_mode = None if mode is None else str(mode).strip() in ("1", "1.0")
    hub.server_log(live.id, "INFO", f"cutter connected v{live.cutter_version} $30={live.s30} $32={mode}")


@router.websocket("/ws/cutter")
async def cutter_socket(ws: WebSocket):
    token = bearer_from(ws)
    db, hub = ws.app.state.db, ws.app.state.hub
    who = None
    if token:
        with db.session() as s:
            who = lookup(s, token)
            # A station may only connect as a laser that is registered to its own school: this stops one school's token
            # from taking over another school's laser (laser IDs are shared across the server).
            if who is not None and who.role == "station" and sp.get_machine(s, who.school, who.id) is None:
                who = None
    if who is None or who.role != "station":
        await ws.close(code=4401)
        return
    await ws.accept()
    live = hub.get(who.id)
    if live.ws is not None:  # a restarted Cutter replaces its stale connection
        try:
            await live.ws.close(code=4000)
        except Exception:
            pass
    live.ws = ws
    live.last_seen = utcnow()
    hub.server_log(who.id, "INFO", "websocket opened")
    try:
        while True:
            m = await ws.receive_json()
            live.last_seen = utcnow()
            if not isinstance(m, dict) or m.get("station", who.id) != who.id:
                hub.server_log(who.id, "WARNING", "dropped a message for another station or of the wrong shape")
                continue
            kind = m.get("type")
            if kind == "hello":
                on_hello(hub, live, m)
            elif kind == "status":
                live.state = str(m.get("state", ""))[:32] or live.state
                mp = m.get("mpos")
                if isinstance(mp, list) and len(mp) == 3 and all(_num(v) is not None for v in mp):
                    live.mpos = [float(v) for v in mp]
                run.watchdog(db, hub, who.id)
            elif kind == "logs":
                lines = m.get("lines")
                if isinstance(lines, list):
                    hub.add_logs(who.id, lines[:500])
            elif kind == "camera":
                try:
                    jpeg = base64.b64decode(str(m.get("jpegBase64", "")), validate=True)
                except (binascii.Error, ValueError):
                    continue
                if 0 < len(jpeg) <= MAX_JPEG:
                    live.camera = jpeg  # kept in memory only: never written to disk or to the logs
            elif kind == "progress":
                live.progress = {k: m.get(k) for k in ("jobId", "line", "totalLines", "estimatedS", "actualS")}
            elif kind == "ack":
                fut = live.acks.get(str(m.get("jobId")))
                if fut is not None and not fut.done():
                    fut.set_result({"accepted": bool(m.get("accepted")), "reason": m.get("reason")})
            elif kind == "result":
                outcome = m.get("outcome")
                if outcome in ("done", "failed", "cancelled"):
                    run.finish(db, hub, who.id, str(m.get("jobId")), outcome, m.get("message"), _num(m.get("actualS")))
            else:
                hub.server_log(who.id, "WARNING", f"unknown message type {str(kind)[:32]!r}")
    except WebSocketDisconnect:
        pass
    except Exception as exc:  # bad JSON or a handler bug: drop the connection, the Cutter reconnects
        hub.server_log(who.id, "ERROR", f"websocket error: {type(exc).__name__}")
    finally:
        if live.ws is ws:
            live.ws, live.state = None, None
        hub.server_log(who.id, "INFO", "websocket closed")


def bearer_from(ws: WebSocket) -> str | None:
    h = ws.headers.get("authorization", "")
    if h.lower().startswith("bearer "):
        return h[7:].strip() or None
    return ws.query_params.get("token")
