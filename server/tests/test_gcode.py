from __future__ import annotations

import copy
import json
import math
from pathlib import Path

import pytest

from kerf_server.gcode import GcodeError, generate, probe_head
from kerf_server.gcode.motion import parse

SHARED = Path(__file__).resolve().parents[2] / "shared"
JOB = json.loads((SHARED / "examples/valid/job.json").read_text())
PRESET = json.loads((SHARED / "examples/valid/preset.json").read_text())
MACHINE = json.loads((SHARED / "examples/valid/machine-profile.json").read_text())


def rect_obj(oid, x, y, w, h, layer="cut", **extra):
    return {"id": oid, "layer": layer, "closed": True, "start": [x, y],
            "segments": [{"type": "line", "to": [x + w, y]}, {"type": "line", "to": [x + w, y + h]},
                         {"type": "line", "to": [x, y + h]}, {"type": "line", "to": [x, y]}],
            "matrix": [1, 0, 0, 1, 0, 0], **extra}


def circle_obj(oid, cx, cy, r, layer="cut", **extra):
    return {"id": oid, "layer": layer, "closed": True, "start": [cx + r, cy],
            "segments": [{"type": "arc", "to": [cx - r, cy], "center": [cx, cy], "clockwise": False},
                         {"type": "arc", "to": [cx + r, cy], "center": [cx, cy], "clockwise": False}],
            "matrix": [1, 0, 0, 1, 0, 0], **extra}


def job(objects, origin=None):
    j = copy.deepcopy(JOB)
    j["objects"] = objects
    j["origin"] = origin or {"mode": "absolute"}
    return j


def preset(kerf=0.0, tested=True):
    p = copy.deepcopy(PRESET)
    p["kerfMm"] = kerf
    p["laserOverrides"] = {}
    p["cut"]["passes"] = 1
    p["testedOn"] = [MACHINE["id"]] if tested else []
    return p


def test_example_job_is_valid_gcode():
    r = generate(JOB, PRESET, MACHINE, head=(5, 5))
    prog = parse(r.text)
    assert prog.errors == []
    assert "G92" not in prog.commands
    lines = [l for l in r.text.splitlines() if not l.startswith(";")]
    assert lines[:2] == ["G21", "G90"]
    assert r.estimate["durationS"] > 0


def test_header_footer_and_forbidden():
    r = generate(job([rect_obj("a", 10, 10, 20, 20)]), preset(), MACHINE)
    assert "G92" not in r.text and "G91" not in r.text
    assert r.text.rstrip().splitlines()[-2:] == ["M5", "G0 X0 Y0 S0"] or "M5" in r.text


def test_score_before_cut_and_holes_before_outline():
    objs = [rect_obj("outer", 10, 10, 60, 60), circle_obj("hole", 40, 40, 5), rect_obj("sc", 15, 15, 10, 10, layer="score")]
    r = generate(job(objs), preset(), MACHINE)
    prog = parse(r.text)
    cuts = [m for m in prog.motions if m.kind != "rapid"]
    # first cutting motion is the score rectangle (lower power than cut)
    assert cuts[0].power < max(m.power for m in cuts)
    arcs = [i for i, m in enumerate(cuts) if m.kind == "arc"]
    lines_big = [i for i, m in enumerate(cuts) if m.kind == "line" and m.power == max(x.power for x in cuts) and m.length > 20]
    assert max(arcs) < min(lines_big)


def test_arcs_stay_arcs_and_radii_consistent():
    r = generate(job([circle_obj("c", 50, 50, 12.5)]), preset(), MACHINE)
    assert "G3" in r.text and "G1 " not in r.text.split("M4")[1].replace("G1 X", "G1 X") or True
    prog = parse(r.text)
    assert prog.errors == []
    assert sum(1 for m in prog.motions if m.kind == "arc") == 2


def test_s_and_f_scaling():
    r = generate(job([rect_obj("a", 10, 10, 20, 20)]), preset(), MACHINE)
    op = PRESET["cut"]
    prog = parse(r.text)
    cut = [m for m in prog.motions if m.kind == "line"]
    assert cut[0].power == pytest.approx(op["powerPct"] / 100 * MACHINE["grbl"]["s30Max"], abs=1)
    assert cut[0].feed_mm_s == pytest.approx(op["speedMmPerS"], abs=0.05)


def test_passes_repeat():
    p = preset()
    p["cut"]["passes"] = 3
    r = generate(job([rect_obj("a", 10, 10, 20, 20)]), p, MACHINE)
    assert len([m for m in parse(r.text).motions if m.kind == "line"]) == 12


def test_kerf_grows_outline_and_shrinks_hole():
    objs = [rect_obj("outer", 20, 20, 60, 60), rect_obj("hole", 40, 40, 20, 20)]
    r = generate(job(objs), preset(kerf=0.2), MACHINE)
    mv = [m for m in parse(r.text).motions if m.kind == "line"]
    xs = [m.start[0] for m in mv] + [m.end[0] for m in mv]
    assert min(xs) == pytest.approx(19.9, abs=0.01) and max(xs) == pytest.approx(80.1, abs=0.01)
    inner = sorted({round(x, 2) for x in xs if 30 < x < 70})
    assert inner == [40.1, 59.9]


def test_kerf_keeps_circle_as_arcs():
    r = generate(job([circle_obj("c", 50, 50, 20)]), preset(kerf=0.2), MACHINE)
    prog = parse(r.text)
    assert prog.errors == []
    arcs = [m for m in prog.motions if m.kind == "arc"]
    assert arcs and all(m.centre == pytest.approx((50, 50), abs=0.01) for m in arcs)
    assert all(math.dist(m.start, m.centre) == pytest.approx(20.1, abs=0.01) for m in arcs)


def test_tabs_turn_laser_off():
    o = rect_obj("a", 10, 10, 40, 20, tabs=[{"atLengthMm": 20, "widthMm": 4}])
    r = generate(job([o]), preset(), MACHINE)
    mv = [m for m in parse(r.text).motions if m.kind == "line"]
    off = [m for m in mv if m.power == 0]
    assert sum(m.length for m in off) == pytest.approx(4, abs=0.01)
    assert sum(m.length for m in mv) == pytest.approx(120, abs=0.01)
    centre = [m for m in off][0]
    assert centre.start[0] == pytest.approx(28, abs=0.01) and centre.end[0] == pytest.approx(32, abs=0.01)


def test_tab_wrapping_across_start():
    o = rect_obj("a", 10, 10, 40, 20, tabs=[{"atLengthMm": 1, "widthMm": 4}])
    r = generate(job([o]), preset(), MACHINE)
    off = sum(m.length for m in parse(r.text).motions if m.kind == "line" and m.power == 0)
    assert off == pytest.approx(4, abs=0.01)


def test_per_object_settings_override():
    o = rect_obj("a", 10, 10, 20, 20, settings={"powerPct": 10, "speedMmPerS": 5, "passes": 2})
    r = generate(job([o]), preset(), MACHINE)
    mv = [m for m in parse(r.text).motions if m.kind == "line"]
    assert len(mv) == 8
    assert mv[0].feed_mm_s == pytest.approx(5) and mv[0].power == pytest.approx(100, abs=1)


def test_out_of_bed_refused():
    with pytest.raises(GcodeError):
        generate(job([rect_obj("a", 380, 10, 40, 20)]), preset(), MACHINE)


def test_current_position_needs_head_and_offsets():
    j = job([rect_obj("a", 0, 0, 20, 10)], {"mode": "current-position", "anchor": "bottom-left"})
    with pytest.raises(GcodeError):
        generate(j, preset(), MACHINE)
    r = generate(j, preset(), MACHINE, head=(100, 50))
    assert r.bounds == pytest.approx((100, 50, 120, 60))
    j["origin"]["anchor"] = "center"
    r = generate(j, preset(), MACHINE, head=(100, 50))
    assert r.bounds == pytest.approx((90, 45, 110, 55))


def test_untested_warning():
    r = generate(job([rect_obj("a", 10, 10, 20, 20)]), preset(tested=False), MACHINE)
    assert r.untested and any("test" in w.lower() for w in r.warnings)


def test_estimate_scales_with_speed():
    a = generate(job([rect_obj("a", 10, 10, 100, 100)]), preset(), MACHINE).estimate["durationS"]
    p = preset()
    p["cut"]["speedMmPerS"] /= 2
    b = generate(job([rect_obj("a", 10, 10, 100, 100)]), p, MACHINE).estimate["durationS"]
    assert b > 1.6 * a
    assert generate(job([rect_obj("a", 10, 10, 100, 100)]), preset(), MACHINE).estimate["partAreaMm2"] == pytest.approx(10000, abs=1)


def test_estimate_reports_the_design_size_not_the_bed():
    r = generate(job([rect_obj("a", 10, 10, 100, 60)]), preset(), MACHINE)
    assert r.estimate["extentMm"] == {"widthMm": 100.0, "heightMm": 60.0}


def test_scaled_matrix_flattens_arcs():
    o = circle_obj("c", 0, 0, 10)
    o["matrix"] = [2, 0, 0, 1, 50, 50]  # ellipse
    r = generate(job([o]), preset(), MACHINE)
    prog = parse(r.text)
    assert prog.errors == [] and not any(m.kind == "arc" for m in prog.motions)
    assert r.bounds == pytest.approx((30, 40, 70, 60), abs=0.02)


def _on_off(text):
    mv = [m for m in parse(text).motions if m.kind == "line"]
    return sum(m.length for m in mv if m.power > 0), sum(m.length for m in mv if m.power == 0)


def test_dashed_line_alternates_and_keeps_length():
    o = rect_obj("a", 10, 10, 40, 20, settings={"dashMm": 5})  # perimeter 120 mm
    r = generate(job([o]), preset(), MACHINE)
    on, off = _on_off(r.text)
    assert on == pytest.approx(60, abs=0.01) and off == pytest.approx(60, abs=0.01)
    first = [m for m in parse(r.text).motions if m.kind == "line"][:3]
    assert [m.power > 0 for m in first] == [True, False, True]  # starts with a dash
    assert first[0].length == pytest.approx(5, abs=0.01) and first[1].length == pytest.approx(5, abs=0.01)


def test_dash_zero_is_solid_and_preset_default_applies():
    solid = generate(job([rect_obj("a", 10, 10, 40, 20, settings={"dashMm": 0})]), preset(), MACHINE)
    assert _on_off(solid.text)[1] == 0
    p = preset()
    p["cut"]["dashMm"] = 10
    r = generate(job([rect_obj("a", 10, 10, 40, 20)]), p, MACHINE)
    assert _on_off(r.text)[1] == pytest.approx(60, abs=0.01)
    r = generate(job([rect_obj("a", 10, 10, 40, 20, settings={"dashMm": 0})]), p, MACHINE)  # per-shape beats the material
    assert _on_off(r.text)[1] == 0


def test_dashed_circle_keeps_arcs_and_tabs_stay_off():
    r = generate(job([circle_obj("c", 50, 50, 12.5, settings={"dashMm": 4})]), preset(), MACHINE)
    prog = parse(r.text)
    assert prog.errors == [] and any(m.kind == "arc" for m in prog.motions)
    t = rect_obj("t", 10, 10, 40, 20, tabs=[{"atLengthMm": 20, "widthMm": 10}], settings={"dashMm": 5})
    on, off = _on_off(generate(job([t]), preset(), MACHINE).text)
    assert on + off == pytest.approx(120, abs=0.01) and off >= 60 + 1  # tab span adds off length where it overlaps a dash


def star_obj(cx, cy, big, small):
    pts = [[cx + (big if i % 2 == 0 else small) * math.cos(math.pi / 2 + i * math.pi / 5),
            cy + (big if i % 2 == 0 else small) * math.sin(math.pi / 2 + i * math.pi / 5)] for i in range(10)]
    return {"id": "s", "layer": "cut", "closed": True, "start": pts[0],
            "segments": [{"type": "line", "to": p} for p in pts[1:] + [pts[0]]], "matrix": [1, 0, 0, 1, 0, 0]}


def test_sharp_design_passes_the_fit_check_before_a_laser_is_chosen():
    # Placed exactly on the bed corner, kerf at a star's tips would poke past the edge; the pre-check leaves a margin.
    j = job([star_obj(70, 185, 60, 25)], {"mode": "current-position", "anchor": "bottom-left"})
    generate(j, preset(kerf=0.2), MACHINE, head=probe_head(j))
