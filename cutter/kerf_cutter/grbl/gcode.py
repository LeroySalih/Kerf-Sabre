"""The Cutter's own check of G-code before any of it reaches the laser. The Server already checked it; this is the second pair of eyes,
and it does not trust the file: wrong units, relative moves, G92, settings commands, spindle power over $30, or any move off the bed is refused."""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field

WORD = re.compile(r"([A-Za-z])\s*([-+]?\d*\.?\d+)")
ALLOWED_G = {0, 1, 2, 3, 4, 17, 21, 90, 94, 54}
ALLOWED_M = {3, 4, 5, 8, 9, 2, 30}


@dataclass
class Scan:
    lines: list[str] = field(default_factory=list)     # the executable lines, comments removed
    bounds: tuple[float, float, float, float] | None = None       # every move, rapids included (this is what must fit on the bed)
    cut_bounds: tuple[float, float, float, float] | None = None   # only the feed moves G1/G2/G3 (this is what the server reports as the job's size)
    errors: list[str] = field(default_factory=list)
    max_s: float = 0.0

    @property
    def ok(self) -> bool:
        return not self.errors


def strip(line: str) -> str:
    line = re.sub(r"\([^)]*\)", "", line)
    return line.split(";", 1)[0].strip()


def _arc_extents(x0: float, y0: float, x1: float, y1: float, cx: float, cy: float, cw: bool) -> tuple[float, float, float, float]:
    r = math.hypot(x0 - cx, y0 - cy)
    a0, a1 = math.atan2(y0 - cy, x0 - cx), math.atan2(y1 - cy, x1 - cx)
    sweep = (a0 - a1) % (2 * math.pi) if cw else (a1 - a0) % (2 * math.pi)
    if sweep == 0:
        sweep = 2 * math.pi  # a full circle
    xs, ys = [x0, x1], [y0, y1]
    for k in range(4):  # the compass points the arc passes through
        ang = k * math.pi / 2
        d = (a0 - ang) % (2 * math.pi) if cw else (ang - a0) % (2 * math.pi)
        if d <= sweep:
            xs.append(cx + r * math.cos(ang))
            ys.append(cy + r * math.sin(ang))
    return min(xs), min(ys), max(xs), max(ys)


def scan(text: str, *, bed_w: float, bed_h: float, s30_max: float, laser_mode: bool = True, tol: float = 0.5, max_errors: int = 8) -> Scan:
    out = Scan()
    x = y = 0.0
    mode: int | None = None
    have_pos = False  # the head's start position is not known here, so the first move only marks where the job begins
    units_set = absolute_set = moved = False
    lo = [math.inf, math.inf]
    hi = [-math.inf, -math.inf]
    clo = [math.inf, math.inf]
    chi = [-math.inf, -math.inf]

    def err(n: int, msg: str) -> None:
        if len(out.errors) < max_errors:
            out.errors.append(f"line {n}: {msg}")

    def grow(x0: float, y0: float, x1: float, y1: float) -> None:
        lo[0], lo[1], hi[0], hi[1] = min(lo[0], x0), min(lo[1], y0), max(hi[0], x1), max(hi[1], y1)

    for n, raw in enumerate(text.splitlines(), 1):
        line = strip(raw)
        if not line:
            continue
        out.lines.append(line)
        if line.startswith("$"):
            err(n, "settings commands ($...) are not allowed in a job")
            continue
        words = [(w.upper(), float(v)) for w, v in WORD.findall(line)]
        g_codes = [int(v) for w, v in words if w == "G"]
        m_codes = [int(v) for w, v in words if w == "M"]
        for g in g_codes:
            if g == 92:
                err(n, "G92 is never allowed (positions come from the bed, not from offsets)")
            elif g == 91:
                err(n, "relative moves (G91) are not allowed: every job is absolute")
            elif g == 20:
                err(n, "inches (G20) are not allowed: every job is in millimetres")
            elif g not in ALLOWED_G:
                err(n, f"G{g} is not allowed in a job")
            elif g == 21:
                units_set = True
            elif g == 90:
                absolute_set = True
            elif g in (0, 1, 2, 3):
                mode = g
        for m in m_codes:
            if m not in ALLOWED_M:
                err(n, f"M{m} is not allowed in a job")
            elif m in (3, 4) and not laser_mode:
                err(n, f"M{m} (laser on) needs GRBL laser mode ($32=1), which is off")
        for w, v in words:
            if w == "S":
                out.max_s = max(out.max_s, v)
                if v > s30_max + 1e-6:
                    err(n, f"S{v:g} is above the laser's maximum ($30 = {s30_max:g})")
        d = {w: v for w, v in words if w in "XYIJ"}
        if mode is None or ("X" not in d and "Y" not in d and not any(g in (0, 1, 2, 3) for g in g_codes)):
            continue
        if ("X" in d or "Y" in d) and not (units_set and absolute_set) and not moved:
            err(n, "the job moves before it has set millimetres (G21) and absolute (G90)")
        moved = True
        nx, ny = d.get("X", x), d.get("Y", y)
        if not have_pos:
            have_pos = True
            x, y = nx, ny
            grow(x, y, x, y)
            continue
        if mode in (2, 3):
            cx, cy = x + d.get("I", 0.0), y + d.get("J", 0.0)
            b = _arc_extents(x, y, nx, ny, cx, cy, cw=(mode == 2))
        else:
            b = (min(x, nx), min(y, ny), max(x, nx), max(y, ny))
        grow(*b)
        if mode != 0:
            clo[0], clo[1], chi[0], chi[1] = min(clo[0], b[0]), min(clo[1], b[1]), max(chi[0], b[2]), max(chi[1], b[3])
        x, y = nx, ny
    if chi[0] >= clo[0]:
        out.cut_bounds = (clo[0], clo[1], chi[0], chi[1])
    if hi[0] >= lo[0]:
        out.bounds = (lo[0], lo[1], hi[0], hi[1])
        if lo[0] < -tol or lo[1] < -tol or hi[0] > bed_w + tol or hi[1] > bed_h + tol:
            out.errors.append(f"the job goes outside the bed: X {lo[0]:.1f} to {hi[0]:.1f}, Y {lo[1]:.1f} to {hi[1]:.1f} mm, but the bed is {bed_w:g} x {bed_h:g} mm")
    if not out.lines:
        out.errors.append("the job is empty")
    return out
