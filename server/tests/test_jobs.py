from __future__ import annotations

import copy

import pytest

from .conftest import auth
from .dxfmaker import make_dxf, rect

API = "/api/v1"


def rect_obj(oid, x, y, w, h, layer="cut", closed=True):
    segs = [{"type": "line", "to": [x + w, y]}, {"type": "line", "to": [x + w, y + h]}, {"type": "line", "to": [x, y + h]}]
    if closed:
        segs.append({"type": "line", "to": [x, y]})
    return {"id": oid, "layer": layer, "closed": closed, "start": [x, y], "segments": segs, "matrix": [1, 0, 0, 1, 0, 0]}


def job_doc(pupil="P001", status="draft", objects=None, **over):
    d = {"schemaVersion": "0.2.15", "id": "x", "pupilId": pupil, "createdAt": "2026-10-13T09:00:00Z", "status": status,
         "preset": {"id": "ply-3mm", "version": 1}, "station": None, "origin": {"mode": "absolute"},
         "objects": objects or [rect_obj("a", 20, 20, 50, 30)]}
    d.update(over)
    return d


def post(client, tokens, who="pupil", **kw):
    r = client.post(f"{API}/jobs", json=job_doc(**kw), headers=auth(tokens[who]))
    return r


class TestSave:
    def test_draft_then_submit_then_approve(self, client, tokens):
        r = post(client, tokens)
        assert r.status_code == 201, r.text
        jid = r.json()["id"]
        assert r.json()["status"] == "draft" and jid != "x"
        s = client.post(f"{API}/jobs/{jid}/submit", headers=auth(tokens["pupil"]))
        assert s.status_code == 200 and s.json()["status"] == "submitted"
        assert s.json()["estimate"]["durationS"] > 0
        assert client.post(f"{API}/jobs/{jid}/approve", headers=auth(tokens["pupil"])).status_code == 403
        a = client.post(f"{API}/jobs/{jid}/approve", json={"station": "station-2"}, headers=auth(tokens["teacher"]))
        assert a.status_code == 200 and a.json()["status"] == "approved"
        doc = client.get(f"{API}/jobs/{jid}", headers=auth(tokens["pupil"])).json()
        assert doc["station"] == "station-2" and doc["status"] == "approved"
        g = client.get(f"{API}/jobs/{jid}/gcode", headers=auth(tokens["station"]))
        assert g.status_code == 200 and g.text.startswith("; Kerf") and "G92" not in g.text

    def test_submit_straight_away(self, client, tokens):
        r = post(client, tokens, status="submitted")
        assert r.status_code == 201 and r.json()["status"] == "submitted"

    def test_no_approval_mode_goes_straight_to_approved(self, tmp_path):
        from fastapi.testclient import TestClient

        from kerf_server.app import create_app
        from kerf_server.config import Settings
        from kerf_server.security import issue_token

        app = create_app(Settings.from_env(data_dir=tmp_path / "d", require_approval=False))
        with TestClient(app) as c:
            t = issue_token(app.state.db, "pupil", "P001")
            r = c.post(f"{API}/jobs", json=job_doc(status="submitted"), headers=auth(t))
            assert r.json()["status"] == "approved"

    def test_pupil_cannot_save_as_someone_else(self, client, tokens):
        assert post(client, tokens, pupil="P002").status_code == 403
        assert post(client, tokens, who="teacher", pupil="P002").status_code == 201

    def test_schema_violation_is_422(self, client, tokens):
        bad = job_doc()
        bad["objects"][0]["layer"] = "engrave"
        r = client.post(f"{API}/jobs", json=bad, headers=auth(tokens["pupil"]))
        assert r.status_code == 422 and r.json()["code"] == "invalid"

    def test_cannot_create_a_job_that_is_already_running(self, client, tokens):
        assert post(client, tokens, status="running").status_code == 422

    def test_unknown_preset(self, client, tokens):
        r = post(client, tokens, preset={"id": "nope", "version": 1})
        assert r.status_code == 422 and r.json()["code"] == "unknown_preset"


class TestValidation:
    def test_out_of_bounds_blocks_submit_but_not_draft(self, client, tokens):
        big = [rect_obj("a", 350, 10, 100, 20)]
        assert post(client, tokens, objects=big).status_code == 201
        r = post(client, tokens, objects=big, status="submitted")
        assert r.status_code == 422 and "bed" in r.json()["message"]

    def test_open_cut_path_blocks(self, client, tokens):
        r = post(client, tokens, objects=[rect_obj("a", 10, 10, 20, 20, closed=False)], status="submitted")
        assert r.status_code == 422 and r.json()["code"] == "open_cut_path"

    def test_open_score_path_is_fine(self, client, tokens):
        r = post(client, tokens, objects=[rect_obj("a", 10, 10, 20, 20), rect_obj("s", 12, 12, 5, 5, layer="score", closed=False)], status="submitted")
        assert r.status_code == 201

    def test_untested_material_warns(self, client, tokens):
        r = post(client, tokens, status="submitted", preset={"id": "mdf-3mm", "version": 1})
        assert any("test-gridded" in w and "station-1" in w for w in r.json()["warnings"])


class TestVisibility:
    def test_pupils_only_see_their_own(self, client, tokens):
        mine = post(client, tokens).json()["id"]
        theirs = post(client, tokens, who="teacher", pupil="P002").json()["id"]
        h = auth(tokens["pupil"])
        assert [j["id"] for j in client.get(f"{API}/jobs", headers=h).json()] == [mine]
        assert client.get(f"{API}/jobs/{theirs}", headers=h).status_code == 404
        assert client.get(f"{API}/jobs/{theirs}/gcode", headers=h).status_code == 404
        assert client.post(f"{API}/jobs/{theirs}/cancel", headers=h).status_code == 404
        assert len(client.get(f"{API}/jobs", headers=auth(tokens["station"])).json()) == 2

    def test_filter_by_status(self, client, tokens):
        post(client, tokens)
        post(client, tokens, status="submitted")
        h = auth(tokens["teacher"])
        assert len(client.get(f"{API}/jobs?status=submitted", headers=h).json()) == 1
        assert len(client.get(f"{API}/jobs?status=draft,submitted", headers=h).json()) == 2

    def test_job_docs_match_the_shared_schema(self, client, tokens, settings):
        from kerf_server.schemas import validate

        jid = post(client, tokens, status="submitted").json()["id"]
        validate(settings.shared_dir, "job", client.get(f"{API}/jobs/{jid}", headers=auth(tokens["pupil"])).json())


class TestLifecycle:
    def test_replace_only_drafts(self, client, tokens):
        h = auth(tokens["pupil"])
        jid = post(client, tokens).json()["id"]
        new = job_doc(objects=[rect_obj("b", 5, 5, 10, 10)])
        assert client.put(f"{API}/jobs/{jid}", json=new, headers=h).status_code == 200
        assert client.get(f"{API}/jobs/{jid}", headers=h).json()["objects"][0]["id"] == "b"
        client.post(f"{API}/jobs/{jid}/submit", headers=h)
        assert client.put(f"{API}/jobs/{jid}", json=new, headers=h).status_code == 409

    def test_reject_needs_reason_and_is_shown_to_the_pupil(self, client, tokens):
        jid = post(client, tokens, status="submitted").json()["id"]
        t = auth(tokens["teacher"])
        assert client.post(f"{API}/jobs/{jid}/reject", json={}, headers=t).status_code == 422
        assert client.post(f"{API}/jobs/{jid}/reject", json={"reason": "Too thin to cut"}, headers=t).status_code == 200
        doc = client.get(f"{API}/jobs/{jid}", headers=auth(tokens["pupil"])).json()
        assert doc["status"] == "cancelled" and doc["statusReason"] == "Too thin to cut"

    def test_cancel_and_double_approve(self, client, tokens):
        jid = post(client, tokens, status="submitted").json()["id"]
        t = auth(tokens["teacher"])
        assert client.post(f"{API}/jobs/{jid}/approve", headers=t).status_code == 200
        assert client.post(f"{API}/jobs/{jid}/approve", headers=t).status_code == 409
        assert client.post(f"{API}/jobs/{jid}/cancel", headers=auth(tokens["pupil"])).status_code == 200
        assert client.post(f"{API}/jobs/{jid}/cancel", headers=auth(tokens["pupil"])).status_code == 409

    def test_station_cannot_edit_designs(self, client, tokens):
        jid = post(client, tokens).json()["id"]
        assert client.post(f"{API}/jobs/{jid}/submit", headers=auth(tokens["station"])).status_code == 403

    def test_audit_trail(self, client, tokens):
        jid = post(client, tokens, status="submitted").json()["id"]
        client.post(f"{API}/jobs/{jid}/approve", headers=auth(tokens["teacher"]))
        ev = client.get(f"{API}/jobs/{jid}/events", headers=auth(tokens["teacher"])).json()
        assert [(e["kind"], e["actor"]) for e in ev] == [("created", "P001"), ("submitted", "P001"), ("approved", "T001")]

    def test_material_test_job_skips_untested_warning_text(self, client, tokens):
        o = rect_obj("a", 10, 10, 10, 10)
        o["settings"] = {"powerPct": 30, "speedMmPerS": 10}
        r = post(client, tokens, objects=[o], status="submitted")
        assert r.status_code == 201


class TestFromDxf:
    def dxf(self):
        return make_dxf(lambda doc, msp: rect(msp, 0, 0, 50, 30), insunits=4)

    def test_pupil_sends_a_dxf_and_it_is_cleaned(self, client, tokens):
        r = client.post(f"{API}/jobs/from-dxf", data={"presetId": "ply-3mm", "submit": "true"}, files={"file": ("my-name.dxf", self.dxf())}, headers=auth(tokens["pupil"]))
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["status"] == "submitted" and body["report"]["closedShapes"] == 1
        doc = client.get(f"{API}/jobs/{body['id']}", headers=auth(tokens["pupil"])).json()
        assert doc["source"] == "dxf" and doc["pupilId"] == "P001" and "my-name" not in str(doc)

    def test_saves_a_draft_by_default_and_pupil_cannot_pick_another_id(self, client, tokens):
        h = auth(tokens["pupil"])
        r = client.post(f"{API}/jobs/from-dxf", data={"presetId": "ply-3mm"}, files={"file": ("a.dxf", self.dxf())}, headers=h)
        assert r.json()["status"] == "draft"
        r = client.post(f"{API}/jobs/from-dxf", data={"presetId": "ply-3mm", "pupilId": "P002"}, files={"file": ("a.dxf", self.dxf())}, headers=h)
        assert r.status_code == 403

    def test_bad_file(self, client, tokens):
        r = client.post(f"{API}/jobs/from-dxf", data={"presetId": "ply-3mm"}, files={"file": ("a.dxf", b"not a dxf")}, headers=auth(tokens["pupil"]))
        assert r.status_code == 422


class TestDimensions:
    DIMS = [
        {"id": "d1", "kind": "linear", "axis": "horizontal", "a": [20, 20], "b": [70, 20], "offsetMm": -8},
        {"id": "d2", "kind": "radial", "center": [30, 30], "radiusMm": 5, "angleRad": 0.5, "diameter": True},
    ]

    def test_saved_returned_and_replaced(self, client, tokens):
        h = auth(tokens["pupil"])
        jid = post(client, tokens, dimensions=self.DIMS).json()["id"]
        assert client.get(f"{API}/jobs/{jid}", headers=h).json()["dimensions"] == self.DIMS
        client.put(f"{API}/jobs/{jid}", json=job_doc(dimensions=self.DIMS[:1]), headers=h)
        assert client.get(f"{API}/jobs/{jid}", headers=h).json()["dimensions"] == self.DIMS[:1]

    def test_bad_dimension_is_rejected(self, client, tokens):
        bad = [{"id": "d", "kind": "linear", "axis": "diagonal", "a": [0, 0], "b": [1, 1], "offsetMm": 1}]
        assert post(client, tokens, dimensions=bad).status_code == 422

    def test_never_part_of_the_gcode(self, client, tokens):
        h = auth(tokens["station"])
        a = post(client, tokens, status="submitted").json()["id"]
        b = post(client, tokens, status="submitted", dimensions=self.DIMS).json()["id"]
        ga = client.get(f"{API}/jobs/{a}/gcode", headers=h).text.splitlines()
        gb = client.get(f"{API}/jobs/{b}/gcode", headers=h).text.splitlines()
        assert ga[1:] == gb[1:]  # same program (only the job id comment differs)
        assert client.get(f"{API}/jobs/{b}", headers=h).json()["estimate"] == client.get(f"{API}/jobs/{a}", headers=h).json()["estimate"]


class TestOlderEditors:
    """An Editor a few versions behind (same 0.2 series) still saves; anything else about the document is still checked."""

    def test_an_older_patch_version_is_accepted(self, client, tokens):
        r = client.post(f"{API}/jobs", json=job_doc(schemaVersion="0.2.6"), headers=auth(tokens["pupil"]))
        assert r.status_code == 201, r.text

    @pytest.mark.parametrize("version", ["0.1.9", "1.0.0", "0.3.0", "banana", None])
    def test_a_different_series_or_nonsense_is_still_refused(self, client, tokens, version):
        r = client.post(f"{API}/jobs", json=job_doc(schemaVersion=version), headers=auth(tokens["pupil"]))
        assert r.status_code == 422

    def test_other_schema_errors_are_still_reported_with_their_paths(self, client, tokens):
        d = job_doc(schemaVersion="0.2.6")
        d["objects"][0]["layer"] = "engrave"
        r = client.post(f"{API}/jobs", json=d, headers=auth(tokens["pupil"]))
        assert r.status_code == 422 and any("layer" in x["path"] for x in r.json()["details"])
