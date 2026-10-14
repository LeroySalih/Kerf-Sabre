"""Read G-code back into motions. Used to estimate time, to check bounds, and by the tests as a tiny GRBL simulator."""
from __future__ import annotations

import math
import re
from dataclasses import dataclass

from .model import Point, arc_sweep

_WORD = re.compile(r"([A-Za-z])\s*(-?\d*\.?\d+)")


class GcodeSyntax(ValueError):
    pass


@dataclass
class Motion:
    kind: str  # rapid | line | arc
    start: Point
    end: Point
    feed_mm_s: float  # 0 for rapids
    power: float  # S at the time of the move
    centre: Point | None = None
    ccw: bool = True
    line_no: int = 0

    @property
    def length(self) -> float:
        if self.kind == "arc":
            r = math.dist(self.start, self.centre)  # type: ignore[arg-type]
            return r * abs(arc_sweep(self.start, self.end, self.centre, self.ccw))  # type: ignore[arg-type]
        return math.dist(self.start, self.end)

    def bounds(self) -> tuple[float, float, float, float]:
        xs, ys = [self.start[0], self.end[0]], [self.start[1], self.end[1]]
        if self.kind == "arc":
            c = self.centre  # type: ignore[assignment]
            r = math.dist(self.start, c)
            sweep = arc_sweep(self.start, self.end, c, self.ccw)  # type: ignore[arg-type]
            a0 = math.atan2(self.start[1] - c[1], self.start[0] - c[0])
            for k in range(4):
                target = k * math.pi / 2
                d = (target - a0) % math.tau if sweep > 0 else -((a0 - target) % math.tau)
                if abs(d) <= abs(sweep):
                    xs.append(c[0] + r * math.cos(target))
                    ys.append(c[1] + r * math.sin(target))
        return (min(xs), min(ys), max(xs), max(ys))


@dataclass
class Program:
    motions: list[Motion]
    errors: list[str]
    commands: list[str]  # every G/M word seen, e.g. "G21", "M4"


def parse(text: str, start: Point = (0.0, 0.0)) -> Program:
    """Interpret absolute G-code (G0/G1/G2/G3 with I/J, M-codes). Reports anything GRBL would reject or the brief forbids."""
    pos = start
    feed = 0.0
    power = 0.0
    g_mode = "G0"
    absolute = True
    motions: list[Motion] = []
    errors: list[str] = []
    commands: list[str] = []
    for no, raw in enumerate(text.splitlines(), 1):
        line = re.sub(r"\(.*?\)|;.*$", "", raw).strip()
        if not line:
            continue
        words = [(m.group(1).upper(), float(m.group(2))) for m in _WORD.finditer(line)]
        vals: dict[str, float] = {}
        for letter, v in words:
            if letter in "GM":
                code = f"{letter}{int(v)}"
                commands.append(code)
                if code in ("G0", "G1", "G2", "G3"):
                    g_mode = code
                elif code == "G90":
                    absolute = True
                elif code == "G91":
                    absolute = False
                    errors.append(f"line {no}: G91 relative moves are not allowed")
                elif code == "G92":
                    errors.append(f"line {no}: G92 is forbidden")
            else:
                vals[letter] = v
        if "F" in vals:
            feed = vals["F"] / 60.0
        if "S" in vals:
            power = vals["S"]
        if not ({"X", "Y"} & set(vals)):
            continue
        end = (vals.get("X", pos[0]), vals.get("Y", pos[1]))
        if g_mode == "G0":
            motions.append(Motion("rapid", pos, end, 0.0, 0.0, line_no=no))
        elif g_mode == "G1":
            motions.append(Motion("line", pos, end, feed, power, line_no=no))
        else:
            if "I" not in vals and "J" not in vals:
                errors.append(f"line {no}: arc without I/J")
                pos = end
                continue
            c = (pos[0] + vals.get("I", 0.0), pos[1] + vals.get("J", 0.0))
            r0, r1 = math.dist(pos, c), math.dist(end, c)
            if abs(r0 - r1) > 0.005:  # GRBL: error 33
                errors.append(f"line {no}: arc radii differ by {abs(r0 - r1):.4f} mm")
            motions.append(Motion("arc", pos, end, feed, power, centre=c, ccw=(g_mode == "G3"), line_no=no))
        pos = end
    if not absolute:
        errors.append("program switched to relative mode")
    return Program(motions, errors, commands)
