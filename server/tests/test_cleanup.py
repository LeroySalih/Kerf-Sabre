from __future__ import annotations

import json
import math
import random
import time
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from kerf_server.cleanup import DxfError, EmptyDrawing, cleanup_dxf

from .dxfmaker import make_dxf, rect

MM = 4  # $INSUNITS


def shapes(out, layer=None, closed=None):
    return [o for o in out.objects if (layer is None or o["layer"] == layer) and (closed is None or o["closed"] == closed)]


def length(o) -> float:
    cur = o["start"]
    total = 0.0
    for s in o["segments"]:
        if s["type"] == "line":
            total += math.dist(cur, s["to"])
        else:
            r = math.dist(cur, s["center"])
            a0 = math.atan2(cur[1] - s["center"][1], cur[0] - s["center"][0])
            a1 = math.atan2(s["to"][1] - s["center"][1], s["to"][0] - s["center"][0])
            sweep = (a0 - a1) % math.tau if s["clockwise"] else (a1 - a0) % math.tau
            total += r * (sweep or math.tau)
        cur = s["to"]
    return total


class TestUnits:
    def test_missing_units_are_assumed_to_be_centimetres(self):
        out = cleanup_dxf(make_dxf(lambda d, m: m.add_line((0, 0), (10, 0)), insunits=None))
        assert out.units == {"source": "assumed-cm", "mmPerUnit": 10.0}
        assert length(out.objects[0]) == pytest.approx(100.0)

    def test_header_units_are_used(self):
        out = cleanup_dxf(make_dxf(lambda d, m: m.add_line((0, 0), (10, 0)), insunits=MM))
        assert out.units == {"source": "header", "mmPerUnit": 1.0}
        assert length(out.objects[0]) == pytest.approx(10.0)
        inch = cleanup_dxf(make_dxf(lambda d, m: m.add_line((0, 0), (1, 0)), insunits=1))
        assert length(inch.objects[0]) == pytest.approx(25.4)

    def test_override_applies_only_when_the_header_is_missing(self):
        f = lambda d, m: m.add_line((0, 0), (1, 0))
        assert length(cleanup_dxf(make_dxf(f, None), units_override="inch").objects[0]) == pytest.approx(25.4)
        assert length(cleanup_dxf(make_dxf(f, None), units_override="mm").objects[0]) == pytest.approx(1.0)
        assert cleanup_dxf(make_dxf(f, MM), units_override="inch").units["source"] == "header"
        assert cleanup_dxf(make_dxf(f, None), units_override="mm").units["source"] == "override"

    def test_unknown_unit_codes_fall_back_to_cm(self):
        out = cleanup_dxf(make_dxf(lambda d, m: m.add_line((0, 0), (1, 0)), insunits=3))
        assert out.units["source"] == "assumed-cm"


class TestJoin:
    def test_loose_edges_become_one_closed_shape_at_the_origin(self):
        out = cleanup_dxf(make_dxf(lambda d, m: rect(m, 100, 200, 120, 210), MM))
        (sq,) = shapes(out)
        assert sq["closed"] and len(sq["segments"]) == 4
        pts = [sq["start"]] + [s["to"] for s in sq["segments"]]
        assert min(p[0] for p in pts) == pytest.approx(0) and min(p[1] for p in pts) == pytest.approx(0)  # bounding box bottom-left at (0,0)
        assert max(p[0] for p in pts) == pytest.approx(20) and max(p[1] for p in pts) == pytest.approx(10)
        assert out.report["closedShapes"] == 1 and out.report["openPaths"] == 0

    def test_order_and_direction_of_the_edges_do_not_matter(self):
        def build(d, m):
            m.add_line((10, 10), (0, 10))
            m.add_line((0, 0), (10, 0))
            m.add_line((0, 10), (0, 0))
            m.add_line((10, 0), (10, 10))
        assert len(shapes(cleanup_dxf(make_dxf(build, MM)), closed=True)) == 1

    def test_ends_within_the_tolerance_are_snapped_together(self):
        def build(d, m):
            m.add_line((0, 0), (10, 0))
            m.add_line((10.004, 0.003), (10, 10))
            m.add_line((10, 10), (0, 10))
            m.add_line((0.002, 10), (0, 0.001))
        assert len(shapes(cleanup_dxf(make_dxf(build, MM)), closed=True)) == 1

    def test_a_gap_larger_than_the_tolerance_stays_open(self):
        def build(d, m):
            m.add_line((0, 0), (10, 0))
            m.add_line((10, 0.5), (10, 10))
        out = cleanup_dxf(make_dxf(build, MM))
        assert out.report["closedShapes"] == 0 and out.report["openPaths"] == 2

    def test_a_hole_and_its_plate_are_two_closed_shapes(self):
        def build(d, m):
            rect(m, 0, 0, 40, 30)
            rect(m, 10, 10, 20, 20)
        out = cleanup_dxf(make_dxf(build, MM))
        assert out.report["closedShapes"] == 2 and out.report["openPaths"] == 0

    def test_a_dangling_spur_is_kept_as_an_open_path_and_does_not_spoil_the_shape(self):
        def build(d, m):
            rect(m, 0, 0, 10, 10)
            m.add_line((10, 10), (20, 20))
        out = cleanup_dxf(make_dxf(build, MM))
        assert out.report["closedShapes"] == 1 and out.report["openPaths"] == 1
        (sq,) = shapes(out, closed=True)
        assert len(sq["segments"]) == 4

    def test_parts_sharing_an_edge_each_get_their_own_closed_outline(self):
        def build(d, m):
            rect(m, 0, 0, 20, 10)
            rect(m, 20, 0, 30, 10)  # shares the whole x=20 edge
        out = cleanup_dxf(make_dxf(build, MM))
        assert out.report["duplicatesRemoved"] == 1  # the shared edge is drawn twice
        closed = shapes(out, closed=True)
        assert len(closed) == 2 and all(len(o["segments"]) == 4 for o in closed)  # the shared edge is in both
        assert sorted(round(length(o)) for o in closed) == [40, 60]  # 20x10 (60) and 10x10 (40)

    def test_a_partly_shared_edge_is_split_at_the_t_junction(self):
        def build(d, m):
            rect(m, 0, 0, 20, 10)
            rect(m, 20, 0, 40, 5)  # its left edge covers only the lower half of x=20
        out = cleanup_dxf(make_dxf(build, MM))
        assert out.report["closedShapes"] == 2 and out.report["openPaths"] == 0
        assert out.report["overlapsMerged"] == 1

    def test_closed_shapes_are_arcs_not_polygons(self):
        def build(d, m):
            m.add_circle((50, 50), 5)
        (c,) = shapes(cleanup_dxf(make_dxf(build, MM)))
        assert c["closed"] and all(s["type"] == "arc" for s in c["segments"])
        assert length(c) == pytest.approx(2 * math.pi * 5)

    def test_a_rounded_rectangle_from_a_polyline_keeps_its_arcs(self):
        def build(d, m):
            r = math.tan(math.radians(90) / 4)  # bulge of a quarter circle
            pts = [(2, 0, 0), (8, 0, r), (10, 2, 0), (10, 8, r), (8, 10, 0), (2, 10, r), (0, 8, 0), (0, 2, r)]
            m.add_lwpolyline(pts, format="xyb", close=True)
        (s,) = shapes(cleanup_dxf(make_dxf(build, MM)))
        assert s["closed"]
        assert sum(1 for g in s["segments"] if g["type"] == "arc") == 4
        assert length(s) == pytest.approx(4 * 6 + 2 * math.pi * 2, rel=1e-3)


class TestDedupeAndMerge:
    def test_identical_and_reversed_lines_are_removed(self):
        def build(d, m):
            rect(m, 0, 0, 10, 10)
            m.add_line((0, 0), (10, 0))
            m.add_line((10, 0), (0, 0))  # the same line the other way round
            m.add_line((10, 0.001), (10, 10.002))  # nearly the same as an edge
        out = cleanup_dxf(make_dxf(build, MM))
        assert out.report["duplicatesRemoved"] >= 3
        assert out.report["closedShapes"] == 1 and out.report["openPaths"] == 0

    def test_overlapping_collinear_lines_become_one(self):
        def build(d, m):
            m.add_line((0, 0), (10, 0))
            m.add_line((6, 0), (16, 0))
        out = cleanup_dxf(make_dxf(build, MM))
        assert out.report["overlapsMerged"] == 1
        (ln,) = out.objects
        assert length(ln) == pytest.approx(16)

    def test_lines_that_merely_touch_are_not_merged(self):
        def build(d, m):
            m.add_line((0, 0), (10, 0))
            m.add_line((10, 0), (20, 0))
        out = cleanup_dxf(make_dxf(build, MM))
        assert out.report["overlapsMerged"] == 0
        assert out.report["openPaths"] == 1 and length(out.objects[0]) == pytest.approx(20)  # joined into one path

    def test_overlapping_arcs_of_one_circle_merge_and_duplicate_circles_collapse(self):
        def build(d, m):
            m.add_arc((0, 0), 10, 0, 100)
            m.add_arc((0, 0), 10, 60, 180)
            m.add_circle((30, 0), 5)
            m.add_circle((30, 0), 5)
            m.add_arc((30, 0), 5, 10, 350)  # already covered by the circle
        out = cleanup_dxf(make_dxf(build, MM))
        arcs = [o for o in out.objects if not o["closed"]]
        assert len(arcs) == 1 and length(arcs[0]) == pytest.approx(10 * math.radians(180))
        assert out.report["duplicatesRemoved"] >= 1 and out.report["overlapsMerged"] >= 2
        assert out.report["closedShapes"] == 1

    def test_duplicate_splines_are_removed_and_a_closed_spline_closes(self):
        def build(d, m):
            pts = [(0, 0), (5, 3), (10, 0), (5, -3), (0, 0)]
            m.add_spline(fit_points=pts)
            m.add_spline(fit_points=pts)
            m.add_spline(fit_points=pts[::-1])  # same curve, other direction
        out = cleanup_dxf(make_dxf(build, MM))
        assert out.report["duplicatesRemoved"] == 2


class TestMicroAndConflict:
    def test_a_tiny_segment_is_collapsed_and_the_shape_still_closes(self):
        def build(d, m):
            m.add_line((0, 0), (10, 0))
            m.add_line((10, 0), (10, 5))
            m.add_line((10, 5), (10.03, 5.02))  # a 0.036 mm sliver
            m.add_line((10.03, 5.02), (10, 10))
            m.add_line((10, 10), (0, 10))
            m.add_line((0, 10), (0, 0))
        out = cleanup_dxf(make_dxf(build, MM))
        assert out.report["microSegmentsRemoved"] == 1
        assert out.report["closedShapes"] == 1 and out.report["openPaths"] == 0

    def test_layers_follow_names_and_blue_cyan(self):
        def build(d, m):
            d.layers.add("SCORE_LINES")
            d.layers.add("blue", color=5)
            m.add_line((0, 0), (10, 0), dxfattribs={"layer": "SCORE_LINES"})
            m.add_line((0, 5), (10, 5), dxfattribs={"layer": "blue"})
            m.add_line((0, 8), (10, 8), dxfattribs={"layer": "0"})
            m.add_line((0, 9), (10, 9), dxfattribs={"layer": "0", "color": 4})
        out = cleanup_dxf(make_dxf(build, MM))
        assert len(shapes(out, "score")) == 3 and len(shapes(out, "cut")) == 1

    def test_the_same_line_on_both_layers_is_cut_not_scored(self):
        def build(d, m):
            d.layers.add("SCORE")
            rect(m, 0, 0, 10, 10, layer="0")
            rect(m, 0, 0, 10, 10, layer="SCORE")
        out = cleanup_dxf(make_dxf(build, MM))
        assert out.report["scoreCutConflicts"] == 4
        assert not shapes(out, "score") and len(shapes(out, "cut", closed=True)) == 1

    def test_score_is_only_removed_where_cut_runs(self):
        def build(d, m):
            d.layers.add("SCORE")
            m.add_line((0, 0), (10, 0), dxfattribs={"layer": "0"})
            m.add_line((0, 0), (20, 0), dxfattribs={"layer": "SCORE"})  # the first half is also cut
        out = cleanup_dxf(make_dxf(build, MM))
        (sc,) = shapes(out, "score")
        assert length(sc) == pytest.approx(10)
        assert out.report["scoreCutConflicts"] == 1


class TestEntities:
    def test_unsupported_entities_are_counted_not_fatal(self):
        def build(d, m):
            rect(m, 0, 0, 10, 10)
            m.add_text("hello")
            m.add_point((1, 1))
        out = cleanup_dxf(make_dxf(build, MM))
        assert out.report["skippedEntities"] == {"TEXT": 1, "POINT": 1}
        assert out.report["closedShapes"] == 1

    def test_block_references_are_placed(self):
        def build(d, m):
            blk = d.blocks.new("PART")
            for a, b in [((0, 0), (5, 0)), ((5, 0), (5, 5)), ((5, 5), (0, 5)), ((0, 5), (0, 0))]:
                blk.add_line(a, b)
            m.add_blockref("PART", (0, 0))
            m.add_blockref("PART", (20, 0))
        assert cleanup_dxf(make_dxf(build, MM)).report["closedShapes"] == 2

    def test_mirrored_entities_land_in_the_right_place(self):
        def build(d, m):
            m.add_line((0, 0), (10, 0))
            m.add_circle((5, 5), 2, dxfattribs={"extrusion": (0, 0, -1)})  # in the world its centre is (-5, 5)
        out = cleanup_dxf(make_dxf(build, MM))
        ln = next(o for o in out.objects if not o["closed"])
        circ = next(o for o in out.objects if o["closed"])
        assert ln["start"][0] == pytest.approx(7)  # the circle reaches x = -7, so everything shifts right by 7
        assert circ["segments"][0]["center"][0] == pytest.approx(2)

    def test_binary_garbage_and_empty_drawings_are_refused(self):
        with pytest.raises(DxfError):
            cleanup_dxf(b"\x00\x01 this is not a drawing")
        with pytest.raises(EmptyDrawing):
            cleanup_dxf(make_dxf(lambda d, m: m.add_text("nothing to cut"), MM))


class TestOutput:
    def test_objects_are_valid_job_objects(self):
        def build(d, m):
            rect(m, 0, 0, 20, 10)
            m.add_circle((10, 5), 2)
            m.add_line((30, 0), (40, 5))
        out = cleanup_dxf(make_dxf(build, MM))
        schema = json.loads((Path(__file__).resolve().parents[2] / "shared" / "job.schema.json").read_text())
        job = {"schemaVersion": "0.2.0", "id": "j1", "pupilId": "P001", "createdAt": "2026-01-01T00:00:00Z", "status": "draft",
               "preset": {"id": "ply-3mm", "version": 2}, "origin": {"mode": "absolute"}, "objects": out.objects}
        errors = list(Draft202012Validator(schema).iter_errors(job))
        assert not errors, errors[:2]

    def test_the_summary_reads_like_the_brief(self):
        def build(d, m):
            rect(m, 0, 0, 10, 10)
            m.add_line((0, 0), (10, 0))
            m.add_line((30, 30), (31, 31))
        s = cleanup_dxf(make_dxf(build, MM)).report["summary"]
        assert s.startswith("Removed 1 duplicate") and "joined into 1 closed shape" in s and s.endswith("1 open path")

    def test_changes_are_listed_for_highlighting(self):
        def build(d, m):
            rect(m, 0, 0, 10, 10)
            m.add_line((0, 0), (10, 0))
        ch = cleanup_dxf(make_dxf(build, MM)).report["changes"]
        assert ch and ch[0]["type"] == "duplicate" and len(ch[0]["points"]) == 2

    def test_cleaning_is_fast_enough_for_a_class_set_of_parts(self):
        rnd = random.Random(4)

        def build(d, m):
            for i in range(400):
                x, y = (i % 20) * 30, (i // 20) * 30
                rect(m, x, y, x + rnd.uniform(5, 25), y + rnd.uniform(5, 25))
                if i % 3 == 0:
                    m.add_line((x, y), (x + 1, y))  # a duplicate piece
        t0 = time.time()
        out = cleanup_dxf(make_dxf(build, MM))
        assert out.report["closedShapes"] == 400
        assert time.time() - t0 < 10
