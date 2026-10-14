"""Cut order (brief section 6): Score first, then Cut inside-out; nearest-neighbour travel within each group."""
from __future__ import annotations

from .model import BedPath, Point, Seg, dist


def reverse(p: BedPath) -> BedPath:
    """The same open path travelled the other way."""
    pts = [p.start] + [s.to for s in p.segs]
    segs: list[Seg] = []
    for i in range(len(p.segs) - 1, -1, -1):
        s = p.segs[i]
        to = pts[i]
        segs.append(Seg("l", to) if s.kind == "l" else Seg("a", to, c=s.c, ccw=not s.ccw))
    return BedPath(p.object_id, p.layer, p.closed, p.end, segs, tabs=list(p.tabs), power_pct=p.power_pct, speed_mm_s=p.speed_mm_s, passes=p.passes, depth=p.depth)


def nearest_neighbour(paths: list[BedPath], pos: Point) -> tuple[list[BedPath], Point]:
    """Visit paths by always going to the nearest start. Open paths may be turned round if their far end is nearer."""
    left = list(paths)
    out: list[BedPath] = []
    while left:
        best_i, best_flip, best_d = 0, False, float("inf")
        for i, p in enumerate(left):
            d = dist(pos, p.start)
            if d < best_d:
                best_i, best_flip, best_d = i, False, d
            if not p.closed:
                d2 = dist(pos, p.end)
                if d2 < best_d:
                    best_i, best_flip, best_d = i, True, d2
        p = left.pop(best_i)
        if best_flip:
            p = reverse(p)
        out.append(p)
        pos = p.end
    return out, pos


def order(paths: list[BedPath], start: Point = (0.0, 0.0)) -> list[BedPath]:
    score = [p for p in paths if p.layer == "score"]
    cut = [p for p in paths if p.layer == "cut"]
    ordered, pos = nearest_neighbour(score, start)
    for depth in sorted({p.depth for p in cut}, reverse=True):  # deepest first: holes before the outline around them
        group, pos = nearest_neighbour([p for p in cut if p.depth == depth], pos)
        ordered += group
    return ordered
