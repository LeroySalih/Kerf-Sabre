"""G-code post-processor: a job + preset + machine profile -> G-code text, estimate and warnings."""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from ..presetlogic import resolve
from .emit import Emitter
from .estimate import duration
from .kerf import assign_depths, compensate, path_points
from .model import BedPath, Point, Seg
from .motion import parse
from .order import order
from .prepare import to_bed

ANCHORS = {
    "top-left": (0, 1), "top-center": (0.5, 1), "top-right": (1, 1),
    "middle-left": (0, 0.5), "center": (0.5, 0.5), "middle-right": (1, 0.5),
    "bottom-left": (0, 0), "bottom-center": (0.5, 0), "bottom-right": (1, 0),
}  # fractions of the job's width/height


class GcodeError(ValueError):
    """The job cannot be turned into safe G-code. The message is fit to show a pupil."""


@dataclass
class Result:
    text: str
    estimate: dict[str, Any]
    warnings: list[str] = field(default_factory=list)
    bounds: tuple[float, float, float, float] = (0, 0, 0, 0)
    untested: bool = False


def _translate(p: BedPath, dx: float, dy: float) -> BedPath:
    def mv(q: Point) -> Point:
        return (q[0] + dx, q[1] + dy)

    segs = [Seg(s.kind, mv(s.to), c=mv(s.c) if s.c else None, ccw=s.ccw) for s in p.segs]
    return BedPath(p.object_id, p.layer, p.closed, mv(p.start), segs, tabs=list(p.tabs), power_pct=p.power_pct,
                   speed_mm_s=p.speed_mm_s, passes=p.passes, dash_mm=p.dash_mm, depth=p.depth)


def _bbox(paths: list[BedPath]) -> tuple[float, float, float, float]:
    pts = [q for p in paths for q in path_points(p)]
    xs, ys = [q[0] for q in pts], [q[1] for q in pts]
    return (min(xs), min(ys), max(xs), max(ys))


# The check puts the design a little in from the bed corner: exactly on it, kerf compensation at sharp corners (a star's
# tips) pokes a fraction of a millimetre past the edge and a design that really fits would be refused.
PROBE_MARGIN_MM = 2.0


def cuttable(job: dict[str, Any]) -> list[dict[str, Any]]:
    """The shapes the laser will actually do: the Ignore layer is the pupil's own (guides, notes) and is skipped everywhere."""
    objects = [o for o in job["objects"] if o["layer"] != "ignore"]
    if not objects:
        raise GcodeError("There is nothing to cut: every shape is on the Ignore layer.")
    return objects


def probe_head(job: dict[str, Any]) -> Point:
    """A head position that puts a current-position job's bounding box just inside the bed origin. For checking fit before a station is chosen."""
    origin = job["origin"]
    if origin["mode"] != "current-position":
        return (0.0, 0.0)
    x0, y0, x1, y1 = _bbox([to_bed(o) for o in cuttable(job)])
    fx, fy = ANCHORS[origin["anchor"]]
    return (PROBE_MARGIN_MM + (x1 - x0) * fx, PROBE_MARGIN_MM + (y1 - y0) * fy)


def _fit_message(at_head: bool, head: Point | None, box: tuple[float, float, float, float], bed: tuple[float, float], eps: float) -> str:
    """Why a design does not fit. For a job placed at the laser head, say where the head is: a head that is off the bed (not homed, or a
    position the laser reports outside its bed) looks like 'the design is too big' to a pupil who can see it is small."""
    bw, bh = bed
    base = f"The design does not fit on this laser's bed ({bw:g} x {bh:g} mm)."
    if not at_head or head is None:
        return base
    hx, hy = head
    if hx < -eps or hy < -eps or hx > bw + eps or hy > bh + eps:
        return (f"The laser head reports its position as X {hx:.1f}, Y {hy:.1f} mm, which is outside the bed ({bw:g} x {bh:g} mm). "
                "Home the laser, or move the head onto your material, then try again.")
    x0, y0, x1, y1 = box
    over = [name for name, bad in (("right", x1 > bw + eps), ("top", y1 > bh + eps)) if bad]
    if over:
        return (f"The design is {x1 - x0:.0f} x {y1 - y0:.0f} mm and the laser head is at X {hx:.0f}, Y {hy:.0f} mm, so it would run past the {' and '.join(over)} edge "
                f"of the bed ({bw:g} x {bh:g} mm). Move the head further {'left' if 'right' in over else ''}{' and ' if len(over) == 2 else ''}{'down' if 'top' in over else ''}.")
    return base


HEAD_SLACK_MM = 1.0


def _snap(v: float, size: float) -> float:
    """Pull a head position that is just outside [0, size] back onto the edge."""
    if -HEAD_SLACK_MM <= v < 0:
        return 0.0
    if size < v <= size + HEAD_SLACK_MM:
        return float(size)
    return v


def generate(job: dict[str, Any], preset: dict[str, Any], machine: dict[str, Any], *, head: Point | None = None) -> Result:
    """`head` is the laser's current position (bed mm); needed when the job's origin mode is current-position."""
    rp = resolve(preset, machine["id"])
    warnings: list[str] = []
    paths = [to_bed(o) for o in cuttable(job)]
    polys = assign_depths(paths)
    part_area = sum(poly.area * (1 if p.depth % 2 == 0 else -1) for p in paths if (poly := polys.get(p.object_id)) is not None)

    origin = job["origin"]
    if origin["mode"] == "current-position":
        if head is None:
            raise GcodeError("The laser's position is not known yet. Move the laser head to the corner of your material first.")
        # GRBL reports a head parked on the origin as a hair below zero (X -0.04); a design lined up on that corner would then hang a
        # fraction of a millimetre off the bed. A head within HEAD_SLACK_MM of an edge is treated as being on it.
        bw_, bh_ = machine["bed"]["widthMm"], machine["bed"]["heightMm"]
        head = (_snap(head[0], bw_), _snap(head[1], bh_))
        x0, y0, x1, y1 = _bbox(paths)
        fx, fy = ANCHORS[origin["anchor"]]
        dx, dy = head[0] - (x0 + (x1 - x0) * fx), head[1] - (y0 + (y1 - y0) * fy)
        paths = [_translate(p, dx, dy) for p in paths]
        polys = assign_depths(paths)

    ex0, ey0, ex1, ey1 = _bbox(paths)  # the design itself, before kerf compensation
    paths, w = compensate(paths, polys, rp.kerf_mm)
    warnings += w
    if not paths:
        raise GcodeError("There is nothing left to cut.")
    bx0, by0, bx1, by1 = _bbox(paths)
    bw, bh = machine["bed"]["widthMm"], machine["bed"]["heightMm"]
    eps = 0.01 + rp.kerf_mm / 2  # the kerf offset may nudge an edge-aligned part just past the bed edge
    if bx0 < -eps or by0 < -eps or bx1 > bw + eps or by1 > bh + eps:
        raise GcodeError(_fit_message(origin["mode"] == "current-position", head, (bx0, by0, bx1, by1), (bw, bh), eps))
    if rp.untested:
        warnings.append("This material has not been test-gridded on this laser yet. Run a material test first.")

    air = machine.get("airAssist") or {}
    air_cmd = air.get("command") if air.get("supported") is not False else None
    if any(rp.op(p.layer).air for p in paths) and air.get("supported") is False:
        warnings.append("This laser has no air assist, so the cut may scorch.")
    s30 = float(machine["grbl"]["s30Max"])

    em = Emitter(s30, air_cmd, rp)
    em.header([f"Kerf Sabre job {job['id']} pupil {job['pupilId']}", f"preset {rp.preset_id} v{rp.version}", f"machine {machine['id']}"])
    for p in order(paths):
        em.path(p, rp.op(p.layer))
    em.footer()
    text = em.text()

    prog = parse(text)
    if prog.errors:  # a bug in us, never in the pupil's file: refuse rather than send it to a laser
        raise GcodeError("Internal error building G-code: " + "; ".join(prog.errors[:3]))
    sheet = preset["sheet"]
    used = (bx1 - min(bx0, 0)) * (by1 - min(by0, 0))
    sheet_area = float(sheet["widthMm"]) * float(sheet["heightMm"])
    est = {
        "durationS": round(duration(prog.motions), 1),
        "partAreaMm2": round(max(part_area, 0.0), 1),
        "extentMm": {"widthMm": round(ex1 - ex0, 1), "heightMm": round(ey1 - ey0, 1)},
        "sheetAreaUsedMm2": round(used, 1),
        "percentUsed": round(min(100.0, 100 * used / sheet_area), 1) if sheet_area else 0.0,
        "costSar": round(float(sheet["costSar"]) * used / sheet_area, 2) if sheet.get("costSar") is not None and sheet_area else None,
    }
    return Result(text, est, warnings, (bx0, by0, bx1, by1), rp.untested)
