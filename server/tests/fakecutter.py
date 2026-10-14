"""A stand-in for the Cutter: connects to /ws/cutter, answers like the real one will, and records what it was told."""
from __future__ import annotations

import queue
import threading
import time
from typing import Any

API = "/api/v1"


class FakeCutter:
    def __init__(self, client, token: str, station: str = "station-1", *, s30: str = "1000", laser_mode: str = "1", accept: bool = True, answer: bool = True, auto_finish: str | None = "done"):
        self.client, self.token, self.station = client, token, station
        self.accept, self.answer, self.auto_finish = accept, answer, auto_finish
        self.hello = {"type": "hello", "station": station, "cutterVersion": "test", "grblSettings": {"$30": s30, "$32": laser_mode}}
        self.received: list[dict[str, Any]] = []
        self._out: queue.Queue = queue.Queue()
        self._stop = threading.Event()
        self._ready = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def __enter__(self) -> "FakeCutter":
        self._thread.start()
        assert self._ready.wait(5), "fake cutter did not connect"
        return self

    def __exit__(self, *a) -> None:
        self._stop.set()
        self._thread.join(5)

    def send(self, msg: dict[str, Any]) -> None:
        self._out.put(msg)

    def status(self, state="Idle", mpos=(0.0, 0.0, 0.0)) -> None:
        self.send({"type": "status", "station": self.station, "state": state, "mpos": list(mpos)})

    def wait_for(self, kind: str, timeout: float = 5.0) -> dict[str, Any]:
        end = time.time() + timeout
        while time.time() < end:
            for m in self.received:
                if m.get("type") == kind or m.get("command") == kind:
                    return m
            time.sleep(0.01)
        raise AssertionError(f"never received {kind}; got {self.received}")

    def _run(self) -> None:
        with self.client.websocket_connect(f"{API}/ws/cutter", headers={"Authorization": f"Bearer {self.token}"}) as ws:
            ws.send_json(self.hello)
            self.status()
            self._ready.set()
            while not self._stop.is_set():
                while True:
                    try:
                        ws.send_json(self._out.get_nowait())
                    except queue.Empty:
                        break
                m = self._poll(ws)
                if m is None:
                    continue
                self.received.append(m)
                if m.get("type") == "run_job" and self.answer:
                    ws.send_json({"type": "ack", "station": self.station, "jobId": m["jobId"], "accepted": self.accept, "reason": None if self.accept else "nope"})
                    if self.accept and self.auto_finish:
                        ws.send_json({"type": "progress", "station": self.station, "jobId": m["jobId"], "line": 5, "totalLines": m["totalLines"]})
                        ws.send_json({"type": "result", "station": self.station, "jobId": m["jobId"], "outcome": self.auto_finish, "actualS": 1.5})

    def _poll(self, ws):
        # Starlette's test session has no receive timeout; read in a helper thread-safe way
        if not hasattr(self, "_rx"):
            self._rx: queue.Queue = queue.Queue()

            def pump():
                try:
                    while True:
                        self._rx.put(ws.receive_json())
                except Exception:
                    self._rx.put(None)

            threading.Thread(target=pump, daemon=True).start()
        try:
            return self._rx.get(timeout=0.05)
        except queue.Empty:
            return None
