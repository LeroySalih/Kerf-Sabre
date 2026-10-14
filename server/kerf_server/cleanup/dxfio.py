"""Read a DXF file into lines, arcs and curves in millimetres.

Units: `$INSUNITS` from the header. When it is missing the file is assumed to be in centimetres (the Onshape default)
unless the caller overrides it.
"""
from __future__ import annotations

import io
import math
from dataclasses import dataclass, field

import ezdxf
from ezdxf import recover
from ezdxf.math import Vec3

from .geom import Arc, Curve, Line, Point, bulge_arc, make_arc

# $INSUNITS code -> millimetres per unit
UNIT_MM = {1: 25.4, 2: 304.8, 4: 1.0, 5: 10.0, 6: 1000.0, 8: 2.54e-5, 9: 0.0254, 10: 914.4, 13: 0.001, 14: 100.0}
OVERRIDE_MM = {"mm": 1.0, "cm": 10.0, "inch": 25.4}
MAX_INSERT_DEPTH = 6


class DxfError(Exception):
    """The file cannot be read as a DXF drawing."""


@dataclass
class Units:
    source: str  # header | override | assumed-cm
    mm_per_unit: float


@dataclass
class DxfData:
    lines: list[Line] = field(default_factory=list)
    arcs: list[Arc] = field(default_factory=list)
    curves: list[Curve] = field(default_factory=list)
    units: Units = field(default_factory=lambda: Units("assumed-cm", 10.0))
    skipped: dict[str, int] = field(default_factory=dict)


def layer_for(name: str, colour: int | None) -> str:
    """Score when the DXF layer name says so or the colour is blue/cyan (ACI 5/4); everything else is Cut."""
    if "score" in name.lower():
        return "score"
    return "score" if colour in (4, 5) else "cut"


def _units(doc, override: str | None) -> Units:
    code = int(doc.header.get("$INSUNITS", 0) or 0)
    if code in UNIT_MM:
        return Units("header", UNIT_MM[code])
    if override in OVERRIDE_MM:
        return Units("override", OVERRIDE_MM[override])
    return Units("assumed-cm", 10.0)


def read_dxf(data: bytes, tolerance_mm: float = 0.01, units_override: str | None = None) -> DxfData:
    try:
        doc, _auditor = recover.read(io.BytesIO(data))
    except Exception as exc:  # ezdxf raises several error types for unreadable files
        raise DxfError(f"This does not look like a DXF file ({type(exc).__name__}).") from exc
    out = DxfData(units=_units(doc, units_override))
    k = out.units.mm_per_unit

    def skip(kind: str) -> None:
        out.skipped[kind] = out.skipped.get(kind, 0) + 1

    def layer_of(e) -> str:
        name = e.dxf.layer
        colour = e.dxf.color if e.dxf.hasattr("color") else 256
        if colour == 256:  # by layer
            try:
                colour = abs(doc.layers.get(name).dxf.color)
            except Exception:  # noqa: BLE001
                colour = None
        return layer_for(name, colour)

    def pt(v: Vec3) -> Point:
        return (v.x * k, v.y * k)

    def add_poly(points: list[tuple[Point, float]], closed: bool, layer: str) -> None:
        n = len(points)
        for i in range(n - 1 + (1 if closed else 0)):
            p0, bulge = points[i]
            p1, _ = points[(i + 1) % n]
            seg = bulge_arc(p0, p1, bulge, layer)
            (out.arcs if isinstance(seg, Arc) else out.lines).append(seg)  # type: ignore[arg-type]

    def handle(e, depth: int) -> None:
        kind = e.dxftype()
        layer = layer_of(e)
        ext = e.dxf.extrusion if e.dxf.hasattr("extrusion") else Vec3(0, 0, 1)
        mirrored = ext.z < 0
        if abs(abs(ext.z) - 1) > 1e-6 and kind in ("ARC", "CIRCLE", "LWPOLYLINE", "POLYLINE"):
            skip(f"{kind} (tilted)")
            return
        if kind == "LINE":
            out.lines.append(Line(pt(e.dxf.start), pt(e.dxf.end), layer))
        elif kind == "ARC":
            c = e.dxf.center
            a0, a1 = math.radians(e.dxf.start_angle), math.radians(e.dxf.end_angle)
            cx = -c.x if mirrored else c.x
            if mirrored:
                a0, a1 = math.pi - a1, math.pi - a0
            arc = make_arc(cx * k, c.y * k, e.dxf.radius * k, a0, a1, layer)
            if arc:
                out.arcs.append(arc)
        elif kind == "CIRCLE":
            c = e.dxf.center
            arc = make_arc((-c.x if mirrored else c.x) * k, c.y * k, e.dxf.radius * k, 0.0, 0.0, layer)
            if arc:
                out.arcs.append(arc)
        elif kind == "LWPOLYLINE":
            pts = [((-x if mirrored else x) * k, y * k, -b if mirrored else b) for x, y, b in e.get_points("xyb")]
            add_poly([((x, y), b) for x, y, b in pts], bool(e.closed), layer)
        elif kind == "POLYLINE":
            if not e.is_2d_polyline:
                skip("POLYLINE (3D or mesh)")
                return
            verts = [(v.dxf.location, v.dxf.bulge if v.dxf.hasattr("bulge") else 0.0) for v in e.vertices]
            add_poly([(((-p.x if mirrored else p.x) * k, p.y * k), -b if mirrored else b) for p, b in verts], bool(e.is_closed), layer)
        elif kind in ("SPLINE", "ELLIPSE"):
            try:
                pts = [pt(v) for v in e.flattening(max(tolerance_mm / 2, 0.002) / k)]
            except Exception:  # noqa: BLE001  (a malformed spline should not sink the whole file)
                skip(f"{kind} (unreadable)")
                return
            if len(pts) >= 2:
                out.curves.append(Curve(pts, layer))
        elif kind == "INSERT":
            if depth >= MAX_INSERT_DEPTH:
                skip("INSERT (too deeply nested)")
                return
            try:
                for sub in e.virtual_entities():
                    handle(sub, depth + 1)
            except Exception:  # noqa: BLE001
                skip("INSERT (unreadable)")
        else:
            skip(kind)

    for e in doc.modelspace():
        try:
            handle(e, 0)
        except Exception:  # noqa: BLE001
            skip(f"{e.dxftype()} (unreadable)")
    return out
