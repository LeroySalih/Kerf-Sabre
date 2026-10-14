"""Camera calibration (where the camera picture sits on the bed) and placing a design on the bed from it."""
from __future__ import annotations

import copy

import pytest

from .conftest import auth
from .test_stations import approved_job

API = "/api/v1"
IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1]


def calibration(**over):
    pts = [{"camera": [x, y], "bed": [x, y]} for x, y in ((0, 0), (400, 0), (400, 400), (0, 400))]
    doc = {"imageWidth": 640, "imageHeight": 480, "points": pts, "homography": IDENTITY}
    doc.update(over)
    return doc


def put(client, tokens, doc, who="teacher", station="station-1"):
    return client.put(f"{API}/stations/{station}/camera-calibration", json=doc, headers=auth(tokens[who]))


class TestCalibration:
    def test_not_calibrated_until_a_teacher_does_it(self, client, tokens):
        r = client.get(f"{API}/stations/station-1/camera-calibration", headers=auth(tokens["station"]))
        assert r.status_code == 404 and r.json()["code"] == "not_calibrated"
        r = put(client, tokens, calibration())
        assert r.status_code == 200 and r.json()["calibratedBy"] == "T001" and r.json()["calibratedAt"]
        for who in ("station", "teacher"):
            got = client.get(f"{API}/stations/station-1/camera-calibration", headers=auth(tokens[who])).json()
            assert got["homography"] == IDENTITY and len(got["points"]) == 4
        assert client.delete(f"{API}/stations/station-1/camera-calibration", headers=auth(tokens["teacher"])).status_code == 204
        assert client.get(f"{API}/stations/station-1/camera-calibration", headers=auth(tokens["station"])).status_code == 404

    def test_only_teachers_write_and_pupils_cannot_read(self, client, tokens):
        assert put(client, tokens, calibration(), who="pupil").status_code == 403
        assert put(client, tokens, calibration(), who="station").status_code == 403
        assert client.get(f"{API}/stations/station-1/camera-calibration", headers=auth(tokens["pupil"])).status_code == 403

    @pytest.mark.parametrize("mutate", [
        lambda d: d.update(points=d["points"][:3]),
        lambda d: d.update(homography=IDENTITY[:8]),
        lambda d: d.update(homography=[1, 0, 0, 0, 1, 0, 0, 0, "nan"]),
        lambda d: d.update(homography=[2, 0, 0, 0, 2, 0, 0, 0, 1]),  # does not map the points to where they are said to be
        lambda d: d.update(imageWidth="big"),
        lambda d: d["points"][0].update(camera=[9999, 0]),  # outside the picture
        lambda d: d["points"][1].update(bed=[1, 2, 3]),
    ])
    def test_bad_calibrations_are_refused(self, client, tokens, mutate):
        doc = copy.deepcopy(calibration())
        mutate(doc)
        assert put(client, tokens, doc).status_code in (422, 400)

    def test_unknown_laser(self, client, tokens):
        assert put(client, tokens, calibration(), station="nope").status_code == 404


class TestPlacement:
    def place(self, client, tokens, jid, matrix, who="station", **extra):
        return client.post(f"{API}/jobs/{jid}/placement", json={"station": "station-1", "matrix": matrix, **extra}, headers=auth(tokens[who]))

    def objects(self, client, tokens, jid):
        return client.get(f"{API}/jobs/{jid}", headers=auth(tokens["teacher"])).json()

    def test_moving_and_turning_fixes_the_design_to_the_bed(self, client, tokens):
        jid = approved_job(client, tokens)  # a 50 x 30 rectangle at (20, 20), absolute
        r = self.place(client, tokens, jid, [1, 0, 0, 1, 100, 50])
        assert r.status_code == 200, r.text
        assert r.json()["bounds"]["minX"] == pytest.approx(120, abs=0.2) and r.json()["bounds"]["minY"] == pytest.approx(70, abs=0.2)
        doc = self.objects(client, tokens, jid)
        assert doc["origin"] == {"mode": "absolute"} and doc["objects"][0]["matrix"][4:] == [100, 50]
        # a quarter turn about the origin, then on top of the earlier move
        r = self.place(client, tokens, jid, [0, 1, -1, 0, 300, 0])
        assert r.status_code == 200, r.text
        events = client.get(f"{API}/jobs/{jid}/events", headers=auth(tokens["teacher"])).json()
        assert [e["kind"] for e in events].count("placed") == 2

    def test_a_current_position_job_becomes_absolute(self, client, tokens):
        jid = approved_job(client, tokens, origin={"mode": "current-position", "anchor": "bottom-left"})
        assert self.objects(client, tokens, jid)["origin"]["mode"] == "current-position"
        assert self.place(client, tokens, jid, [1, 0, 0, 1, 10, 10]).status_code == 200
        assert self.objects(client, tokens, jid)["origin"] == {"mode": "absolute"}

    @pytest.mark.parametrize("matrix", [[2, 0, 0, 2, 0, 0], [1, 0, 0, -1, 0, 0], [1, 0, 0.5, 1, 0, 0], [1, 2, 3], "no", [1, 0, 0, 1, 1e12, 0], [True, 0, 0, 1, 0, 0]])
    def test_only_moves_and_turns_are_allowed(self, client, tokens, matrix):
        jid = approved_job(client, tokens)
        before = self.objects(client, tokens, jid)["objects"]
        assert self.place(client, tokens, jid, matrix).status_code in (422, 400)
        assert self.objects(client, tokens, jid)["objects"] == before

    def test_off_the_bed_is_refused_and_nothing_changes(self, client, tokens):
        jid = approved_job(client, tokens)
        before = self.objects(client, tokens, jid)
        r = self.place(client, tokens, jid, [1, 0, 0, 1, 5000, 0])
        assert r.status_code == 422
        assert self.objects(client, tokens, jid)["objects"] == before["objects"] and self.objects(client, tokens, jid)["origin"] == before["origin"]

    def test_only_the_next_job_and_only_staff(self, client, tokens):
        first, second = approved_job(client, tokens), approved_job(client, tokens)
        r = self.place(client, tokens, second, [1, 0, 0, 1, 1, 1])
        assert r.status_code == 409 and r.json()["code"] == "not_your_turn"
        assert self.place(client, tokens, second, [1, 0, 0, 1, 1, 1], who="teacher", skipQueue=True).status_code == 200
        assert self.place(client, tokens, first, [1, 0, 0, 1, 1, 1], who="pupil").status_code == 403

    def test_a_job_that_is_not_approved_cannot_be_placed(self, client, tokens):
        from .test_jobs import post

        jid = post(client, tokens, status="submitted").json()["id"]
        r = self.place(client, tokens, jid, [1, 0, 0, 1, 1, 1], who="teacher")
        assert r.status_code == 409 and r.json()["code"] == "not_approved"

    def test_placing_clears_an_old_frame(self, client, tokens):
        from .fakecutter import FakeCutter
        from .test_stations import st, wait_for

        jid = approved_job(client, tokens)
        sh = auth(tokens["station"])
        with FakeCutter(client, tokens["station"]):
            wait_for(lambda: st(client, tokens)["online"])
            assert client.post(f"{API}/jobs/{jid}/frame", json={"station": "station-1"}, headers=sh).status_code == 202
            assert self.place(client, tokens, jid, [1, 0, 0, 1, 30, 0]).status_code == 200
            a = client.post(f"{API}/jobs/{jid}/assign", json={"station": "station-1", "materialConfirmed": True}, headers=sh)
            assert a.status_code == 409 and a.json()["code"] == "not_framed"
