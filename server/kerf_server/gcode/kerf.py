"""Nesting, and kerf compensation.

Closed Cut outlines are offset outward by kerf/2 and holes inward by kerf/2 (brief section 6), so the part and the
hole come out at the drawn size. Offsetting turns arcs into many short chords, so the result is fitted back to true
arcs: the G-code still uses G2/G3.
"""
from __future__ import annotations

import math

from shapely.geometry import Point as SPoint
from shapely.geometry import Polygon

from .model import BedPath, Point, Seg, arc_sweep, dist
from .prepare import arc_to_cubics  # noqa: F401  (re-export for tests)

FLAT_TOL = 0.002  # mm: chords of flattened arcs stay this close to the true arc
FIT_TOL = 0.004  # mm: a run of points becomes an arc if it stays this close to one circle


def path_points(p: BedPath, tol: float = FLAT_TOL) -> list[Point]:
    """The path as points, arcs flattened. A closed path's last point equals its first."""
    pts = [p.start]
    cur = p.start
    for s in p.segs:
        if s.kind == "l":
            pts.append(s.to)
        else:
            c = s.c  # type: ignore[assignment]
            r = dist(cur, c)
            sweep = arc_sweep(cur, s.to, c, s.ccw)  # type: ignore[arg-type]
            da = 2 * math.acos(max(-1.0, min(1.0, 1 - tol / r))) if r > tol else math.pi / 2
            n = max(2, math.ceil(abs(sweep) / max(da, 1e-3)))
            a0 = math.atan2(cur[1] - c[1], cur[0] - c[0])
            for i in range(1, n):
                a = a0 + sweep * i / n
                pts.append((c[0] + r * math.cos(a), c[1] + r * math.sin(a)))
            pts.append(s.to)
        cur = s.to
    return pts


def polygon_of(p: BedPath) -> Polygon | None:
    pts = path_points(p)
    if len(pts) < 4:
        return None
    poly = Polygon(pts)
    if not poly.is_valid:
        poly = poly.buffer(0)
        if poly.is_empty:
            return None
        if poly.geom_type == "MultiPolygon":
            poly = max(poly.geoms, key=lambda g: g.area)
    return poly if poly.area > 1e-9 else None


def assign_depths(paths: list[BedPath]) -> dict[str, Polygon]:
    """Set `depth` on every Cut path: how many closed Cut outlines contain it. Returns the polygons by object id."""
    polys: dict[str, Polygon] = {}
    for p in paths:
        if p.layer == "cut" and p.closed:
            poly = polygon_of(p)
            if poly is not None:
                polys[p.object_id] = poly
    for p in paths:
        if p.layer != "cut":
            continue
        own = polys.get(p.object_id)
        probe = SPoint(p.start)
        depth = 0
        for oid, poly in polys.items():
            if oid == p.object_id:
                continue
            fat = poly.buffer(1e-6)
            if (fat.contains(own) if own is not None else fat.contains(probe)):
                depth += 1
        p.depth = depth
    return polys


# ---------------------------------------------------------------- arc fitting

def _circle(a: Point, b: Point, c: Point) -> tuple[Point, float] | None:
    d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]))
    if abs(d) < 1e-12:
        return None
    a2, b2, c2 = a[0] ** 2 + a[1] ** 2, b[0] ** 2 + b[1] ** 2, c[0] ** 2 + c[1] ** 2
    ux = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d
    uy = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d
    return (ux, uy), math.hypot(a[0] - ux, a[1] - uy)


def _fits(pts: list[Point], i: int, j: int, tol: float) -> tuple[Point, float, bool] | None:
    """If pts[i..j] lie on one circle (within tol, turning one way, under a full turn): (centre, radius, ccw)."""
    mid = (i + j) // 2
    circ = _circle(pts[i], pts[mid], pts[j])
    if circ is None:
        return None
    c, r = circ
    if r < 0.2 or r > 3000:
        return None
    prev_a = None
    sign = 0
    total = 0.0
    for k in range(i, j + 1):
        if abs(math.hypot(pts[k][0] - c[0], pts[k][1] - c[1]) - r) > tol:
            return None
        a = math.atan2(pts[k][1] - c[1], pts[k][0] - c[0])
        if prev_a is not None:
            d = (a - prev_a + math.pi) % math.tau - math.pi
            if abs(d) < 1e-12:
                return None
            s = 1 if d > 0 else -1
            if sign and s != sign:
                return None
            sign = s
            total += abs(d)
        prev_a = a
    if total > math.radians(350) or total < 1e-6:
        return None
    return c, r, sign > 0


def fit_arcs(pts: list[Point], tol: float = FIT_TOL, min_run: int = 5) -> list[Seg]:
    """Segments (lines and true arcs) for a polyline, starting at pts[0]."""
    n = len(pts)
    segs: list[Seg] = []
    i = 0
    while i < n - 1:
        j = i + min_run - 1
        fit = _fits(pts, i, j, tol) if j <= n - 1 else None
        if fit is None:
            segs.append(Seg("l", pts[i + 1]))
            i += 1
            continue
        while j + 1 <= n - 1:
            nxt = _fits(pts, i, j + 1, tol)
            if nxt is None:
                break
            fit, j = nxt, j + 1
        c, _r, ccw = fit
        segs.append(Seg("a", pts[j], c=_snap_centre(pts[i], pts[j], c), ccw=ccw))
        i = j
    return _merge_lines(pts[0], segs)


def _snap_centre(a: Point, b: Point, c: Point) -> Point:
    """Move the centre onto the perpendicular bisector of a-b, so both ends are exactly the same distance from it
    (GRBL rejects an arc whose two radii differ)."""
    mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
    dx, dy = b[0] - a[0], b[1] - a[1]
    d = math.hypot(dx, dy)
    if d < 1e-12:
        return c
    ux, uy = -dy / d, dx / d  # unit normal
    t = (c[0] - mx) * ux + (c[1] - my) * uy
    return (mx + t * ux, my + t * uy)


def _merge_lines(start: Point, segs: list[Seg], tol: float = 1e-4) -> list[Seg]:
    """Join consecutive collinear lines into one."""
    out: list[Seg] = []
    cur = start
    for s in segs:
        if s.kind == "l" and out and out[-1].kind == "l":
            prev_start = out[-2].to if len(out) >= 2 else start
            a, b, c = prev_start, out[-1].to, s.to
            cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
            dot = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])
            if abs(cross) <= tol * max(dist(a, c), 1e-9) and dot > 0:
                out[-1] = Seg("l", s.to)
                cur = s.to
                continue
        out.append(s)
        cur = s.to
    return out


# ---------------------------------------------------------------- compensation

def _ring_to_path(src: BedPath, ring: list[tuple[float, float]], keep_orientation: bool, origin_hint: Point) -> BedPath:
    pts = [(float(x), float(y)) for x, y in ring]
    if pts[0] == pts[-1]:
        pts = pts[:-1]
    # same travel direction as the drawn outline, so tab positions measured along it still mean the same thing
    def area(ps: list[Point]) -> float:
        return sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(ps, ps[1:] + ps[:1])) / 2

    src_pts = path_points(src)[:-1]
    if keep_orientation and area(pts) * area(src_pts) < 0:
        pts = pts[::-1]
    k = min(range(len(pts)), key=lambda i: dist(pts[i], origin_hint))  # start nearest where the drawn path started
    pts = pts[k:] + pts[:k]
    pts.append(pts[0])
    return BedPath(src.object_id, src.layer, True, pts[0], fit_arcs(pts), tabs=list(src.tabs), power_pct=src.power_pct, speed_mm_s=src.speed_mm_s, passes=src.passes, depth=src.depth)


def compensate(paths: list[BedPath], polys: dict[str, Polygon], kerf_mm: float) -> tuple[list[BedPath], list[str]]:
    """Apply kerf compensation to every closed Cut path. Open Cut paths and Score paths are left as drawn."""
    warnings: list[str] = []
    if kerf_mm <= 0:
        return paths, warnings
    out: list[BedPath] = []
    for p in paths:
        poly = polys.get(p.object_id)
        if p.layer != "cut" or not p.closed or poly is None:
            out.append(p)
            continue
        d = kerf_mm / 2 if p.depth % 2 == 0 else -kerf_mm / 2  # outlines grow, holes shrink
        grown = poly.buffer(d, join_style="mitre", mitre_limit=2.0, quad_segs=16)
        if grown.is_empty:
            warnings.append(f"Shape {p.object_id} is too small to cut with this kerf, so it was left out.")
            continue
        parts = list(grown.geoms) if grown.geom_type == "MultiPolygon" else [grown]
        for g in parts:
            if g.area < 1e-6:
                continue
            out.append(_ring_to_path(p, list(g.exterior.coords), True, p.start))
        if len(parts) > 1:
            warnings.append(f"Shape {p.object_id} split in two when the kerf was applied.")
    return out, warnings
