"""Exact geometry for the clean-up pipeline: straight lines and circular arcs (curves are kept as polylines).

All coordinates are millimetres, Y-up. Arcs are always stored counter-clockwise: an arc drawn clockwise in the file is
stored as the same arc travelled the other way round, so that equal arcs compare equal.
"""
from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass

Point = tuple[float, float]
TAU = math.tau


def dist(a: Point, b: Point) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def norm_angle(a: float) -> float:
    return a % TAU


@dataclass(slots=True)
class Line:
    a: Point
    b: Point
    layer: str

    @property
    def length(self) -> float:
        return dist(self.a, self.b)


@dataclass(slots=True)
class Arc:
    """Counter-clockwise arc: from angle `a0` sweeping `sweep` radians (0 < sweep <= TAU) about (cx, cy)."""

    cx: float
    cy: float
    r: float
    a0: float
    sweep: float
    layer: str

    @property
    def start(self) -> Point:
        return (self.cx + self.r * math.cos(self.a0), self.cy + self.r * math.sin(self.a0))

    @property
    def end(self) -> Point:
        a = self.a0 + self.sweep
        return (self.cx + self.r * math.cos(a), self.cy + self.r * math.sin(a))

    @property
    def length(self) -> float:
        return self.r * self.sweep

    @property
    def is_full(self) -> bool:
        return self.sweep >= TAU - 1e-9

    def point_at(self, t: float) -> Point:
        a = self.a0 + self.sweep * t
        return (self.cx + self.r * math.cos(a), self.cy + self.r * math.sin(a))


@dataclass(slots=True)
class Curve:
    """A spline or ellipse, flattened to a polyline."""

    pts: list[Point]
    layer: str


def make_arc(cx: float, cy: float, r: float, a0: float, a1: float, layer: str) -> Arc | None:
    """Arc from `a0` to `a1` counter-clockwise (radians). Returns None for a degenerate arc."""
    if r <= 1e-9:
        return None
    sweep = (a1 - a0) % TAU
    if sweep < 1e-12:
        sweep = TAU  # DXF: equal start and end angle means a full circle
    return Arc(cx, cy, r, norm_angle(a0), min(sweep, TAU), layer)


def full_circle(cx: float, cy: float, r: float, layer: str) -> Arc | None:
    return Arc(cx, cy, r, 0.0, TAU, layer) if r > 1e-9 else None


def bulge_arc(p0: Point, p1: Point, bulge: float, layer: str) -> Arc | Line:
    """The segment from p0 to p1 with a DXF bulge (tan of a quarter of the included angle; positive = counter-clockwise)."""
    if abs(bulge) < 1e-12 or dist(p0, p1) < 1e-12:
        return Line(p0, p1, layer)
    theta = 4 * math.atan(bulge)  # signed included angle
    d = dist(p0, p1)
    r = d / (2 * math.sin(abs(theta) / 2))
    h = d / 2 / math.tan(theta / 2)  # signed distance of the centre to the left of p0->p1
    mx, my = (p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2
    cx = mx + (-(p1[1] - p0[1]) / d) * h
    cy = my + ((p1[0] - p0[0]) / d) * h
    a_start = math.atan2(p0[1] - cy, p0[0] - cx)
    a_end = math.atan2(p1[1] - cy, p1[0] - cx)
    arc = make_arc(cx, cy, r, a_start, a_end, layer) if bulge > 0 else make_arc(cx, cy, r, a_end, a_start, layer)
    return arc if arc is not None else Line(p0, p1, layer)


def arc_polyline(arc: Arc, tol: float = 0.01) -> list[Point]:
    """Points along an arc, close enough that chords are within `tol` of it."""
    da = 2 * math.acos(max(-1.0, min(1.0, 1 - tol / arc.r))) if arc.r > tol else math.pi / 2
    n = max(2, math.ceil(arc.sweep / max(da, 1e-3)))
    return [arc.point_at(i / n) for i in range(n + 1)]


def bbox(lines: list[Line], arcs: list[Arc]) -> tuple[float, float, float, float] | None:
    xs: list[float] = []
    ys: list[float] = []
    for ln in lines:
        xs += [ln.a[0], ln.b[0]]
        ys += [ln.a[1], ln.b[1]]
    for ar in arcs:
        for x, y in arc_polyline(ar, 0.05):
            xs.append(x)
            ys.append(y)
        # the cardinal extremes are exact
        for k in range(4):
            ang = k * math.pi / 2
            if (ang - ar.a0) % TAU <= ar.sweep:
                xs.append(ar.cx + ar.r * math.cos(ang))
                ys.append(ar.cy + ar.r * math.sin(ang))
    return (min(xs), min(ys), max(xs), max(ys)) if xs else None


# ---- clustering ----

def cluster(points: list[tuple[float, ...]], tol: float, chebyshev: bool = False) -> list[int]:
    """Group points that are within `tol` of each other (chained). Returns, for each point, the index of its group's first point."""
    parent = list(range(len(points)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    cell = max(tol, 1e-9)
    grid: dict[tuple[int, ...], list[int]] = defaultdict(list)
    dims = len(points[0]) if points else 0
    offsets = [()]
    for _ in range(dims):
        offsets = [o + (d,) for o in offsets for d in (-1, 0, 1)]
    for i, p in enumerate(points):
        key = tuple(math.floor(c / cell) for c in p)
        for off in offsets:
            for j in grid.get(tuple(k + o for k, o in zip(key, off)), ()):
                q = points[j]
                close = max(abs(a - b) for a, b in zip(p, q)) <= tol if chebyshev else math.dist(p, q) <= tol
                if close:
                    ri, rj = find(i), find(j)
                    if ri != rj:
                        parent[max(ri, rj)] = min(ri, rj)
        grid[key].append(i)
    return [find(i) for i in range(len(points))]
