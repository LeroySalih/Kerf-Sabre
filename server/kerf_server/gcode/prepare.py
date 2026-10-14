"""Job objects -> bed-space paths. Applies each object's matrix; arcs stay true arcs unless the matrix distorts them."""
from __future__ import annotations

import math
from typing import Any

from .model import BedPath, Point, Seg, arc_sweep, dist

CURVE_TOL = 0.01  # mm, how closely cubic curves are flattened to lines at output


def _apply(m: list[float], p: Point) -> Point:
    return (m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5])


def _is_similarity(m: list[float], eps: float = 1e-9) -> bool:
    return abs(m[0] * m[2] + m[1] * m[3]) < eps and abs(math.hypot(m[0], m[1]) - math.hypot(m[2], m[3])) < eps


def arc_to_cubics(start: Point, to: Point, c: Point, ccw: bool) -> list[tuple[Point, Point, Point]]:
    """Cubic Beziers (c1, c2, to), at most 90 degrees each, for an arc."""
    sweep = arc_sweep(start, to, c, ccw)
    n = max(1, math.ceil(abs(sweep) / (math.pi / 2) - 1e-9))
    step = sweep / n
    r = dist(start, c)
    k = 4 / 3 * math.tan(step / 4)
    a = math.atan2(start[1] - c[1], start[0] - c[0])
    out: list[tuple[Point, Point, Point]] = []
    for i in range(n):
        b = a + step
        p0 = (c[0] + r * math.cos(a), c[1] + r * math.sin(a))
        p3 = to if i == n - 1 else (c[0] + r * math.cos(b), c[1] + r * math.sin(b))
        out.append(((p0[0] - k * r * math.sin(a), p0[1] + k * r * math.cos(a)), (p3[0] + k * r * math.sin(b), p3[1] - k * r * math.cos(b)), p3))
        a = b
    return out


def flatten_cubic(p0: Point, c1: Point, c2: Point, p3: Point, tol: float = CURVE_TOL) -> list[Point]:
    """Points after p0 along a cubic, chords within about `tol` of it."""
    length = dist(p0, c1) + dist(c1, c2) + dist(c2, p3)
    n = max(4, math.ceil(math.sqrt(length / tol)))
    out: list[Point] = []
    for i in range(1, n + 1):
        t = i / n
        u = 1 - t
        out.append((u**3 * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t**3 * p3[0], u**3 * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t**3 * p3[1]))
    out[-1] = p3
    return out


def to_bed(obj: dict[str, Any]) -> BedPath:
    """One job object in bed space, made only of lines and arcs. A closed path gets an explicit closing segment."""
    m = [float(v) for v in obj["matrix"]]
    keep_arcs = _is_similarity(m)
    flip = (m[0] * m[3] - m[1] * m[2]) < 0
    start = _apply(m, tuple(obj["start"]))  # type: ignore[arg-type]
    cur_design: Point = tuple(obj["start"])  # type: ignore[assignment]
    cur = start
    segs: list[Seg] = []
    for s in obj["segments"]:
        to_d: Point = tuple(s["to"])  # type: ignore[assignment]
        to = _apply(m, to_d)
        if s["type"] == "line":
            segs.append(Seg("l", to))
        elif s["type"] == "arc":
            cd: Point = tuple(s["center"])  # type: ignore[assignment]
            ccw = not s["clockwise"]
            if keep_arcs:
                segs.append(Seg("a", to, c=_apply(m, cd), ccw=ccw != flip))
            else:  # a stretched arc is an ellipse: flatten it
                p0 = cur
                for c1, c2, p3 in arc_to_cubics(cur_design, to_d, cd, ccw):
                    for q in flatten_cubic(p0, _apply(m, c1), _apply(m, c2), _apply(m, p3)):
                        segs.append(Seg("l", q))
                        p0 = q
        else:
            p0 = cur
            for q in flatten_cubic(p0, _apply(m, tuple(s["c1"])), _apply(m, tuple(s["c2"])), to):  # type: ignore[arg-type]
                segs.append(Seg("l", q))
        cur_design, cur = to_d, to
    if obj["closed"] and segs and dist(segs[-1].to, start) > 1e-9:
        segs.append(Seg("l", start))
    st = obj.get("settings") or {}
    return BedPath(
        object_id=obj["id"],
        layer=obj["layer"],
        closed=bool(obj["closed"]),
        start=start,
        segs=segs,
        tabs=[(float(t["atLengthMm"]), float(t["widthMm"])) for t in obj.get("tabs", [])],
        power_pct=st.get("powerPct"),
        speed_mm_s=st.get("speedMmPerS"),
        passes=st.get("passes"),
        dash_mm=st.get("dashMm"),
    )
