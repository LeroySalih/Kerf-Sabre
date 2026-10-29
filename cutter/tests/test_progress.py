"""Progress is reported on a timer, so the Station page's bar moves while a line waits for GRBL (the whole job is queued within a second, then M9 waits minutes)."""
from __future__ import annotations

import asyncio

from kerf_cutter.grbl.jobrun import JobRunner
from kerf_cutter.progress import progress_ticker

from .test_grbl import log, make  # noqa: F401  (log is a fixture)


class FakeRunner:
    def __init__(self):
        self.n = 0
        self.alive = True

    def progress(self):
        self.n += 1
        return 36, 38, float(self.n)


def test_the_ticker_keeps_reporting_while_the_runner_is_busy_and_stops_when_it_is_not():
    async def go():
        runner, sent = FakeRunner(), []

        async def send(msg):
            sent.append(msg)
            if len(sent) == 3:
                runner.alive = False

        await progress_ticker(runner, lambda: runner.alive, send, "job-1", 270.0, interval=0.001)
        return sent

    sent = asyncio.run(go())
    assert [m["actualS"] for m in sent] == [1.0, 2.0, 3.0]
    assert sent[0] == {"type": "progress", "jobId": "job-1", "line": 36, "totalLines": 38, "estimatedS": 270.0, "actualS": 1.0}


def test_a_runner_can_be_asked_for_progress_at_any_moment(log):
    sim, link, clock = make(log)
    r = JobRunner(link, log, "job-1", ["G21", "G90", "M9"], clock=clock, sleep=clock.sleep)
    assert r.progress() == (0, 3, 0.0)  # not started
    sim.slow_ok["M9"] = 3
    seen = []
    orig = link.command

    def spy(line, **kw):  # look at the progress while a line is waiting for GRBL
        seen.append(r.progress())
        return orig(line, **kw)

    link.command = spy
    assert r.run()[0] == "done"
    assert seen[-1][0] == 3 and seen[-1][1] == 3  # at the last line, with the time still counting
