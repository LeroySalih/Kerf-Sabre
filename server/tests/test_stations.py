from __future__ import annotations

import time

import pytest

from .conftest import auth
from .fakecutter import FakeCutter
from .test_jobs import job_doc, post

API = "/api/v1"


def approved_job(client, tokens, **kw):
    jid = post(client, tokens, status="submitted", **kw).json()["id"]
    assert client.post(f"{API}/jobs/{jid}/approve", headers=auth(tokens["teacher"])).status_code == 200
    return jid


def wait_for(fn, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(0.02)
    raise AssertionError("timed out")


def st(client, tokens, station="station-1"):
    return client.get(f"{API}/stations/{station}", headers=auth(tokens["pupil"])).json()


class TestConnection:
    def test_offline_by_default_and_online_with_a_token(self, client, tokens):
        assert [s["online"] for s in client.get(f"{API}/stations", headers=auth(tokens["pupil"])).json()] == [False] * 4
        with FakeCutter(client, tokens["station"]):
            s = wait_for(lambda: st(client, tokens) if st(client, tokens)["online"] else None)
            assert s["s30"] == 1000 and s["laserMode"] is True and s["state"] == "Idle" and s["cutterVersion"] == "test"
        wait_for(lambda: not st(client, tokens)["online"])

    def test_pupil_token_cannot_open_the_socket(self, client, tokens):
        from starlette.websockets import WebSocketDisconnect

        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(f"{API}/ws/cutter", headers=auth(tokens["pupil"])):
                pass


class TestRun:
    def test_end_to_end_frame_assign_cut(self, client, tokens):
        jid = approved_job(client, tokens)
        sh = auth(tokens["station"])
        with FakeCutter(client, tokens["station"]) as cutter:
            wait_for(lambda: st(client, tokens)["online"])
            f = client.post(f"{API}/jobs/{jid}/frame", json={"station": "station-1"}, headers=sh)
            assert f.status_code == 202 and f.json()["bounds"]["minX"] == pytest.approx(20, abs=0.2)
            msg = cutter.wait_for("frame")
            assert msg["jobId"] == jid and msg["bounds"] == f.json()["bounds"]
            a = client.post(f"{API}/jobs/{jid}/assign", json={"station": "station-1", "materialConfirmed": True}, headers=sh)
            assert a.status_code == 200, a.text
            run = cutter.wait_for("run_job")
            assert run["gcodeUrl"].endswith(f"/jobs/{jid}/gcode?station=station-1") and run["material"] and run["totalLines"] > 5
            g = client.get(run["gcodeUrl"], headers=sh)
            assert g.status_code == 200 and g.headers["x-gcode-sha256"] == run["gcodeSha256"]
            job = wait_for(lambda: (j := client.get(f"{API}/jobs/{jid}", headers=auth(tokens["pupil"])).json())["status"] == "done" and j)
            assert job["station"] == "station-1"
        kinds = [e["kind"] for e in client.get(f"{API}/jobs/{jid}/events", headers=auth(tokens["teacher"])).json()]
        assert kinds == ["created", "submitted", "approved", "framed", "assigned", "started", "done"]
        assert st(client, tokens)["currentJobId"] is None

    def test_must_frame_first(self, client, tokens):
        jid = approved_job(client, tokens)
        with FakeCutter(client, tokens["station"]):
            wait_for(lambda: st(client, tokens)["online"])
            r = client.post(f"{API}/jobs/{jid}/assign", json={"station": "station-1", "materialConfirmed": True}, headers=auth(tokens["station"]))
            assert r.status_code == 409 and r.json()["code"] == "not_framed"

    def test_must_confirm_material(self, client, tokens):
        jid = approved_job(client, tokens)
        r = client.post(f"{API}/jobs/{jid}/assign", json={"station": "station-1", "materialConfirmed": False}, headers=auth(tokens["station"]))
        assert r.status_code == 422 and r.json()["code"] == "material_not_confirmed"

    def test_offline_station(self, client, tokens):
        jid = approved_job(client, tokens)
        r = client.post(f"{API}/jobs/{jid}/frame", json={"station": "station-1"}, headers=auth(tokens["station"]))
        assert r.status_code == 409 and r.json()["code"] == "station_offline"

    def test_unapproved_job_cannot_run(self, client, tokens):
        jid = post(client, tokens, status="submitted").json()["id"]
        with FakeCutter(client, tokens["station"]):
            wait_for(lambda: st(client, tokens)["online"])
            r = client.post(f"{API}/jobs/{jid}/frame", json={"station": "station-1"}, headers=auth(tokens["station"]))
            assert r.status_code == 409 and r.json()["code"] == "not_approved"

    def test_pinned_to_another_station(self, client, tokens):
        jid = post(client, tokens, status="submitted").json()["id"]
        client.post(f"{API}/jobs/{jid}/approve", json={"station": "station-2"}, headers=auth(tokens["teacher"]))
        with FakeCutter(client, tokens["station"]):
            wait_for(lambda: st(client, tokens)["online"])
            r = client.post(f"{API}/jobs/{jid}/frame", json={"station": "station-1"}, headers=auth(tokens["station"]))
            assert r.status_code == 409 and r.json()["code"] == "wrong_station"

    def test_pupil_cannot_start_a_cut(self, client, tokens):
        jid = approved_job(client, tokens)
        for path in ("frame", "assign"):
            assert client.post(f"{API}/jobs/{jid}/{path}", json={"station": "station-1", "materialConfirmed": True}, headers=auth(tokens["pupil"])).status_code == 403

    def test_untested_material_blocked_unless_teacher_overrides(self, client, tokens):
        jid = approved_job(client, tokens, preset={"id": "mdf-3mm", "version": 1})
        sh = auth(tokens["station"])
        with FakeCutter(client, tokens["station"]):
            wait_for(lambda: st(client, tokens)["online"])
            assert client.post(f"{API}/jobs/{jid}/frame", json={"station": "station-1"}, headers=sh).status_code == 202
            body = {"station": "station-1", "materialConfirmed": True}
            r = client.post(f"{API}/jobs/{jid}/assign", json=body, headers=sh)
            assert r.status_code == 422 and r.json()["code"] == "untested_material"
            assert client.post(f"{API}/jobs/{jid}/assign", json={**body, "allowUntested": True}, headers=sh).status_code == 422  # station may not override
            t = client.post(f"{API}/jobs/{jid}/assign", json={**body, "allowUntested": True}, headers=auth(tokens["teacher"]))
            assert t.status_code == 200, t.text

    def test_refusal_returns_the_job_to_the_queue(self, client, tokens):
        jid = approved_job(client, tokens)
        sh = auth(tokens["station"])
        with FakeCutter(client, tokens["station"], accept=False):
            wait_for(lambda: st(client, tokens)["online"])
            client.post(f"{API}/jobs/{jid}/frame", json={"station": "station-1"}, headers=sh)
            r = client.post(f"{API}/jobs/{jid}/assign", json={"station": "station-1", "materialConfirmed": True}, headers=sh)
            assert r.status_code == 409 and r.json()["code"] == "refused" and "nope" in r.json()["message"]
        assert client.get(f"{API}/jobs/{jid}", headers=auth(tokens["pupil"])).json()["status"] == "approved"
        assert st(client, tokens)["currentJobId"] is None

    def test_no_answer_times_out(self, client, tokens, app):
        jid = approved_job(client, tokens)
        sh = auth(tokens["station"])
        app.state.settings = type(app.state.settings).from_env(data_dir=app.state.settings.data_dir, ack_timeout_s=0.3)
        with FakeCutter(client, tokens["station"], answer=False):
            wait_for(lambda: st(client, tokens)["online"])
            client.post(f"{API}/jobs/{jid}/frame", json={"station": "station-1"}, headers=sh)
            r = client.post(f"{API}/jobs/{jid}/assign", json={"station": "station-1", "materialConfirmed": True}, headers=sh)
            assert r.status_code == 409 and r.json()["code"] == "not_started"
        assert client.get(f"{API}/jobs/{jid}", headers=auth(tokens["pupil"])).json()["status"] == "approved"

    def test_busy_station_refuses_a_second_job(self, client, tokens):
        j1, j2 = approved_job(client, tokens), approved_job(client, tokens)
        sh = auth(tokens["station"])
        with FakeCutter(client, tokens["station"], auto_finish=None):
            wait_for(lambda: st(client, tokens)["online"])
            for j in (j1, j2):
                client.post(f"{API}/jobs/{j}/frame", json={"station": "station-1"}, headers=sh)
            body = {"station": "station-1", "materialConfirmed": True}
            assert client.post(f"{API}/jobs/{j1}/assign", json=body, headers=sh).status_code == 200
            r = client.post(f"{API}/jobs/{j2}/assign", json=body, headers=sh)
            assert r.status_code == 409 and r.json()["code"] == "station_busy"

    def test_wrong_s30_or_laser_mode_stops_the_job(self, client, tokens):
        jid = approved_job(client, tokens)
        sh = auth(tokens["station"])
        with FakeCutter(client, tokens["station"], s30="255"):
            wait_for(lambda: st(client, tokens)["online"])
            r = client.post(f"{API}/jobs/{jid}/frame", json={"station": "station-1"}, headers=sh)
            assert r.status_code == 409 and r.json()["code"] == "s30_mismatch"
        with FakeCutter(client, tokens["station"], laser_mode="0"):
            wait_for(lambda: st(client, tokens)["laserMode"] is False)
            r = client.post(f"{API}/jobs/{jid}/frame", json={"station": "station-1"}, headers=sh)
            assert r.status_code == 409 and r.json()["code"] == "laser_mode_off"

    def test_current_position_follows_the_head_and_must_not_move_after_framing(self, client, tokens):
        jid = approved_job(client, tokens, origin={"mode": "current-position", "anchor": "bottom-left"})
        sh = auth(tokens["station"])
        with FakeCutter(client, tokens["station"]) as c:
            c.status(mpos=(100.0, 80.0, 0.0))
            wait_for(lambda: st(client, tokens)["mpos"] == [100.0, 80.0, 0.0])
            f = client.post(f"{API}/jobs/{jid}/frame", json={"station": "station-1"}, headers=sh).json()["bounds"]
            assert f["minX"] == pytest.approx(99.95, abs=0.1) and f["minY"] == pytest.approx(79.95, abs=0.1)
            c.status(mpos=(150.0, 80.0, 0.0))
            wait_for(lambda: st(client, tokens)["mpos"][0] == 150.0)
            r = client.post(f"{API}/jobs/{jid}/assign", json={"station": "station-1", "materialConfirmed": True}, headers=sh)
            assert r.status_code == 409 and r.json()["code"] == "moved_since_frame"
            assert client.post(f"{API}/jobs/{jid}/frame", json={"station": "station-1"}, headers=sh).status_code == 202
            assert client.post(f"{API}/jobs/{jid}/assign", json={"station": "station-1", "materialConfirmed": True}, headers=sh).status_code == 200
            g = client.get(f"{API}/jobs/{jid}/gcode?station=station-1", headers=sh).text
            assert "X149.9 " in g or "X149.9\n" in g

    def test_failed_cut_is_recorded(self, client, tokens):
        jid = approved_job(client, tokens)
        sh = auth(tokens["station"])
        with FakeCutter(client, tokens["station"], auto_finish="failed"):
            wait_for(lambda: st(client, tokens)["online"])
            client.post(f"{API}/jobs/{jid}/frame", json={"station": "station-1"}, headers=sh)
            client.post(f"{API}/jobs/{jid}/assign", json={"station": "station-1", "materialConfirmed": True}, headers=sh)
            wait_for(lambda: client.get(f"{API}/jobs/{jid}", headers=auth(tokens["pupil"])).json()["status"] == "failed")


class TestControlAndMonitoring:
    def test_stop_goes_to_the_cutter(self, client, tokens):
        with FakeCutter(client, tokens["station"]) as c:
            wait_for(lambda: st(client, tokens)["online"])
            assert client.post(f"{API}/stations/station-1/control", json={"command": "stop"}, headers=auth(tokens["station"])).status_code == 202
            assert c.wait_for("stop")["type"] == "control"
            assert client.post(f"{API}/stations/station-1/control", json={"command": "explode"}, headers=auth(tokens["station"])).status_code == 422
            assert client.post(f"{API}/stations/station-1/control", json={"command": "stop"}, headers=auth(tokens["pupil"])).status_code == 403

    def test_logs_are_kept_and_filtered_and_teachers_only(self, client, tokens):
        with FakeCutter(client, tokens["station"]) as c:
            wait_for(lambda: st(client, tokens)["online"])
            c.send({"type": "logs", "station": "station-1", "lines": [
                {"timestamp": "2026-10-13T10:00:00Z", "level": "DEBUG", "station": "station-1", "job_id": None, "event": "serial tx $G"},
                {"timestamp": "2026-10-13T10:00:01Z", "level": "ERROR", "station": "station-1", "job_id": "job-1", "event": "alarm 1"}]})
            t = auth(tokens["teacher"])
            rows = wait_for(lambda: [r for r in client.get(f"{API}/stations/station-1/logs", headers=t).json() if r.get("event") == "alarm 1"])
            assert rows
            only = client.get(f"{API}/stations/station-1/logs?level=ERROR", headers=t).json()
            assert all(r["level"] == "ERROR" for r in only) and any(r["event"] == "alarm 1" for r in only)
            assert client.get(f"{API}/stations/station-1/logs", headers=auth(tokens["pupil"])).status_code == 403

    def test_remote_log_level_and_diagnostics(self, client, tokens):
        t = auth(tokens["teacher"])
        with FakeCutter(client, tokens["station"]) as c:
            wait_for(lambda: st(client, tokens)["online"])
            assert client.put(f"{API}/stations/station-1/log-level", json={"level": "DEBUG"}, headers=t).status_code == 204
            assert c.wait_for("set_log_level")["level"] == "DEBUG"
            assert client.put(f"{API}/stations/station-1/log-level", json={"level": "LOUD"}, headers=t).status_code == 422
            assert client.post(f"{API}/stations/station-1/diagnostics", headers=t).status_code == 202
            c.wait_for("diagnostic_bundle")
        sh = auth(tokens["station"])
        ok = client.post(f"{API}/stations/station-1/diagnostics/upload", files={"file": ("../../evil.zip", b"PK\x03\x04data")}, headers=sh)
        assert ok.status_code == 201 and ".." not in ok.json()["stored"]
        assert client.post(f"{API}/stations/station-1/diagnostics/upload", files={"file": ("x.zip", b"nope")}, headers=sh).status_code == 422
        assert client.post(f"{API}/stations/station-2/diagnostics/upload", files={"file": ("x.zip", b"PK..")}, headers=sh).status_code == 403

    def test_camera_frame_is_served_from_memory(self, client, tokens):
        import base64

        assert client.get(f"{API}/stations/station-1/camera", headers=auth(tokens["teacher"])).status_code == 404
        with FakeCutter(client, tokens["station"]) as c:
            wait_for(lambda: st(client, tokens)["online"])
            c.send({"type": "camera", "station": "station-1", "jpegBase64": base64.b64encode(b"\xff\xd8jpegdata").decode()})
            r = wait_for(lambda: (x := client.get(f"{API}/stations/station-1/camera", headers=auth(tokens["teacher"]))).status_code == 200 and x)
            assert r.headers["content-type"] == "image/jpeg" and r.content == b"\xff\xd8jpegdata"
            assert st(client, tokens)["cameraAvailable"] is True

    def test_watchdog_fails_a_job_the_cutter_forgot(self, client, tokens, monkeypatch):
        from kerf_server import services_run

        monkeypatch.setattr(services_run, "IDLE_GRACE_S", 0)
        jid = approved_job(client, tokens)
        sh = auth(tokens["station"])
        with FakeCutter(client, tokens["station"], auto_finish=None) as c:
            wait_for(lambda: st(client, tokens)["online"])
            client.post(f"{API}/jobs/{jid}/frame", json={"station": "station-1"}, headers=sh)
            assert client.post(f"{API}/jobs/{jid}/assign", json={"station": "station-1", "materialConfirmed": True}, headers=sh).status_code == 200
            time.sleep(0.05)
            c.status("Idle")
            job = wait_for(lambda: (j := client.get(f"{API}/jobs/{jid}", headers=auth(tokens["pupil"])).json())["status"] == "failed" and j)
            assert "without reporting" in job["statusReason"]


class TestProgress:
    def test_progress_is_shown_while_cutting_and_cleared_after(self, client, tokens):
        jid = approved_job(client, tokens)
        sh = auth(tokens["station"])
        with FakeCutter(client, tokens["station"], auto_finish=None) as c:
            wait_for(lambda: st(client, tokens)["online"])
            assert st(client, tokens)["progress"] is None
            client.post(f"{API}/jobs/{jid}/frame", json={"station": "station-1"}, headers=sh)
            client.post(f"{API}/jobs/{jid}/assign", json={"station": "station-1", "materialConfirmed": True}, headers=sh)
            c.send({"type": "progress", "station": "station-1", "jobId": jid, "line": 40, "totalLines": 100, "estimatedS": 60.0, "actualS": 24.0})
            p = wait_for(lambda: st(client, tokens)["progress"])
            assert p == {"jobId": jid, "line": 40, "totalLines": 100, "estimatedS": 60.0, "actualS": 24.0}
            c.send({"type": "result", "station": "station-1", "jobId": jid, "outcome": "done"})
            wait_for(lambda: st(client, tokens)["progress"] is None)


class TestFrameSaysWhereTheHeadIs:
    def test_a_design_that_runs_off_the_bed_names_the_head_position(self, client, tokens):
        jid = approved_job(client, tokens, origin={"mode": "current-position", "anchor": "bottom-left"})
        with FakeCutter(client, tokens["station"]) as c:
            c.status(mpos=(390.0, 405.0, 0.0))
            wait_for(lambda: st(client, tokens)["mpos"] == [390.0, 405.0, 0.0])
            r = client.post(f"{API}/jobs/{jid}/frame", json={"station": "station-1"}, headers=auth(tokens["station"]))
            assert r.status_code == 422 and "head is at X 390, Y 405" in r.json()["message"]


class TestHeadParkedOnTheOrigin:
    def test_a_head_a_hair_below_zero_still_frames(self, client, tokens):
        jid = approved_job(client, tokens, origin={"mode": "current-position", "anchor": "bottom-left"})
        with FakeCutter(client, tokens["station"]) as c:
            c.status(mpos=(-0.04, -0.03, 0.0))
            wait_for(lambda: st(client, tokens)["mpos"] == [-0.04, -0.03, 0.0])
            r = client.post(f"{API}/jobs/{jid}/frame", json={"station": "station-1"}, headers=auth(tokens["station"]))
            assert r.status_code == 202, r.text
            assert r.json()["bounds"]["minX"] >= -0.2


class TestATokenIsForOneLaser:
    def test_a_cutter_that_names_another_laser_is_closed(self, client, tokens):
        import pytest
        from starlette.websockets import WebSocketDisconnect
        with client.websocket_connect(f"{API}/ws/cutter", headers=auth(tokens["station"])) as ws:
            ws.send_json({"type": "hello", "station": "station-2", "cutterVersion": "x"})
            with pytest.raises(WebSocketDisconnect) as e:
                ws.receive_json()
            assert e.value.code == 4403


class TestDisconnect:
    def test_a_technician_disconnects_an_idle_cutter(self, client, tokens):
        h = auth(tokens["teacher"])
        with FakeCutter(client, tokens["station"]) as c:
            c.status()
            wait_for(lambda: st(client, tokens)["online"] or None)
            assert client.post(f"{API}/stations/station-1/disconnect", headers=h).status_code == 204
            wait_for(lambda: None if st(client, tokens)["online"] else True)
        assert client.post(f"{API}/stations/station-1/disconnect", headers=h).status_code == 409

    def test_a_pupil_or_a_station_token_cannot(self, client, tokens):
        assert client.post(f"{API}/stations/station-1/disconnect", headers=auth(tokens["pupil"])).status_code == 403
        assert client.post(f"{API}/stations/station-1/disconnect", headers=auth(tokens["station"])).status_code == 403


class TestTakeOver:
    def pinned(self, client, tokens):
        jid = post(client, tokens, status="submitted").json()["id"]
        assert client.post(f"{API}/jobs/{jid}/approve", json={"station": "station-2"}, headers=auth(tokens["teacher"])).status_code == 200
        return jid

    def test_a_laser_cannot_start_a_file_meant_for_another_until_it_is_taken_over(self, client, tokens):
        jid = self.pinned(client, tokens)
        sh = auth(tokens["station"])
        with FakeCutter(client, tokens["station"]) as c:
            c.status()
            wait_for(lambda: st(client, tokens)["online"] or None)
            r = client.post(f"{API}/jobs/{jid}/frame", json={"station": "station-1", "skipQueue": True}, headers=sh)
            assert r.status_code == 409 and r.json()["code"] == "wrong_station"
            t = client.post(f"{API}/jobs/{jid}/take", json={"station": "station-1"}, headers=auth(tokens["teacher"]))
            assert t.status_code == 200 and t.json()["station"] == "station-1"
            assert client.post(f"{API}/jobs/{jid}/frame", json={"station": "station-1"}, headers=sh).status_code == 202

    def test_only_staff_may_take_over_and_only_a_waiting_file(self, client, tokens):
        jid = self.pinned(client, tokens)
        assert client.post(f"{API}/jobs/{jid}/take", json={"station": "station-1"}, headers=auth(tokens["pupil"])).status_code == 403
        assert client.post(f"{API}/jobs/{jid}/take", json={"station": "station-9"}, headers=auth(tokens["teacher"])).status_code == 404
        client.post(f"{API}/jobs/{jid}/cancel", headers=auth(tokens["pupil"]))
        assert client.post(f"{API}/jobs/{jid}/take", json={"station": "station-1"}, headers=auth(tokens["teacher"])).status_code == 409


class TestEdgeAlignedPointyDesign:
    def test_a_star_lined_up_on_the_origin_corner_is_nudged_onto_the_bed(self, client, tokens):
        import math
        pts = [[60 + (60 if i % 2 == 0 else 24) * math.cos(math.pi / 2 + i * math.pi / 5), 60 + (60 if i % 2 == 0 else 24) * math.sin(math.pi / 2 + i * math.pi / 5)] for i in range(10)]
        star = {"id": "s", "layer": "cut", "closed": True, "start": pts[0], "segments": [{"type": "line", "to": p} for p in pts[1:]] + [{"type": "line", "to": pts[0]}], "matrix": [1, 0, 0, 1, 0, 0]}
        jid = approved_job(client, tokens, objects=[star], origin={"mode": "current-position", "anchor": "bottom-left"})
        with FakeCutter(client, tokens["station"]) as c:
            c.status(mpos=(0.0, 0.0, 0.0))
            wait_for(lambda: st(client, tokens)["online"] or None)
            r = client.post(f"{API}/jobs/{jid}/frame", json={"station": "station-1"}, headers=auth(tokens["station"]))
            assert r.status_code == 202, r.text
            assert r.json()["bounds"]["minX"] >= -0.01 and r.json()["bounds"]["minY"] >= -0.01


class TestMarkTested:
    def test_marking_a_material_tested_lets_files_already_waiting_cut(self, client, tokens):
        jid = approved_job(client, tokens, preset={"id": "mdf-3mm", "version": 1})
        sh = auth(tokens["station"])
        with FakeCutter(client, tokens["station"]):
            wait_for(lambda: st(client, tokens)["online"])
            client.post(f"{API}/jobs/{jid}/frame", json={"station": "station-1"}, headers=sh)
            body = {"station": "station-1", "materialConfirmed": True}
            assert client.post(f"{API}/jobs/{jid}/assign", json=body, headers=sh).json()["code"] == "untested_material"
            m = client.post(f"{API}/presets/mdf-3mm/tested", json={"station": "station-1"}, headers=auth(tokens["teacher"]))
            assert m.status_code == 200 and "station-1" in m.json()["testedOn"]
            assert client.post(f"{API}/jobs/{jid}/assign", json=body, headers=sh).status_code == 200

    def test_only_staff_and_only_a_real_laser(self, client, tokens):
        assert client.post(f"{API}/presets/mdf-3mm/tested", json={"station": "station-1"}, headers=auth(tokens["pupil"])).status_code == 403
        assert client.post(f"{API}/presets/mdf-3mm/tested", json={"station": "station-9"}, headers=auth(tokens["teacher"])).status_code == 404
        assert client.post(f"{API}/presets/nope/tested", json={"station": "station-1"}, headers=auth(tokens["teacher"])).status_code == 404
