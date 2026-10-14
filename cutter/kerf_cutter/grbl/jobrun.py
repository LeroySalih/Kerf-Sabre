"""Stream a job to GRBL: send a line, wait for its `ok` (GRBL answers when the line is in its planner, so this keeps the buffer full without
character counting), poll for alarms, and obey stop and pause at any moment.

Fault policy (the brief): any serial error, GRBL ALARM or error:N, or a stopped answer means feed hold then soft reset, and the job FAILED with a
readable reason. After a stop or a fault the machine position is not trusted until it has been homed again."""
from __future__ import annotations

import threading
import time
from collections.abc import Callable

from ..logs import CutterLog
from .link import HOLD, RESET, RESUME, Link
from .state import decode

Result = tuple[str, str, float]  # (outcome: done | failed | cancelled, message, actual seconds)
STATUS_EVERY = 25  # lines between alarm checks


class JobRunner:
    def __init__(self, link: Link, log: CutterLog, job_id: str, lines: list[str], *, estimated_s: float = 0.0,
                 on_progress: Callable[[int, int, float], None] | None = None, on_state: Callable[[str], None] | None = None,
                 clock=time.monotonic, sleep=time.sleep):
        self.link, self.log, self.job_id, self.lines, self.estimated_s = link, log, job_id, lines, estimated_s
        self.on_progress, self.on_state, self.clock, self.sleep = on_progress, on_state, clock, sleep
        self._stop, self._paused = threading.Event(), threading.Event()
        self.line = 0

    # ---- controls (any thread; realtime bytes skip the link lock so they act at once)
    def stop(self) -> None:
        self._stop.set()
        self._paused.clear()
        self.log.warning("job_stop", job_id=self.job_id)
        self._halt()

    def pause(self) -> None:
        if not self._paused.is_set():
            self._paused.set()
            self.link.realtime(HOLD)
            self.log.info("job_pause", job_id=self.job_id, line=self.line)

    def resume(self) -> None:
        if self._paused.is_set():
            self.link.realtime(RESUME)
            self._paused.clear()
            self.log.info("job_resume", job_id=self.job_id, line=self.line)

    @property
    def paused(self) -> bool:
        return self._paused.is_set()

    def _halt(self) -> None:
        """Feed hold, then soft reset. Best effort: if the port is gone there is nothing more to do."""
        for b in (HOLD, RESET):
            try:
                self.link.realtime(b)
            except Exception:  # noqa: BLE001 - already logged by the link
                return
            self.sleep(0.05)

    def _fault(self, message: str, t0: float) -> Result:
        self.log.error("job_fault", job_id=self.job_id, line=self.line, reason=message)
        self._halt()
        return "failed", message, round(self.clock() - t0, 1)

    # ---- the run
    def run(self) -> Result:
        t0 = self.clock()
        total = len(self.lines)
        last_progress = t0
        try:
            for i, line in enumerate(self.lines, 1):
                self.line = i
                if self._stop.is_set():
                    return "cancelled", "Stopped", round(self.clock() - t0, 1)
                while self._paused.is_set() and not self._stop.is_set():
                    if self.on_state:
                        st = self.link.status()
                        if st and st.stopped_hold:
                            self.on_state("Hold")
                    self.sleep(0.1)
                _lines, final = self.link.command(line, timeout=15.0, abort=self._stop.is_set, paused=self._paused.is_set)
                if final == "aborted":
                    return "cancelled", "Stopped", round(self.clock() - t0, 1)
                if final != "ok":
                    if final == "timeout":
                        return self._fault(f"The laser stopped answering at line {i} of {total} ({line[:60]}).", t0)
                    return self._fault(f"The laser refused line {i} of {total} ({line[:60]}): {decode(final)}", t0)
                now = self.clock()
                if i % STATUS_EVERY == 0:
                    st = self.link.status()
                    if st and st.state.startswith("Alarm"):
                        return self._fault(f"The laser raised an alarm during the job (line {i} of {total}).", t0)
                if self.on_progress and (now - last_progress >= 1.0 or i == total):
                    last_progress = now
                    self.on_progress(i, total, round(now - t0, 1))
            # every line is queued: wait until the machine has finished moving
            limit = max(60.0, self.estimated_s * 3 + 30)
            st = self.link.wait_idle(timeout=limit, abort=self._stop.is_set)
            if self._stop.is_set():
                return "cancelled", "Stopped", round(self.clock() - t0, 1)
            if not st or not st.state.startswith("Idle"):
                return self._fault("The laser did not finish: " + (f"it reports {st.state}." if st else "it stopped answering."), t0)
            for safe in ("M5", "M9"):  # laser off and air off, whatever the file said
                self.link.command(safe, timeout=3.0)
            if self.on_progress:
                self.on_progress(total, total, round(self.clock() - t0, 1))
            return "done", "", round(self.clock() - t0, 1)
        except Exception as exc:  # serial gone, port unplugged, anything unexpected: hold and reset, then say so
            return self._fault(f"Lost the link to the laser: {type(exc).__name__}: {exc}", t0)
