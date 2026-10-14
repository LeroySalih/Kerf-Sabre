"""The laser PC's camera: a thread grabs frames, shrinks them and keeps the latest as a JPEG in memory. Frames are NEVER written to disk or to a log.
A camera problem never affects the laser. OpenCV is optional: without it the camera is simply 'unavailable'."""
from __future__ import annotations

import os
import threading
import time
from typing import Any

from ..logs import CutterLog


def default_load_cv2():
    try:
        import cv2

        return cv2
    except Exception:  # noqa: BLE001 - a missing camera library must not stop the laser working
        return None


class CameraCapture:
    def __init__(self, cfg: dict[str, Any], log: CutterLog, load_cv2=default_load_cv2, clock=time.monotonic, sleep=time.sleep):
        self.cfg, self.log, self.load_cv2, self.clock, self.sleep = cfg, log, load_cv2, clock, sleep
        self.state = "off" if not cfg.get("enabled", True) else "starting"
        self._lock = threading.Lock()
        self._jpeg: bytes | None = None
        self._seq = 0
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def latest(self) -> tuple[int, bytes] | None:
        with self._lock:
            return (self._seq, self._jpeg) if self._jpeg else None

    def _set(self, state: str, **d: Any) -> None:
        if state != self.state:
            self.state = state
            self.log.info("camera_state", state=state, **d)

    def start(self) -> None:
        if not self.cfg.get("enabled", True):
            return
        self._thread = threading.Thread(target=self._run, name="camera", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _run(self) -> None:
        cv2 = self.load_cv2()
        if cv2 is None:
            self._set("unavailable", reason="OpenCV is not installed")
            return
        index = int(self.cfg.get("index", 0))
        interval = 1.0 / max(0.2, float(self.cfg.get("fps", 2.0)))
        max_w, quality = int(self.cfg.get("maxWidth", 640)), int(self.cfg.get("quality", 70))
        backoff, cap = None, None
        while not self._stop.is_set():
            try:
                cap = cv2.VideoCapture(index, getattr(cv2, "CAP_DSHOW", 0)) if os.name == "nt" else cv2.VideoCapture(index)
                if not cap.isOpened():
                    raise RuntimeError(f"camera {index} did not open")
                self._set("ok", index=index)
                backoff = None
                while not self._stop.is_set():
                    t = self.clock()
                    ok, frame = cap.read()
                    if not ok or frame is None:
                        raise RuntimeError("no frame")
                    h, w = frame.shape[:2]
                    if w > max_w:
                        frame = cv2.resize(frame, (max_w, int(h * max_w / w)))
                    ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
                    if ok:
                        with self._lock:
                            self._jpeg, self._seq = bytes(buf), self._seq + 1
                    self.sleep(max(0.0, interval - (self.clock() - t)))
            except Exception as exc:  # noqa: BLE001
                self._set("missing", error=f"{type(exc).__name__}: {exc}")
                backoff = min(30.0, (backoff or 1.0) * 2)
                self.sleep(backoff)
            finally:
                try:
                    if cap is not None:
                        cap.release()
                except Exception:  # noqa: BLE001
                    pass
