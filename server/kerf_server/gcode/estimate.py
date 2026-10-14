"""Cut-time estimate: a small GRBL-style planner (trapezoids, junction speeds) over the generated G-code."""
from __future__ import annotations

import math

from .motion import Motion

ACCEL = 1000.0  # mm/s^2, until the machine profile carries it
RAPID = 200.0  # mm/s


def _dir(m: Motion, at_end: bool) -> tuple[float, float]:
    if m.kind == "arc":
        c = m.centre  # type: ignore[assignment]
        p = m.end if at_end else m.start
        rx, ry = p[0] - c[0], p[1] - c[1]
        tx, ty = (-ry, rx) if m.ccw else (ry, -rx)
    else:
        tx, ty = m.end[0] - m.start[0], m.end[1] - m.start[1]
    n = math.hypot(tx, ty)
    return (tx / n, ty / n) if n else (0.0, 0.0)


def duration(motions: list[Motion], accel: float = ACCEL) -> float:
    ms = [m for m in motions if m.length > 1e-9]
    if not ms:
        return 0.0
    vmax = [RAPID if m.kind == "rapid" else max(m.feed_mm_s, 0.1) for m in ms]
    n = len(ms)
    # junction speeds: slow right down for sharp corners, keep speed through smooth ones
    junc = [0.0] * (n + 1)
    for i in range(1, n):
        a, b = _dir(ms[i - 1], True), _dir(ms[i], False)
        cos = a[0] * b[0] + a[1] * b[1]
        junc[i] = min(vmax[i - 1], vmax[i]) * max(0.0, cos) ** 4
    for i in range(n - 1, -1, -1):  # backward: must be able to brake
        junc[i] = min(junc[i], math.sqrt(junc[i + 1] ** 2 + 2 * accel * ms[i].length))
    for i in range(n):  # forward: must be able to accelerate
        junc[i + 1] = min(junc[i + 1], math.sqrt(junc[i] ** 2 + 2 * accel * ms[i].length))
    total = 0.0
    for i, m in enumerate(ms):
        v0, v1, vm, d = junc[i], junc[i + 1], vmax[i], m.length
        peak = math.sqrt((2 * accel * d + v0 * v0 + v1 * v1) / 2)
        if peak <= vm:
            total += (2 * peak - v0 - v1) / accel
        else:
            da, db = (vm * vm - v0 * v0) / (2 * accel), (vm * vm - v1 * v1) / (2 * accel)
            total += (vm - v0) / accel + (vm - v1) / accel + (d - da - db) / vm
    return total
