"""Helpers that build small DXF files for the clean-up tests."""
from __future__ import annotations

import io
from collections.abc import Callable

import ezdxf


def make_dxf(build: Callable, insunits: int | None = None, version: str = "R2010") -> bytes:
    doc = ezdxf.new(version)
    doc.header["$INSUNITS"] = 0 if insunits is None else insunits
    build(doc, doc.modelspace())
    buf = io.StringIO()
    doc.write(buf)
    return buf.getvalue().encode()


def rect(msp, x0, y0, x1, y1, layer="0"):
    pts = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    for a, b in zip(pts, pts[1:] + pts[:1]):
        msp.add_line(a, b, dxfattribs={"layer": layer})
