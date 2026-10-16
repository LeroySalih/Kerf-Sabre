from __future__ import annotations

import copy

import pytest

from .conftest import auth
from .dxfmaker import make_dxf, rect

API = "/api/v1"


def preset(**over):
    base = {"schemaVersion": "0.2.19", "id": "felt-2mm", "version": 1, "material": "Felt", "thicknessMm": 2, "sheet": {"widthMm": 300, "heightMm": 300},
            "kerfMm": 0.1, "cut": {"powerPct": 50, "speedMmPerS": 8, "passes": 1, "airAssist": True}, "score": {"powerPct": 10, "speedMmPerS": 30, "passes": 1, "airAssist": False}}
    base.update(over)
    return base


class TestPresets:
    def test_seeded_presets_are_listed_for_pupils(self, client, tokens):
        r = client.get(f"{API}/presets", headers=auth(tokens["pupil"]))
        ids = [p["id"] for p in r.json()]
        assert "ply-3mm" in ids and len(ids) == 5

    def test_a_pupil_cannot_create_or_edit(self, client, tokens):
        assert client.post(f"{API}/presets", json=preset(), headers=auth(tokens["pupil"])).status_code == 403
        assert client.put(f"{API}/presets/ply-3mm", json=preset(id="ply-3mm"), headers=auth(tokens["pupil"])).status_code == 403

    def test_teacher_creates_then_edits_and_the_server_counts_versions(self, client, tokens):
        h = auth(tokens["teacher"])
        assert client.post(f"{API}/presets", json=preset(), headers=h).status_code == 201
        assert client.post(f"{API}/presets", json=preset(), headers=h).status_code == 409  # already there
        edited = preset(kerfMm=0.12)
        r = client.put(f"{API}/presets/felt-2mm", json=edited, headers=h)
        assert r.status_code == 200 and r.json()["version"] == 2
        assert client.get(f"{API}/presets/felt-2mm", headers=h).json()["kerfMm"] == 0.12
        again = client.put(f"{API}/presets/felt-2mm", json=preset(kerfMm=0.2, version=99), headers=h).json()
        assert again["version"] == 3  # the client cannot choose the version

    def test_invalid_presets_are_refused_with_details(self, client, tokens):
        r = client.post(f"{API}/presets", json=preset(cut={"powerPct": 150, "speedMmPerS": 3, "passes": 1, "airAssist": True}), headers=auth(tokens["teacher"]))
        assert r.status_code == 422 and r.json()["details"]

    def test_put_must_match_the_url(self, client, tokens):
        assert client.put(f"{API}/presets/ply-3mm", json=preset(id="other"), headers=auth(tokens["teacher"])).status_code == 422
        assert client.put(f"{API}/presets/nope", json=preset(id="nope"), headers=auth(tokens["teacher"])).status_code == 404

    def test_unknown_preset_is_404(self, client, tokens):
        assert client.get(f"{API}/presets/nope", headers=auth(tokens["pupil"])).status_code == 404


class TestMachines:
    def test_the_four_stations_have_the_beds_the_spike_measured(self, client, tokens):
        ms = client.get(f"{API}/machines", headers=auth(tokens["pupil"])).json()
        assert [m["id"] for m in ms] == [f"station-{i}" for i in range(1, 5)]
        beds = {m["id"]: (m["bed"]["widthMm"], m["bed"]["heightMm"]) for m in ms}
        assert beds == {"station-1": (400, 415), "station-2": (400, 415), "station-3": (355, 390), "station-4": (355, 390)}  # $130/$131 from docs/spike-results.md
        assert all(not m["placeholder"] and m["grbl"]["s30Max"] == 1000 and m["grbl"]["laserMode"] and m["camera"]["type"] == "usb-uvc" for m in ms)

    def test_teacher_replaces_a_profile_from_spike_results(self, client, tokens):
        h = auth(tokens["teacher"])
        m = copy.deepcopy(client.get(f"{API}/machines/station-1", headers=h).json())
        m.update(placeholder=False, model="Falcon 2 Pro", bed={"widthMm": 410, "heightMm": 400, "originCorner": "front-left"})
        assert client.put(f"{API}/machines/station-1", json=m, headers=h).status_code == 200
        got = client.get(f"{API}/machines/station-1", headers=auth(tokens["pupil"])).json()
        assert got["placeholder"] is False and got["bed"]["widthMm"] == 410
        assert client.put(f"{API}/machines/station-1", json=m, headers=auth(tokens["pupil"])).status_code == 403

    def test_a_bad_profile_is_refused(self, client, tokens):
        m = client.get(f"{API}/machines/station-1", headers=auth(tokens["teacher"])).json()
        m["bed"]["originCorner"] = "middle"
        assert client.put(f"{API}/machines/station-1", json=m, headers=auth(tokens["teacher"])).status_code == 422


class TestDxfCleanupEndpoint:
    def upload(self, client, token, data, **form):
        return client.post(f"{API}/dxf/cleanup", files={"file": ("any name.dxf", data, "application/dxf")}, data=form, headers=auth(token))

    def test_cleans_and_returns_objects_report_and_units(self, client, tokens):
        data = make_dxf(lambda d, m: (rect(m, 0, 0, 10, 5), rect(m, 0, 0, 10, 5)), insunits=None)
        r = self.upload(client, tokens["pupil"], data)
        assert r.status_code == 200
        body = r.json()
        assert body["report"]["closedShapes"] == 1 and body["report"]["duplicatesRemoved"] == 4
        assert body["units"] == {"source": "assumed-cm", "mmPerUnit": 10.0}
        assert body["objects"][0]["matrix"] == [1, 0, 0, 1, 0, 0]

    def test_units_override_and_tolerance_are_honoured(self, client, tokens):
        data = make_dxf(lambda d, m: m.add_line((0, 0), (1, 0)), insunits=None)
        body = self.upload(client, tokens["pupil"], data, unitsOverride="inch", toleranceMm="0.02").json()
        assert body["units"]["mmPerUnit"] == 25.4

    def test_bad_inputs_are_422_in_the_contract_shape(self, client, tokens):
        t = tokens["pupil"]
        assert self.upload(client, t, b"not a dxf").json()["code"] == "dxf_unreadable"
        assert self.upload(client, t, make_dxf(lambda d, m: m.add_text("x"), 4)).json()["code"] == "dxf_empty"
        good = make_dxf(lambda d, m: m.add_line((0, 0), (1, 1)), 4)
        assert self.upload(client, t, good, unitsOverride="furlongs").status_code == 422
        assert self.upload(client, t, good, toleranceMm="5").status_code == 422
        assert self.upload(client, t, b"").status_code == 422

    def test_oversized_uploads_are_refused(self, client, tokens, app):
        object.__setattr__(app.state.settings, "max_upload_mb", 0)  # 0 MB limit: anything is too big
        r = self.upload(client, tokens["pupil"], make_dxf(lambda d, m: m.add_line((0, 0), (1, 1)), 4))
        assert r.status_code == 413 and r.json()["code"] == "too_large"

    def test_needs_a_token(self, client):
        assert client.post(f"{API}/dxf/cleanup", files={"file": ("a.dxf", b"x")}).status_code == 401

    def test_the_uploaded_file_name_is_not_stored_anywhere(self, client, tokens, app):
        self.upload(client, tokens["pupil"], make_dxf(lambda d, m: m.add_line((0, 0), (1, 1)), 4))
        import pathlib
        blob = b"".join(p.read_bytes() for p in pathlib.Path(app.state.settings.data_dir).rglob("*") if p.is_file())
        assert b"any name" not in blob


class TestServesEditor:
    def test_editor_is_served_at_the_root_next_to_the_api(self, tmp_path):
        from fastapi.testclient import TestClient

        from kerf_server.app import create_app
        from kerf_server.config import Settings

        dist = tmp_path / "dist"
        dist.mkdir()
        (dist / "index.html").write_text("<title>Kerf</title>")
        app = create_app(Settings.from_env(data_dir=tmp_path / "d", editor_dist=dist))
        with TestClient(app) as c:
            assert "Kerf" in c.get("/").text
            assert c.get("/health").json()["status"] == "ok"
            assert c.get(f"{API}/auth/me").status_code == 401  # the API is not shadowed by the static mount
