"""Tell the Server how far a job has got, on a timer.

The job runner reports progress as it sends lines, but GRBL accepts a short job's lines within a second or so (they go into its planner
buffer) and the runner then waits minutes for the last ones to be answered while the laser is still cutting. Nothing was sent in that time, so
the Station page sat at 0%. This reports every few seconds whatever the runner is doing, with the elapsed time the page needs to draw the bar."""
from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any, Protocol


class HasProgress(Protocol):
    def progress(self) -> tuple[int, int, float]: ...


async def progress_ticker(runner: HasProgress, is_current: Callable[[], bool], send: Callable[[dict[str, Any]], Awaitable[Any]], job_id: str, estimated_s: float, interval: float = 2.0) -> None:
    """Send a progress message now and then until `is_current()` says the runner is no longer the one running."""
    while is_current():
        line, total, actual = runner.progress()
        await send({"type": "progress", "jobId": job_id, "line": line, "totalLines": total, "estimatedS": estimated_s, "actualS": actual})
        await asyncio.sleep(interval)
