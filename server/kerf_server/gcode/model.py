"""Bed-space paths: what the post-processor works with after the job's matrices are applied."""
from __future__ import annotations

import math
from dataclasses import dataclass, field

Point = tuple[float, float]


@dataclass
class Seg:
    """One piece of a path. kind 'l' line to `to`; 'a' arc to `to` about `c` (ccw flag); 'c' cubic via c1, c2."""

    kind: str
    to: Point
    c: Point | None = None
    ccw: bool = True
    c1: Point | None = None
    c2: Point | None = None


@dataclass
class BedPath:
    object_id: str
    layer: str  # cut | score
    closed: bool
    start: Point
    segs: list[Seg]
    tabs: list[tuple[float, float]] = field(default_factory=list)  # (atLengthMm, widthMm)
    #: per-shape overrides (material test grid cells)
    power_pct: float | None = None
    speed_mm_s: float | None = None
    passes: int | None = None
    depth: int = 0  # how many closed Cut outlines contain this path (set by ordering)

    @property
    def end(self) -> Point:
        return self.segs[-1].to if self.segs else self.start


def dist(a: Point, b: Point) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def arc_sweep(start: Point, to: Point, c: Point, ccw: bool) -> float:
    """Signed sweep (+ccw) of an arc. A start equal to its end is a full turn."""
    a0 = math.atan2(start[1] - c[1], start[0] - c[0])
    a1 = math.atan2(to[1] - c[1], to[0] - c[0])
    d = (a1 - a0) % math.tau if ccw else (a0 - a1) % math.tau
    if d < 1e-9 and dist(start, to) < 1e-6:
        d = math.tau
    return d if ccw else -d


def arc_point(start: Point, c: Point, ccw: bool, sweep: float, t: float) -> Point:
    r = dist(start, c)
    a = math.atan2(start[1] - c[1], start[0] - c[0]) + sweep * t
    return (c[0] + r * math.cos(a), c[1] + r * math.sin(a))


def seg_length(start: Point, s: Seg) -> float:
    if s.kind == "l":
        return dist(start, s.to)
    if s.kind == "a":
        return dist(start, s.c) * abs(arc_sweep(start, s.to, s.c, s.ccw))  # type: ignore[arg-type]
    raise ValueError("cubics are flattened before measuring")


def path_length(p: BedPath) -> float:
    cur = p.start
    total = 0.0
    for s in p.segs:
        total += seg_length(cur, s)
        cur = s.to
    return total
