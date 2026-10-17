"""Schools are walls: nobody in one school can see or change anything in another."""
from __future__ import annotations

import copy

import pytest
from starlette.websockets import WebSocketDisconnect

from kerf_server.security import issue_token

from .conftest import auth
from .test_jobs import job_doc

API = "/api/v1"


@pytest.fixture()
def world(client, app):
    """Two schools, each with an admin, a teacher, a class with a pupil logged in, and a laser. 'main' (the default) also exists."""
    db = app.state.db
    root = auth(issue_token(db, "platform", "root"))
    out = {"root": root}
    for sid in ("alpha", "beta"):
        r = client.post(f"{API}/schools", json={"id": sid, "name": sid.title(), "adminId": f"admin-{sid}"}, headers=root)
        assert r.status_code == 201, r.text
        admin = auth(r.json()["admin"]["token"])
        teacher = auth(client.post(f"{API}/staff", json={"role": "teacher", "id": f"t-{sid}"}, headers=admin).json()["token"])
        station = client.post(f"{API}/staff", json={"role": "station", "id": f"{sid}-laser"}, headers=admin).json()["token"]
        m = copy.deepcopy(client.get(f"{API}/machines/station-1", headers=auth(issue_token(db, "teacher", "tmp"))).json())
        m["id"] = f"{sid}-laser"
        assert client.put(f"{API}/machines/{m['id']}", json=m, headers=admin).status_code == 200
        code = sid.upper()
        assert client.post(f"{API}/classes", json={"code": code}, headers=teacher).status_code == 201
        pin = client.post(f"{API}/classes/{code}/pupils", json={"pupilIds": [f"{sid}-p1"]}, headers=teacher).json()["created"][0]["pin"]
        pupil = auth(client.post(f"{API}/auth/login", json={"classCode": code, "pupilId": f"{sid}-p1", "pin": pin}).json()["token"])
        out[sid] = {"admin": admin, "teacher": teacher, "pupil": pupil, "station_token": station, "code": code}
    return out


class TestPlatform:
    def test_only_the_platform_makes_schools_and_it_sees_nothing_inside(self, client, world):
        a = world["alpha"]
        assert client.post(f"{API}/schools", json={"id": "gamma", "name": "Gamma"}, headers=a["admin"]).status_code == 403
        assert sorted(s["id"] for s in client.get(f"{API}/schools", headers=world["root"]).json()) == ["alpha", "beta", "main"]
        for path in ("/classes", "/queue", "/presets", "/machines", "/jobs", "/staff"):
            assert client.get(f"{API}{path}", headers=world["root"]).status_code == 403, path

    def test_school_ids_are_checked_and_unique(self, client, world):
        for bad in ("Alpha School", "", "-x", "a" * 40):
            assert client.post(f"{API}/schools", json={"id": bad, "name": "x"}, headers=world["root"]).status_code == 422
        assert client.post(f"{API}/schools", json={"id": "alpha", "name": "Again"}, headers=world["root"]).status_code == 409

    def test_me_names_the_school(self, client, world):
        assert client.get(f"{API}/auth/me", headers=world["alpha"]["pupil"]).json()["school"] == "alpha"
        assert client.get(f"{API}/auth/me", headers=world["root"]).json()["school"] is None


class TestStaff:
    def test_admins_manage_staff_teachers_do_not(self, client, world):
        a = world["alpha"]
        assert {s["id"] for s in client.get(f"{API}/staff", headers=a["admin"]).json()} == {"admin-alpha", "t-alpha", "alpha-laser"}
        assert client.get(f"{API}/staff", headers=a["teacher"]).status_code == 403
        assert client.post(f"{API}/staff", json={"role": "admin", "id": "x"}, headers=a["teacher"]).status_code == 403
        assert client.post(f"{API}/staff", json={"role": "platform", "id": "x"}, headers=a["admin"]).status_code == 422

    def test_revoking_staff_only_reaches_your_own_school(self, client, world):
        assert client.delete(f"{API}/staff/t-beta", headers=world["alpha"]["admin"]).status_code == 404
        assert client.get(f"{API}/classes", headers=world["beta"]["teacher"]).status_code == 200
        assert client.delete(f"{API}/staff/t-alpha", headers=world["alpha"]["admin"]).status_code == 204
        assert client.get(f"{API}/classes", headers=world["alpha"]["teacher"]).status_code == 401
        assert client.delete(f"{API}/staff/admin-alpha", headers=world["alpha"]["admin"]).status_code == 409  # not yourself


class TestClassesAreSeparate:
    def test_each_school_sees_only_its_own_classes_and_an_admin_sees_all_of_theirs(self, client, world):
        a, b = world["alpha"], world["beta"]
        client.post(f"{API}/classes", json={"code": "ALPHA2"}, headers=a["admin"])  # owned by the admin, not the teacher
        assert [c["code"] for c in client.get(f"{API}/classes", headers=a["teacher"]).json()] == ["ALPHA"]
        assert [c["code"] for c in client.get(f"{API}/classes", headers=a["admin"]).json()] == ["ALPHA", "ALPHA2"]
        assert [c["code"] for c in client.get(f"{API}/classes", headers=b["admin"]).json()] == ["BETA"]

    def test_another_schools_class_looks_like_it_does_not_exist(self, client, world):
        a, b = world["alpha"], world["beta"]
        for call in (
            lambda: client.get(f"{API}/classes/BETA/pupils", headers=a["admin"]),
            lambda: client.put(f"{API}/classes/BETA", json={"requireApproval": False}, headers=a["admin"]),
            lambda: client.post(f"{API}/classes/BETA/pupils", json={"pupilIds": ["sneaky"]}, headers=a["admin"]),
            lambda: client.delete(f"{API}/classes/BETA/pupils/beta-p1", headers=a["admin"]),
            lambda: client.get(f"{API}/classes/BETA/activities", headers=a["admin"]),
            lambda: client.post(f"{API}/classes/BETA/activities", json={"title": "x"}, headers=a["admin"]),
            lambda: client.get(f"{API}/classes/BETA/progress", headers=a["admin"]),
            lambda: client.post(f"{API}/pupils/beta-p1/reset-pin", headers=a["admin"]),
        ):
            assert call().status_code == 404
        assert client.get(f"{API}/classes/BETA/pupils", headers=b["admin"]).status_code == 200

    def test_a_class_code_is_taken_across_schools(self, client, world):
        assert client.post(f"{API}/classes", json={"code": "BETA"}, headers=world["alpha"]["admin"]).status_code == 409

    def test_a_pupil_session_belongs_to_the_class_school(self, client, world):
        assert client.get(f"{API}/auth/me", headers=world["beta"]["pupil"]).json()["school"] == "beta"


class TestFilesAndQueueAreSeparate:
    def submit(self, client, w):
        pid = client.get(f"{API}/auth/me", headers=w["pupil"]).json()["id"]
        jid = client.post(f"{API}/jobs", json=job_doc(pupil=pid), headers=w["pupil"]).json()["id"]
        r = client.post(f"{API}/jobs/{jid}/submit", headers=w["pupil"])
        assert r.status_code == 200, r.text
        return jid

    def test_jobs_and_the_queue_do_not_cross_schools(self, client, world):
        a, b = world["alpha"], world["beta"]
        ja = self.submit(client, a)
        jb = self.submit(client, b)
        assert [j["id"] for j in client.get(f"{API}/jobs", headers=a["admin"]).json()] == [ja]
        assert [j["id"] for j in client.get(f"{API}/jobs", headers=b["teacher"]).json()] == [jb]
        for who in (a["teacher"], a["admin"]):
            assert client.get(f"{API}/jobs/{jb}", headers=who).status_code == 404
            assert client.post(f"{API}/jobs/{jb}/approve", headers=who).status_code == 404
            assert client.post(f"{API}/jobs/{jb}/reject", json={"reason": "no"}, headers=who).status_code == 404
            assert client.post(f"{API}/queue/{jb}/move", json={"to": "front"}, headers=who).status_code == 404
            assert client.get(f"{API}/jobs/{jb}/gcode", headers=who).status_code == 404

    def test_each_school_has_its_own_queue_and_tickets_are_only_that_schools(self, client, world):
        a, b = world["alpha"], world["beta"]
        ja, jb = self.submit(client, a), self.submit(client, b)
        client.post(f"{API}/jobs/{ja}/approve", headers=a["teacher"])
        assert client.get(f"{API}/queue", headers=b["teacher"]).json() == []
        client.post(f"{API}/jobs/{jb}/approve", headers=b["teacher"])
        qa, qb = (client.get(f"{API}/queue", headers=w["teacher"]).json() for w in (a, b))
        assert [e["jobId"] for e in qa] == [ja] and [e["jobId"] for e in qb] == [jb]
        assert qa[0]["position"] == qb[0]["position"] == 1  # beta's job is not behind alpha's

    def test_a_job_cannot_be_pinned_to_another_schools_laser(self, client, world):
        a = world["alpha"]
        j = self.submit(client, a)
        r = client.post(f"{API}/jobs/{j}/approve", json={"station": "beta-laser"}, headers=a["teacher"])
        assert r.status_code == 422 and r.json()["code"] == "unknown_station"

    def test_class_approval_setting_is_per_class_inside_each_school(self, client, world):
        a = world["alpha"]
        assert client.put(f"{API}/classes/ALPHA", json={"requireApproval": False}, headers=a["admin"]).status_code == 200
        j = self.submit(client, a)
        assert client.get(f"{API}/jobs/{j}", headers=a["pupil"]).json()["status"] == "approved"
        assert client.get(f"{API}/jobs/{self.submit(client, world['beta'])}", headers=world["beta"]["pupil"]).json()["status"] == "submitted"


class TestLasersAndMaterialsAreSeparate:
    def test_lasers(self, client, world):
        a, b = world["alpha"], world["beta"]
        assert [m["id"] for m in client.get(f"{API}/machines", headers=a["pupil"]).json()] == ["alpha-laser"]
        assert [m["id"] for m in client.get(f"{API}/stations", headers=b["teacher"]).json()] == ["beta-laser"]
        assert client.get(f"{API}/machines/beta-laser", headers=a["teacher"]).status_code == 404
        assert client.get(f"{API}/stations/beta-laser", headers=a["teacher"]).status_code == 404
        m = client.get(f"{API}/machines/beta-laser", headers=b["teacher"]).json()
        assert client.put(f"{API}/machines/beta-laser", json=m, headers=a["admin"]).status_code == 409  # the ID is taken
        for path in ("camera", "logs"):
            assert client.get(f"{API}/stations/beta-laser/{path}", headers=a["admin"]).status_code == 404
        assert client.post(f"{API}/stations/beta-laser/control", json={"command": "stop"}, headers=a["admin"]).status_code == 404
        assert client.post(f"{API}/stations/beta-laser/diagnostics", headers=a["admin"]).status_code == 404

    def test_a_station_token_cannot_take_over_another_schools_laser(self, client, world):
        a, b = world["alpha"], world["beta"]
        # alpha's admin makes a station token that is named like beta's laser
        tok = client.post(f"{API}/staff", json={"role": "station", "id": "beta-laser"}, headers=a["admin"]).json()["token"]
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(f"{API}/ws/cutter?token={tok}"):
                pass
        with client.websocket_connect(f"{API}/ws/cutter?token={b['station_token']}") as ws:  # beta's own token is fine
            ws.send_json({"type": "hello", "station": "beta-laser", "cutterVersion": "t", "grblSettings": {}})

    def test_materials_are_each_schools_own(self, client, world):
        a, b = world["alpha"], world["beta"]
        mats = client.get(f"{API}/presets", headers=a["pupil"]).json()
        assert mats  # a new school starts with the placeholder list
        doc = copy.deepcopy(mats[0])
        doc.update(id="alpha-only", version=1, material="Alpha special")
        assert client.post(f"{API}/presets", json=doc, headers=a["teacher"]).status_code == 201
        assert "alpha-only" in {p["id"] for p in client.get(f"{API}/presets", headers=a["pupil"]).json()}
        assert "alpha-only" not in {p["id"] for p in client.get(f"{API}/presets", headers=b["pupil"]).json()}
        assert client.get(f"{API}/presets/alpha-only", headers=b["pupil"]).status_code == 404
        # the same ID can exist in both schools, and editing one leaves the other alone
        assert client.post(f"{API}/presets", json=doc, headers=b["teacher"]).status_code == 201
        edited = {**doc, "material": "Changed"}
        assert client.put(f"{API}/presets/alpha-only", json=edited, headers=a["teacher"]).json()["version"] == 2
        assert client.get(f"{API}/presets/alpha-only", headers=b["pupil"]).json()["version"] == 1


def test_a_database_made_before_schools_moves_into_the_default_school(tmp_path):
    """Presets used to be keyed by (id, version); classes, jobs and tokens had no school. All of it lands in 'main'."""
    import json
    import sqlite3

    from fastapi.testclient import TestClient

    from kerf_server.app import create_app
    from kerf_server.config import Settings

    data = tmp_path / "data"
    data.mkdir()
    con = sqlite3.connect(data / "kerf.db")
    con.executescript("""
        CREATE TABLE presets (id VARCHAR(64) NOT NULL, version INTEGER NOT NULL, data JSON NOT NULL, updated_at DATETIME NOT NULL, updated_by VARCHAR(64), PRIMARY KEY (id, version));
        CREATE TABLE classes (code VARCHAR(32) PRIMARY KEY, label VARCHAR(128), teacher_id VARCHAR(64), created_at DATETIME NOT NULL);
        INSERT INTO classes VALUES ('OLD', 'old class', NULL, '2026-01-01 00:00:00');
    """)
    con.execute("INSERT INTO presets VALUES ('ply-old', 1, ?, '2026-01-01 00:00:00', 'me')", (json.dumps({"id": "ply-old", "version": 1}),))
    con.commit()
    con.close()
    settings = Settings.from_env(data_dir=data)
    app = create_app(settings)
    with TestClient(app) as c:
        t = {"Authorization": "Bearer " + issue_token(app.state.db, "teacher", "T1")}
        assert [x["code"] for x in c.get(f"{API}/classes", headers=t).json()] == ["OLD"]
        assert "ply-old" in {p["id"] for p in c.get(f"{API}/presets", headers=t).json()}


class TestCameraIsPerSchool:
    def test_calibration_and_placement_do_not_cross_schools(self, client, world):
        from .test_camera import calibration

        a, b = world["alpha"], world["beta"]
        assert client.put(f"{API}/stations/beta-laser/camera-calibration", json=calibration(), headers=a["admin"]).status_code == 404
        assert client.get(f"{API}/stations/beta-laser/camera-calibration", headers=a["teacher"]).status_code == 404
        assert client.put(f"{API}/stations/beta-laser/camera-calibration", json=calibration(), headers=b["teacher"]).status_code == 200
        assert client.get(f"{API}/stations/beta-laser/camera-calibration", headers=a["admin"]).status_code == 404
        assert client.delete(f"{API}/stations/beta-laser/camera-calibration", headers=a["admin"]).status_code == 404
        assert client.post(f"{API}/stations/beta-laser/calibration-marks", json={"centerX": 200, "centerY": 200, "presetId": "ply-3mm"}, headers=a["admin"]).status_code == 404
        jid = TestFilesAndQueueAreSeparate().submit(client, b)
        client.post(f"{API}/jobs/{jid}/approve", headers=b["teacher"])
        r = client.post(f"{API}/jobs/{jid}/placement", json={"station": "beta-laser", "matrix": [1, 0, 0, 1, 1, 1]}, headers=a["admin"])
        assert r.status_code == 404


class TestCutterDownload:
    def package(self, client, who, station="alpha-laser"):
        return client.post(f"{API}/cutter/package", json={"station": station}, headers=who)

    def test_an_admin_gets_a_link_and_a_working_token_for_their_own_laser(self, client, world):
        import io
        import zipfile

        a = world["alpha"]
        r = self.package(client, a["admin"])
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["token"].startswith("ks_") and body["kind"] == "practice" and body["downloadPath"].endswith("/kerf-cutter-practice.zip") and body["fileName"] == "kerf-cutter-practice.zip"
        z = client.get(body["downloadPath"])  # no Authorization header: the link is the permission
        assert z.status_code == 200 and z.headers["content-type"] == "application/zip"
        names = zipfile.ZipFile(io.BytesIO(z.content)).namelist()
        assert {"kerf-cutter/fake_cutter.py", "kerf-cutter/README.txt", "kerf-cutter/run_cutter.bat", "kerf-cutter/run_cutter.sh", "kerf-cutter/fake_bed.jpg"} <= set(names)
        assert body["token"].encode() not in z.content  # the download holds no secret
        with client.websocket_connect(f"{API}/ws/cutter?token={body['token']}") as ws:  # the token connects as that laser
            ws.send_json({"type": "hello", "station": "alpha-laser", "cutterVersion": "t", "grblSettings": {}})

    def test_the_real_cutter_is_refused_until_it_is_built(self, client, world):
        a = world["alpha"]
        assert client.get(f"{API}/cutter/kinds", headers=a["admin"]).json()["creality-falcon"]["available"] is False
        assert client.get(f"{API}/cutter/kinds", headers=a["teacher"]).status_code == 403
        r = client.post(f"{API}/cutter/package", json={"station": "alpha-laser", "kind": "creality-falcon"}, headers=a["admin"])
        assert r.status_code == 409 and r.json()["code"] == "cutter_not_built"
        assert client.post(f"{API}/cutter/package", json={"station": "alpha-laser", "kind": "bogus"}, headers=a["admin"]).status_code == 422

    def test_only_admins_and_only_their_own_lasers(self, client, world):
        a = world["alpha"]
        assert self.package(client, a["teacher"]).status_code == 403
        assert self.package(client, a["admin"], station="beta-laser").status_code == 404
        assert self.package(client, world["root"]).status_code == 403
        assert client.post(f"{API}/cutter/package", json={}, headers=a["admin"]).status_code == 422

    def test_links_expire_and_cannot_be_guessed(self, client, world, app):
        body = self.package(client, world["alpha"]["admin"]).json()
        assert client.get(f"{API}/downloads/cutter/nope/kerf-cutter-practice.zip").status_code == 404
        assert client.get(body["downloadPath"].replace("practice.zip", "other.zip")).status_code == 404
        link = body["downloadPath"].split("/")[-2]
        app.state.download_links[link] = 0  # an hour later
        assert client.get(body["downloadPath"]).status_code == 404


def test_a_placeholder_machine_in_an_older_database_gets_the_real_profile(tmp_path):
    """Databases made when the profiles were placeholders pick up the measured beds; a profile a teacher edited, and its calibration, stay."""
    from kerf_server.app import create_app
    from kerf_server.config import Settings
    from kerf_server.models import MachineRow
    from fastapi.testclient import TestClient

    settings = Settings.from_env(data_dir=tmp_path / "d")
    app = create_app(settings)
    with TestClient(app):
        db = app.state.db
        with db.session() as s:
            s.get(MachineRow, "station-1").data = {**s.get(MachineRow, "station-1").data, "placeholder": True, "bed": {"widthMm": 400, "heightMm": 400, "originCorner": "front-left"}}
            edited = s.get(MachineRow, "station-2")
            edited.data = {**edited.data, "bed": {"widthMm": 410, "heightMm": 420, "originCorner": "front-left"}}  # a teacher's edit (placeholder is false)
            edited.camera_calibration = {"kept": True}
    app2 = create_app(settings)
    with TestClient(app2):
        with app2.state.db.session() as s:
            assert s.get(MachineRow, "station-1").data["bed"]["heightMm"] == 415
            assert s.get(MachineRow, "station-2").data["bed"]["heightMm"] == 420 and s.get(MachineRow, "station-2").camera_calibration == {"kept": True}

    def test_when_the_real_cutter_has_been_built_that_is_what_is_offered(self, tmp_path):
        import io
        import zipfile

        from fastapi.testclient import TestClient

        from kerf_server.app import create_app
        from kerf_server.config import Settings

        built = tmp_path / "kerf-cutter.zip"
        with zipfile.ZipFile(built, "w") as z:
            z.writestr("kerf-cutter/run_cutter.bat", "@echo off")
        app = create_app(Settings.from_env(data_dir=tmp_path / "d", cutter_zip=built))
        with TestClient(app) as c:
            admin = {"Authorization": "Bearer " + issue_token(app.state.db, "admin", "A1")}
            assert c.get(f"{API}/cutter/kinds", headers=admin).json() == {"practice": {"available": True, "fileName": "kerf-cutter-practice.zip"}, "creality-falcon": {"available": True, "fileName": "kerf-cutter-creality-falcon.zip"}}
            r = c.post(f"{API}/cutter/package", json={"station": "station-1", "kind": "creality-falcon"}, headers=admin).json()
            assert r["kind"] == "creality-falcon" and r["fileName"] == "kerf-cutter-creality-falcon.zip"
            z = c.get(r["downloadPath"])
            assert z.status_code == 200 and "kerf-cutter/run_cutter.bat" in zipfile.ZipFile(io.BytesIO(z.content)).namelist()
            p = c.post(f"{API}/cutter/package", json={"station": "station-1", "kind": "practice"}, headers=admin).json()  # both kinds stay on offer
            assert p["kind"] == "practice" and c.get(p["downloadPath"]).status_code == 200


class TestRemovingAStation:
    def test_an_admin_removes_their_own_laser_and_its_tokens_stop_working(self, client, world):
        a, b = world["alpha"], world["beta"]
        assert client.delete(f"{API}/machines/alpha-laser", headers=a["teacher"]).status_code == 403
        assert client.delete(f"{API}/machines/beta-laser", headers=a["admin"]).status_code == 404  # another school's laser looks absent
        assert client.delete(f"{API}/machines/nothing-here", headers=a["admin"]).status_code == 404
        assert client.delete(f"{API}/machines/alpha-laser", headers=a["admin"]).status_code == 204
        assert client.get(f"{API}/machines/alpha-laser", headers=a["admin"]).status_code == 404
        assert [m["id"] for m in client.get(f"{API}/machines", headers=a["pupil"]).json()] == []
        assert client.get(f"{API}/machines/beta-laser", headers=b["teacher"]).status_code == 200
        with pytest.raises(WebSocketDisconnect):  # its station token is revoked
            with client.websocket_connect(f"{API}/ws/cutter?token={a['station_token']}"):
                pass
        assert client.put(f"{API}/machines/alpha-laser", json=client.get(f"{API}/machines/beta-laser", headers=b["teacher"]).json() | {"id": "alpha-laser"}, headers=a["admin"]).status_code == 200  # the ID can be reused

    def test_not_while_the_cutter_is_connected(self, client, world):
        a = world["alpha"]
        with client.websocket_connect(f"{API}/ws/cutter?token={a['station_token']}") as ws:
            ws.send_json({"type": "hello", "station": "alpha-laser", "cutterVersion": "t", "grblSettings": {}})
            ws.send_json({"type": "status", "station": "alpha-laser", "state": "Idle", "mpos": [0, 0, 0]})
            r = client.delete(f"{API}/machines/alpha-laser", headers=a["admin"])
            assert r.status_code == 409 and r.json()["code"] == "station_online"
