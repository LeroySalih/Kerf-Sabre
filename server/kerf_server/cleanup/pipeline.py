"""The clean-up pipeline of brief section 7, from parsed DXF geometry to job objects and a report."""
from __future__ import annotations

from dataclasses import dataclass, field

from .dxfio import DxfData, DxfError, read_dxf
from .geom import Arc, Line, bbox
from .join import PathOut, join_layer
from .steps import (
    Counts,
    collapse_micro,
    curves_to_lines,
    dedupe_arcs,
    dedupe_curves,
    dedupe_lines,
    merge_arcs,
    merge_collinear,
    node_segments,
    normalise_arcs,
    resolve_conflicts,
    snap_lines,
)

MICRO_MM = 0.05  # segments shorter than this are removed (brief section 7, step 6)


class EmptyDrawing(DxfError):
    """The file was read but holds nothing that can be cut."""


@dataclass
class CleanupOutput:
    objects: list[dict]
    report: dict
    units: dict
    paths: list[PathOut] = field(default_factory=list)


def _plural(n: int, one: str, many: str | None = None) -> str:
    return f"{n} {one if n == 1 else (many or one + 's')}"


def _summary(c: Counts, closed: int, open_: int) -> str:
    parts: list[str] = []
    if c.duplicates:
        parts.append(f"removed {_plural(c.duplicates, 'duplicate')}")
    if c.overlaps:
        parts.append(f"merged {_plural(c.overlaps, 'overlap')}")
    if c.micro:
        parts.append(f"dropped {_plural(c.micro, 'tiny segment')}")
    if c.conflicts:
        parts.append(f"kept Cut over {_plural(c.conflicts, 'Score line')}")
    parts.append(f"joined into {_plural(closed, 'closed shape')}")
    if open_:
        parts.append(_plural(open_, "open path"))
    text = ", ".join(parts)
    return text[0].upper() + text[1:]


def clean(data: DxfData, tolerance_mm: float = 0.01) -> CleanupOutput:
    tol = tolerance_mm
    join_tol = max(tol * 5, MICRO_MM)  # also bridges the gap left by a collapsed tiny segment
    counts = Counts()

    # 1. normalise, 2. exact dedupe
    lines = dedupe_lines(snap_lines(data.lines, tol, counts), counts)
    arcs = dedupe_arcs(normalise_arcs(data.arcs, tol), tol, counts)
    # 3. collinear merge, 4. arc merge
    lines = merge_collinear(lines, tol, counts)
    arcs = merge_arcs(arcs, tol, counts)
    # 5. curves
    lines += curves_to_lines(dedupe_curves(data.curves, tol, counts))
    lines = dedupe_lines(lines, counts)
    # 6. micro-segments
    lines, arcs = collapse_micro(lines, arcs, MICRO_MM, counts)
    # 7. Score/Cut conflict
    lines, arcs = resolve_conflicts(lines, arcs, tol, MICRO_MM, counts)
    # (split segments at T-junctions so touching shapes can close)
    lines, arcs = node_segments(lines, arcs, join_tol, counts)

    box = bbox(lines, arcs)
    if box is None:
        raise EmptyDrawing("The file has no lines, arcs or curves that can be cut.")
    dx, dy = -box[0], -box[1]  # bounding box bottom-left to (0,0)
    lines = [Line((l.a[0] + dx, l.a[1] + dy), (l.b[0] + dx, l.b[1] + dy), l.layer) for l in lines]
    arcs = [Arc(a.cx + dx, a.cy + dy, a.r, a.a0, a.sweep, a.layer) for a in arcs]

    # 8. auto-join, one layer at a time
    paths: list[PathOut] = []
    for layer in ("cut", "score"):
        paths += join_layer([l for l in lines if l.layer == layer], [a for a in arcs if a.layer == layer], join_tol, layer)

    objects: list[dict] = []
    for i, p in enumerate(paths, 1):
        segs = []
        for s in p.segments:
            if s[0] == "line":
                segs.append({"type": "line", "to": [round(s[1][0], 6), round(s[1][1], 6)]})
            else:
                segs.append({"type": "arc", "to": [round(s[1][0], 6), round(s[1][1], 6)], "center": [round(s[2][0], 6), round(s[2][1], 6)], "clockwise": bool(s[3])})
        objects.append({"id": f"o{i}", "layer": p.layer, "closed": p.closed, "start": [round(p.start[0], 6), round(p.start[1], 6)], "segments": segs, "matrix": [1, 0, 0, 1, 0, 0]})

    closed = sum(1 for p in paths if p.closed)
    open_ = len(paths) - closed
    report = {
        "duplicatesRemoved": counts.duplicates,
        "overlapsMerged": counts.overlaps,
        "microSegmentsRemoved": counts.micro,
        "scoreCutConflicts": counts.conflicts,
        "closedShapes": closed,
        "openPaths": open_,
        "skippedEntities": dict(data.skipped),
        "summary": _summary(counts, closed, open_),
        "changes": counts.changes,
    }
    units = {"source": data.units.source, "mmPerUnit": data.units.mm_per_unit}
    return CleanupOutput(objects=objects, report=report, units=units, paths=paths)


def cleanup_dxf(data: bytes, tolerance_mm: float = 0.01, units_override: str | None = None) -> CleanupOutput:
    return clean(read_dxf(data, tolerance_mm, units_override), tolerance_mm)
