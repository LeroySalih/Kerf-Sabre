"""Bed-space paths -> GRBL G-code. Absolute (G21 G90), never G92; arcs as G2/G3; S0 across tabs and travel."""
from __future__ import annotations

import math

from ..presetlogic import Operation, ResolvedPreset
from .kerf import path_points
from .model import BedPath, Point, Seg, arc_point, arc_sweep, dist, seg_length

_EPS = 1e-6


def _n(v: float) -> str:
    s = f"{v:.3f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def _split_seg(start: Point, s: Seg, t: float) -> tuple[Seg, Seg]:
    """Cut a segment at distance t from its start."""
    total = seg_length(start, s)
    f = t / total
    if s.kind == "l":
        mid = (start[0] + (s.to[0] - start[0]) * f, start[1] + (s.to[1] - start[1]) * f)
        return Seg("l", mid), Seg("l", s.to)
    sweep = arc_sweep(start, s.to, s.c, s.ccw)  # type: ignore[arg-type]
    mid = arc_point(start, s.c, s.ccw, sweep, f)  # type: ignore[arg-type]
    return Seg("a", mid, c=s.c, ccw=s.ccw), Seg("a", s.to, c=s.c, ccw=s.ccw)


def tab_intervals(total: float, tabs: list[tuple[float, float]]) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for at, w in tabs:
        a, b = at - w / 2, at + w / 2
        if a < 0:
            out += [(0.0, b), (a + total, total)]
        elif b > total:
            out += [(a, total), (0.0, b - total)]
        else:
            out.append((a, b))
    return out


def with_tabs(p: BedPath) -> list[tuple[Seg, bool]]:
    """The path's segments tagged laser-on (True) or tab (False). Segments are split where a tab starts or ends."""
    if not (p.closed and p.layer == "cut" and p.tabs):
        return [(s, True) for s in p.segs]
    lens: list[float] = []
    cur = p.start
    for s in p.segs:
        lens.append(seg_length(cur, s))
        cur = s.to
    total = sum(lens)
    ivs = tab_intervals(total, p.tabs)
    marks = sorted({round(v, 9) for iv in ivs for v in iv})
    out: list[tuple[Seg, bool]] = []
    cur, pos = p.start, 0.0
    for s, ln in zip(p.segs, lens):
        end = pos + ln
        rest, rest_start, at = s, cur, pos
        for m in marks:
            if at + _EPS < m < end - _EPS:
                a, b = _split_seg(rest_start, rest, m - at)
                out.append((a, not any(lo <= (at + m) / 2 <= hi for lo, hi in ivs)))
                rest_start, rest, at = a.to, b, m
        out.append((rest, not any(lo <= (at + end) / 2 <= hi for lo, hi in ivs)))
        cur, pos = s.to, end
    return out


class Emitter:
    def __init__(self, s30: float, air_command: str | None, preset: ResolvedPreset):
        self.s30 = s30
        self.air = air_command
        self.preset = preset
        self.lines: list[str] = []
        self.pos: Point | None = None
        self._f: float | None = None
        self._s: int | None = None
        self.air_on = False

    # -- modal words
    def _s_word(self, power_pct: float) -> str:
        s = round(max(0.0, min(100.0, power_pct)) / 100 * self.s30)
        return "" if s == self._s else f" S{s}"

    def _f_word(self, mm_s: float) -> str:
        f = round(mm_s * 60, 1)
        return "" if f == self._f else f" F{_n(f)}"

    def _set(self, power_pct: float, speed: float | None = None) -> tuple[str, str]:
        f = self._f_word(speed) if speed is not None else ""
        s = self._s_word(power_pct)
        if f:
            self._f = round(speed * 60, 1)  # type: ignore[operator]
        if s:
            self._s = round(max(0.0, min(100.0, power_pct)) / 100 * self.s30)
        return f, s

    # -- commands
    def header(self, title: list[str]) -> None:
        self.lines += [f"; {t}" for t in title]
        self.lines += ["G21", "G90", "M4 S0"]
        self._s = 0

    def footer(self) -> None:
        if self.air_on and self.air:
            self.lines.append("M9")
        self.lines += ["M5", "G0 X0 Y0 S0"]

    def air_assist(self, on: bool) -> None:
        if self.air and on != self.air_on:
            self.lines.append(self.air if on else "M9")
            self.air_on = on

    def travel(self, to: Point) -> None:
        if self.pos is not None and dist(self.pos, to) < _EPS:
            return
        f, s = self._set(0)
        self.lines.append(f"G0 X{_n(to[0])} Y{_n(to[1])}{s}")
        self.pos = to

    def _line(self, to: Point, op: Operation, on: bool, speed: float) -> None:
        f, s = self._set(op.power_pct if on else 0, speed)
        self.lines.append(f"G1 X{_n(to[0])} Y{_n(to[1])}{f}{s}")
        self.pos = to

    def _arc(self, seg: Seg, op: Operation, on: bool, speed: float) -> None:
        a, c = self.pos, seg.c  # type: ignore[assignment]
        to = (round(seg.to[0], 3), round(seg.to[1], 3))
        i, j = round(c[0] - a[0], 3), round(c[1] - a[1], 3)  # type: ignore[index]
        r0 = math.hypot(i, j)
        r1 = math.hypot(c[0] - to[0], c[1] - to[1])  # type: ignore[index]
        if abs(r0 - r1) > 0.004:  # GRBL would refuse it: use short chords instead
            tmp = BedPath("", "cut", False, a, [seg])  # type: ignore[arg-type]
            for q in path_points(tmp, 0.001)[1:]:
                self._line(q, op, on, speed)
            return
        f, s = self._set(op.power_pct if on else 0, speed)
        self.lines.append(f"G{3 if seg.ccw else 2} X{_n(to[0])} Y{_n(to[1])} I{_n(i)} J{_n(j)}{f}{s}")
        self.pos = to

    def path(self, p: BedPath, op: Operation) -> None:
        speed = p.speed_mm_s if p.speed_mm_s is not None else op.speed_mm_s
        power = p.power_pct if p.power_pct is not None else op.power_pct
        eff = Operation(power, speed, p.passes or op.passes, op.air)
        self.air_assist(eff.air)
        for _ in range(eff.passes):
            self.travel(p.start)
            for seg, on in with_tabs(p):
                if seg.kind == "l":
                    self._line(seg.to, eff, on, speed)
                else:
                    self._arc(seg, eff, on, speed)

    def text(self) -> str:
        return "\n".join(self.lines) + "\n"
