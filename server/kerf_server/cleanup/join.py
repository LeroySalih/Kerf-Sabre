"""Auto-join: turn loose segments into closed shapes and open paths.

Segments become the edges of a planar graph (nodes = ends that meet within the join tolerance). Dangling spurs are
set aside as open paths; faces are traced on what is left, so two parts that share an edge each get their own closed
outline (the shared edge appears in both). Arcs stay exact arcs throughout.
"""
from __future__ import annotations

import math
from collections import defaultdict, deque
from dataclasses import dataclass

from .geom import TAU, Arc, Line, Point, arc_polyline, cluster


@dataclass
class PathOut:
    layer: str
    closed: bool
    start: Point
    # each segment: ("line", to) or ("arc", to, centre, clockwise)
    segments: list[tuple]


@dataclass
class _Edge:
    id: int
    u: int
    v: int
    ref: Line | Arc


def _tangent(e: _Edge, forward: bool) -> tuple[float, float]:
    """(direction angle, signed curvature) of leaving the half-edge's start node."""
    if isinstance(e.ref, Line):
        a, b = (e.ref.a, e.ref.b) if forward else (e.ref.b, e.ref.a)
        ang = math.atan2(b[1] - a[1], b[0] - a[0])
        kappa = 0.0
    else:
        arc = e.ref
        if forward:
            ang, kappa = arc.a0 + math.pi / 2, 1 / arc.r
        else:
            ang, kappa = arc.a0 + arc.sweep - math.pi / 2, -1 / arc.r
    ang %= TAU
    if ang > TAU - 1e-9:
        ang -= TAU
    return ang, kappa


def _half_points(e: _Edge, forward: bool) -> list[Point]:
    if isinstance(e.ref, Line):
        return [e.ref.a, e.ref.b] if forward else [e.ref.b, e.ref.a]
    pts = arc_polyline(e.ref, 0.02)
    return pts if forward else pts[::-1]


def _signed_area(pts: list[Point]) -> float:
    return sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1])) / 2


def join_layer(lines: list[Line], arcs: list[Arc], join_tol: float, layer: str) -> list[PathOut]:
    paths: list[PathOut] = []
    full = [a for a in arcs if a.is_full]
    arcs = [a for a in arcs if not a.is_full]
    for a in full:  # a circle is a closed shape on its own
        s = a.start
        half = a.point_at(0.5)
        paths.append(PathOut(layer, True, s, [("arc", half, (a.cx, a.cy), False), ("arc", s, (a.cx, a.cy), False)]))

    refs: list[Line | Arc] = [*lines, *arcs]
    if not refs:
        return paths
    pts: list[Point] = []
    for r in refs:
        pts += [r.a, r.b] if isinstance(r, Line) else [r.start, r.end]
    root = cluster(pts, join_tol)
    ids: dict[int, int] = {}
    members: dict[int, list[Point]] = defaultdict(list)
    for i, p in enumerate(pts):
        n = ids.setdefault(root[i], len(ids))
        members[n].append(p)
    node_xy = {n: (sum(p[0] for p in m) / len(m), sum(p[1] for p in m) / len(m)) for n, m in members.items()}

    edges: list[_Edge] = []
    for i, r in enumerate(refs):
        u, v = ids[root[2 * i]], ids[root[2 * i + 1]]
        if u == v:  # starts and ends at the same place: a closed shape in one piece
            if isinstance(r, Line):
                continue
            paths.append(PathOut(layer, True, r.start, [("arc", r.end, (r.cx, r.cy), False)]))
            continue
        edges.append(_Edge(len(edges), u, v, r))

    def seg(e: _Edge, forward: bool) -> tuple:
        to = node_xy[e.v if forward else e.u]
        if isinstance(e.ref, Line):
            return ("line", to)
        return ("arc", to, (e.ref.cx, e.ref.cy), not forward)

    def build(oriented: list[tuple[_Edge, bool]], closed: bool) -> PathOut:
        e0, f0 = oriented[0]
        return PathOut(layer, closed, node_xy[e0.u if f0 else e0.v], [seg(e, f) for e, f in oriented])

    # ---- prune dangling edges (they become open paths) ----
    alive = {e.id for e in edges}
    deg: dict[int, int] = defaultdict(int)
    at: dict[int, list[_Edge]] = defaultdict(list)
    for e in edges:
        deg[e.u] += 1
        deg[e.v] += 1
        at[e.u].append(e)
        at[e.v].append(e)
    queue = deque(n for n, d in deg.items() if d == 1)
    pruned: set[int] = set()
    while queue:
        n = queue.popleft()
        if deg[n] != 1:
            continue
        for e in at[n]:
            if e.id in alive:
                alive.discard(e.id)
                pruned.add(e.id)
                other = e.v if e.u == n else e.u
                deg[n] -= 1
                deg[other] -= 1
                if deg[other] == 1:
                    queue.append(other)

    # ---- trace faces on what is left ----
    core = [e for e in edges if e.id in alive]
    out_of: dict[int, list[tuple[float, float, int]]] = defaultdict(list)  # node -> [(angle, kappa, half-edge id)]
    for e in core:
        for fwd, node in ((True, e.u), (False, e.v)):
            ang, kap = _tangent(e, fwd)
            out_of[node].append((ang, kap, e.id * 2 + (0 if fwd else 1)))
    for lst in out_of.values():
        lst.sort()
    pos = {h: (n, i) for n, lst in out_of.items() for i, (_a, _k, h) in enumerate(lst)}
    by_id = {e.id: e for e in edges}

    def head(h: int) -> int:
        e = by_id[h // 2]
        return e.v if h % 2 == 0 else e.u

    seen: set[int] = set()
    used: set[int] = set()
    for e in core:
        for start in (e.id * 2, e.id * 2 + 1):
            if start in seen:
                continue
            cycle: list[int] = []
            h = start
            while h not in seen:
                seen.add(h)
                cycle.append(h)
                node = head(h)
                lst = out_of[node]
                _, i = pos[h ^ 1]  # the twin leaves the node we arrive at
                h = lst[(i - 1) % len(lst)][2]
            if h != start:
                continue  # not a clean cycle (should not happen on a pruned graph)
            poly: list[Point] = []
            for hh in cycle:
                poly += _half_points(by_id[hh // 2], hh % 2 == 0)[:-1]
            if len(poly) >= 3 and _signed_area(poly) > 1e-6:
                paths.append(build([(by_id[hh // 2], hh % 2 == 0) for hh in cycle], True))
                used.update(hh // 2 for hh in cycle)

    # ---- everything not in a closed face is an open path ----
    rest = [e for e in edges if e.id not in used]
    if rest:
        adj: dict[int, list[_Edge]] = defaultdict(list)
        for e in rest:
            adj[e.u].append(e)
            adj[e.v].append(e)
        taken: set[int] = set()

        def walk(node: int, e: _Edge) -> list[tuple[_Edge, bool]]:
            chain: list[tuple[_Edge, bool]] = []
            cur_node, cur = node, e
            while True:
                fwd = cur.u == cur_node
                chain.append((cur, fwd))
                taken.add(cur.id)
                nxt_node = cur.v if fwd else cur.u
                options = [x for x in adj[nxt_node] if x.id not in taken]
                if len(adj[nxt_node]) != 2 or not options:
                    return chain
                cur_node, cur = nxt_node, options[0]

        for n in [n for n, es in adj.items() if len(es) != 2]:
            for e in adj[n]:
                if e.id not in taken:
                    paths.append(build(walk(n, e), False))
        for e in rest:  # anything left is a loop of degree-2 nodes
            if e.id not in taken:
                chain = walk(e.u, e)
                closed = chain and node_xy[chain[-1][0].v if chain[-1][1] else chain[-1][0].u] == node_xy[e.u]
                paths.append(build(chain, bool(closed)))
    return paths
