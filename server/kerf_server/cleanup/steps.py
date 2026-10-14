"""The clean-up steps of brief section 7, each a small function. They are run in the brief's order by pipeline.py:

normalise -> exact dedupe -> collinear merge -> arc merge -> curves -> micro-segments -> Score/Cut conflict -> (node) -> join.
Dedupe and merge always run before join.
"""
from __future__ import annotations

import bisect
import math
from collections import defaultdict
from dataclasses import dataclass, field

from shapely import hausdorff_distance
from shapely.geometry import LineString

from .geom import TAU, Arc, Curve, Line, Point, cluster, dist

MAX_CHANGES = 500


@dataclass
class Counts:
    duplicates: int = 0
    overlaps: int = 0
    micro: int = 0
    conflicts: int = 0
    splits: int = 0
    changes: list[dict] = field(default_factory=list)

    def note(self, kind: str, *pts: Point) -> None:
        if len(self.changes) < MAX_CHANGES:
            self.changes.append({"type": kind, "points": [[round(p[0], 4), round(p[1], 4)] for p in pts]})


# ---------------------------------------------------------------- 1. normalise

def snap_lines(lines: list[Line], tol: float, counts: Counts) -> list[Line]:
    """Snap line ends that are within `tol` of each other onto one point, and drop lines that collapse to nothing."""
    pts: list[tuple[float, float]] = []
    for ln in lines:
        pts += [ln.a, ln.b]
    root = cluster(pts, tol) if pts else []
    out: list[Line] = []
    for i, ln in enumerate(lines):
        a, b = pts[root[2 * i]], pts[root[2 * i + 1]]
        if a == b:
            counts.micro += 1
            counts.note("micro", a)
            continue
        out.append(Line(a, b, ln.layer))
    return out


def normalise_arcs(arcs: list[Arc], tol: float) -> list[Arc]:
    """Snap circles with (nearly) the same centre and radius onto one, with angles in range."""
    if not arcs:
        return []
    root = cluster([(a.cx, a.cy, a.r) for a in arcs], tol, chebyshev=True)
    out: list[Arc] = []
    for i, a in enumerate(arcs):
        c = arcs[root[i]]
        sweep = min(a.sweep, TAU)
        a0 = 0.0 if sweep >= TAU - 1e-9 else a.a0 % TAU
        out.append(Arc(c.cx, c.cy, c.r, a0, sweep, a.layer))
    return out


# ---------------------------------------------------------------- 2. exact dedupe

def dedupe_lines(lines: list[Line], counts: Counts) -> list[Line]:
    seen: set[tuple] = set()
    out: list[Line] = []
    for ln in lines:
        lo, hi = sorted((ln.a, ln.b))
        key = (ln.layer, round(lo[0], 9), round(lo[1], 9), round(hi[0], 9), round(hi[1], 9))
        if key in seen:
            counts.duplicates += 1
            counts.note("duplicate", ln.a, ln.b)
            continue
        seen.add(key)
        out.append(ln)
    return out


def dedupe_arcs(arcs: list[Arc], tol: float, counts: Counts) -> list[Arc]:
    seen: set[tuple] = set()
    out: list[Arc] = []
    for a in arcs:
        atol = max(tol / a.r, 1e-9)
        key = (a.layer, round(a.cx, 6), round(a.cy, 6), round(a.r, 6), "full" if a.is_full else (round(a.a0 / atol), round(a.sweep / atol)))
        if key in seen:
            counts.duplicates += 1
            counts.note("duplicate", a.start, a.end)
            continue
        seen.add(key)
        out.append(a)
    return out


# ---------------------------------------------------------------- 3. collinear merge

def _theta(ln: Line) -> float:
    return math.atan2(ln.b[1] - ln.a[1], ln.b[0] - ln.a[0]) % math.pi


@dataclass
class Group:
    members: list[int]
    u: tuple[float, float]  # direction
    n: tuple[float, float]  # normal
    d: float  # offset of the group's line along the normal

    def interval(self, ln: Line) -> tuple[float, float]:
        ta = ln.a[0] * self.u[0] + ln.a[1] * self.u[1]
        tb = ln.b[0] * self.u[0] + ln.b[1] * self.u[1]
        return (min(ta, tb), max(ta, tb))

    def point(self, t: float) -> Point:
        return (self.d * self.n[0] + t * self.u[0], self.d * self.n[1] + t * self.u[1])


def collinear_groups(lines: list[Line], tol: float) -> list[Group]:
    """Group lines that lie on one infinite line (every end within `tol` of the group's longest line)."""
    n = len(lines)
    if n == 0:
        return []
    th = [_theta(ln) for ln in lines]
    by_theta = sorted(range(n), key=lambda i: th[i])
    sorted_th = [th[i] for i in by_theta]
    window = 1e-3
    used = [False] * n
    groups: list[Group] = []

    def candidates(t: float) -> list[int]:
        spans = [(t - window, t + window)]
        if t - window < 0:
            spans.append((math.pi + t - window, math.pi + 1e-9))
        if t + window > math.pi:
            spans.append((-1e-9, t + window - math.pi))
        out: list[int] = []
        for lo, hi in spans:
            out += by_theta[bisect.bisect_left(sorted_th, lo): bisect.bisect_right(sorted_th, hi)]
        return out

    for i in sorted(range(n), key=lambda k: -lines[k].length):
        if used[i]:
            continue
        ref = lines[i]
        t = th[i]
        u = (math.cos(t), math.sin(t))
        nrm = (-math.sin(t), math.cos(t))
        d0 = ref.a[0] * nrm[0] + ref.a[1] * nrm[1]
        members = [i]
        used[i] = True
        for j in candidates(t):
            if used[j]:
                continue
            c = lines[j]
            if abs(c.a[0] * nrm[0] + c.a[1] * nrm[1] - d0) <= tol and abs(c.b[0] * nrm[0] + c.b[1] * nrm[1] - d0) <= tol:
                members.append(j)
                used[j] = True
        groups.append(Group(members, u, nrm, d0))
    return groups


def union_intervals(ivs: list[tuple[float, float]], slack: float) -> list[tuple[float, float]]:
    """Union of 1D intervals. `slack` > 0 also joins intervals that merely touch; slack < 0 needs a real overlap."""
    out: list[list[float]] = []
    for s, e in sorted(ivs):
        if out and s <= out[-1][1] + slack:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return [(a, b) for a, b in out]


def merge_collinear(lines: list[Line], tol: float, counts: Counts) -> list[Line]:
    """Collinear lines that overlap become one longer line. Lines that only touch end to end are left alone."""
    out: list[Line] = []
    for layer in ("cut", "score"):
        mine = [ln for ln in lines if ln.layer == layer]
        for g in collinear_groups(mine, tol):
            if len(g.members) == 1:
                out.append(mine[g.members[0]])
                continue
            ivs = [(g.interval(mine[i]), i) for i in g.members]
            merged: list[list] = []  # [start, end, [member indices]]
            for (s, e), i in sorted(ivs):
                if merged and s < merged[-1][1] - tol:  # a real overlap
                    merged[-1][1] = max(merged[-1][1], e)
                    merged[-1][2].append(i)
                else:
                    merged.append([s, e, [i]])
            for s, e, idxs in merged:
                if len(idxs) == 1:
                    out.append(mine[idxs[0]])
                else:
                    counts.overlaps += len(idxs) - 1
                    ln = Line(g.point(s), g.point(e), layer)
                    counts.note("overlap", ln.a, ln.b)
                    out.append(ln)
    return out


# ---------------------------------------------------------------- 4. arc merge

def _union_circle(arcs: list[Arc], atol: float, slack: float) -> list[tuple[float, float]]:
    """Union of arcs on one circle as (start, end) angles, end possibly past TAU. A full turn is (0, TAU)."""
    ivs = sorted((a.a0, a.a0 + a.sweep) for a in arcs)
    merged: list[list[float]] = []
    for s, e in ivs:
        if merged and s <= merged[-1][1] + slack:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    # an interval running past TAU may overlap the first one again
    while len(merged) > 1 and merged[-1][1] - TAU > merged[0][0] + (slack if slack > 0 else -atol) - 1e-12:
        last = merged.pop()
        first = merged.pop(0)
        merged.append([last[0], max(last[1], first[1] + TAU)])
    out = []
    for s, e in merged:
        if e - s >= TAU - atol:
            out.append((0.0, TAU))
        else:
            out.append((s, e))
    return [(a, b) for a, b in out]


def merge_arcs(arcs: list[Arc], tol: float, counts: Counts) -> list[Arc]:
    """Arcs of the same circle that overlap become one arc (a full circle if they cover it)."""
    by_circle: dict[tuple, list[Arc]] = defaultdict(list)
    for a in arcs:
        by_circle[(a.layer, round(a.cx, 6), round(a.cy, 6), round(a.r, 6))].append(a)
    out: list[Arc] = []
    for (layer, cx, cy, r), group in by_circle.items():
        if len(group) == 1:
            out.append(group[0])
            continue
        atol = max(tol / r, 1e-9)
        merged = _union_circle(group, atol, -atol)  # overlap only
        if len(merged) == len(group):
            out.extend(group)
            continue
        counts.overlaps += len(group) - len(merged)
        for s, e in merged:
            arc = Arc(group[0].cx, group[0].cy, group[0].r, s % TAU if e - s < TAU - 1e-9 else 0.0, min(e - s, TAU), layer)
            counts.note("overlap", arc.start, arc.end)
            out.append(arc)
    return out


# ---------------------------------------------------------------- 5. curves

def dedupe_curves(curves: list[Curve], tol: float, counts: Counts) -> list[Curve]:
    """Drop curves that follow another curve's path (either way round) to within `tol`."""
    shapes = [LineString(c.pts) for c in curves]
    keep: list[int] = []
    for i, c in enumerate(curves):
        dup = False
        for j in keep:
            if curves[j].layer != c.layer:
                continue
            bi, bj = shapes[i].bounds, shapes[j].bounds
            if any(abs(x - y) > tol * 2 for x, y in zip(bi, bj)):
                continue
            if hausdorff_distance(shapes[i], shapes[j], densify=0.25) <= tol:
                dup = True
                break
        if dup:
            counts.duplicates += 1
            counts.note("duplicate", c.pts[0], c.pts[-1])
        else:
            keep.append(i)
    return [curves[i] for i in keep]


def curves_to_lines(curves: list[Curve]) -> list[Line]:
    out: list[Line] = []
    for c in curves:
        for a, b in zip(c.pts, c.pts[1:]):
            if a != b:
                out.append(Line(a, b, c.layer))
    return out


# ---------------------------------------------------------------- 6. micro-segments

def collapse_micro(lines: list[Line], arcs: list[Arc], micro: float, counts: Counts) -> tuple[list[Line], list[Arc]]:
    """Remove segments shorter than `micro`. A tiny line between two longer ones is collapsed: its ends become one point,
    so the neighbours still meet."""
    tiny = [i for i, ln in enumerate(lines) if ln.length < micro]
    if tiny:
        parent: dict[Point, Point] = {}

        def find(p: Point) -> Point:
            while parent.get(p, p) != p:
                parent[p] = parent.get(parent[p], parent[p])
                p = parent[p]
            return p

        for i in tiny:
            a, b = find(lines[i].a), find(lines[i].b)
            if a != b:
                parent[b] = a
            counts.micro += 1
            counts.note("micro", lines[i].a, lines[i].b)
        out: list[Line] = []
        tiny_set = set(tiny)
        for i, ln in enumerate(lines):
            if i in tiny_set:
                continue
            a, b = find(ln.a), find(ln.b)
            if a != b:
                out.append(Line(a, b, ln.layer))
        lines = out
    keep_arcs: list[Arc] = []
    for a in arcs:
        if a.length < micro:
            counts.micro += 1
            counts.note("micro", a.start, a.end)
        else:
            keep_arcs.append(a)
    return lines, keep_arcs


# ---------------------------------------------------------------- 7. Score / Cut conflict

def _subtract(base: list[tuple[float, float]], cut: list[tuple[float, float]], min_len: float) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for s, e in base:
        pieces = [(s, e)]
        for cs, ce in cut:
            nxt = []
            for ps, pe in pieces:
                if ce <= ps or cs >= pe:
                    nxt.append((ps, pe))
                    continue
                if cs > ps:
                    nxt.append((ps, cs))
                if ce < pe:
                    nxt.append((ce, pe))
            pieces = nxt
        out += [(ps, pe) for ps, pe in pieces if pe - ps >= min_len]
    return out


def resolve_conflicts(lines: list[Line], arcs: list[Arc], tol: float, micro: float, counts: Counts) -> tuple[list[Line], list[Arc]]:
    """The same line on both layers is cut, not scored: Score is removed wherever Cut already runs."""
    new_lines: list[Line] = []
    for g in collinear_groups(lines, tol):
        members = [lines[i] for i in g.members]
        cuts = [m for m in members if m.layer == "cut"]
        scores = [m for m in members if m.layer == "score"]
        new_lines += cuts
        if not scores or not cuts:
            new_lines += scores
            continue
        cut_union = union_intervals([g.interval(c) for c in cuts], tol)
        for sc in scores:
            s, e = g.interval(sc)
            rest = _subtract([(s, e)], cut_union, micro)
            if rest != [(s, e)]:
                counts.conflicts += 1
                counts.note("conflict", sc.a, sc.b)
            new_lines += [Line(g.point(a), g.point(b), "score") for a, b in rest]

    by_circle: dict[tuple, list[Arc]] = defaultdict(list)
    for a in arcs:
        by_circle[(round(a.cx, 6), round(a.cy, 6), round(a.r, 6))].append(a)
    new_arcs: list[Arc] = []
    for (_cx, _cy, r), group in by_circle.items():
        cuts = [a for a in group if a.layer == "cut"]
        scores = [a for a in group if a.layer == "score"]
        new_arcs += cuts
        if not scores or not cuts:
            new_arcs += scores
            continue
        atol = max(tol / r, 1e-9)
        cut_union = _union_circle(cuts, atol, atol)
        cover = [(s, e) for s, e in cut_union] + [(s + TAU, e + TAU) for s, e in cut_union]
        for sc in scores:
            s, e = sc.a0, sc.a0 + sc.sweep
            rest = _subtract([(s, e)], cover, micro / r)
            if rest != [(s, e)]:
                counts.conflicts += 1
                counts.note("conflict", sc.start, sc.end)
            for a, b in rest:
                new_arcs.append(Arc(sc.cx, sc.cy, sc.r, a % TAU, b - a, "score"))
    return new_lines, new_arcs


# ---------------------------------------------------------------- 8. node at T-junctions

def node_segments(lines: list[Line], arcs: list[Arc], tol: float, counts: Counts) -> tuple[list[Line], list[Arc]]:
    """Split a segment where another segment's end touches its middle, so shapes that meet at a T can be joined."""
    out_l: list[Line] = []
    out_a: list[Arc] = []
    for layer in ("cut", "score"):
        ls = [ln for ln in lines if ln.layer == layer]
        ar = [a for a in arcs if a.layer == layer]
        nodes: list[Point] = []
        for ln in ls:
            nodes += [ln.a, ln.b]
        for a in ar:
            nodes += [a.start, a.end]
        cell = 4.0
        grid: dict[tuple[int, int], list[Point]] = defaultdict(list)
        for p in set(nodes):
            grid[(math.floor(p[0] / cell), math.floor(p[1] / cell))].append(p)

        def near(bx0: float, by0: float, bx1: float, by1: float):
            for gx in range(math.floor((bx0 - tol) / cell), math.floor((bx1 + tol) / cell) + 1):
                for gy in range(math.floor((by0 - tol) / cell), math.floor((by1 + tol) / cell) + 1):
                    yield from grid.get((gx, gy), ())

        for ln in ls:
            (ax, ay), (bx, by) = ln.a, ln.b
            dx, dy = bx - ax, by - ay
            l2 = dx * dx + dy * dy
            cuts: list[float] = []
            for p in near(min(ax, bx), min(ay, by), max(ax, bx), max(ay, by)):
                if dist(p, ln.a) <= tol or dist(p, ln.b) <= tol:
                    continue
                t = ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2
                if 0 < t < 1 and dist(p, (ax + t * dx, ay + t * dy)) <= tol:
                    cuts.append(t)
            if not cuts:
                out_l.append(ln)
                continue
            counts.splits += len(cuts)
            ts = [0.0] + sorted(set(round(t, 9) for t in cuts)) + [1.0]
            pts = [ln.a] + [(ax + t * dx, ay + t * dy) for t in ts[1:-1]] + [ln.b]
            out_l += [Line(p, q, layer) for p, q in zip(pts, pts[1:]) if p != q]
        for a in ar:
            if a.is_full:
                out_a.append(a)
                continue
            r = a.r
            cuts_a: list[float] = []
            ex = [(a.cx - r, a.cy - r, a.cx + r, a.cy + r)]
            for p in near(*ex[0]):
                if dist(p, a.start) <= tol or dist(p, a.end) <= tol or abs(dist(p, (a.cx, a.cy)) - r) > tol:
                    continue
                ang = (math.atan2(p[1] - a.cy, p[0] - a.cx) - a.a0) % TAU
                if 0 < ang < a.sweep:
                    cuts_a.append(ang)
            if not cuts_a:
                out_a.append(a)
                continue
            counts.splits += len(cuts_a)
            angs = [0.0] + sorted(set(round(c, 9) for c in cuts_a)) + [a.sweep]
            for s, e in zip(angs, angs[1:]):
                if e - s > 1e-9:
                    out_a.append(Arc(a.cx, a.cy, a.r, (a.a0 + s) % TAU, e - s, layer))
    return out_l, out_a
