"""Free and paid schools (docs/ACCOUNTS.md): a free school has the free tools only; the paid service answers 403 paid_feature.
Schools have a short school code. Only Kerf's site admins see all schools and set plans."""
from __future__ import annotations

import pytest

from kerf_server.security import issue_token

from .conftest import auth
from .test_jobs import job_doc

API = "/api/v1"


@pytest.fixture()
def free(client, app):
    db = app.state.db
    root = auth(issue_token(db, "platform", "root"))
    r = client.post(f"{API}/schools", json={"id": "westfield-high", "name": "Westfield High"}, headers=root)
    assert r.status_code == 201 and r.json()["plan"] == "free"
    t = {r_: auth(issue_token(db, r_, f"{r_}-wf", school="westfield-high")) for r_ in ("pupil", "teacher", "admin", "station")}
    return {"root": root, "doc": r.json(), **t}


class TestSchoolCodes:
    def test_every_school_has_a_short_code_and_they_differ(self, client, tokens, free):
        main = client.get(f"{API}/school", headers=auth(tokens["teacher"])).json()
        assert len(main["code"]) == 5 and main["plan"] == "paid"  # a school from before plans counts as paid
        assert free["doc"]["code"] and free["doc"]["code"] != main["code"]
        assert not set(main["code"]) & set("0O1IL5S2Z8B")


class TestFreeSchool:
    def test_the_free_tools_work(self, client, free):
        assert client.post(f"{API}/jobs", json=job_doc(pupil="pupil-wf"), headers=free["pupil"]).status_code == 201  # save a draft
        assert client.get(f"{API}/presets", headers=free["pupil"]).status_code == 200
        assert client.get(f"{API}/jobs", headers=free["teacher"]).status_code == 200
        assert client.post(f"{API}/classes", json={"code": "WF7"}, headers=free["teacher"]).status_code == 201

    @pytest.mark.parametrize("method,path,who", [
        ("get", "/queue", "pupil"), ("get", "/stations", "teacher"), ("get", "/cutter/kinds", "admin"),
        ("get", "/classes/WF7/activities", "teacher"), ("get", "/activities", "pupil"),
    ])
    def test_the_paid_service_is_refused(self, client, free, method, path, who):
        r = getattr(client, method)(f"{API}{path}", headers=free[who])
        assert r.status_code == 403 and r.json()["code"] == "paid_feature", (path, r.text)

    def test_sending_for_cutting_is_refused_but_the_draft_is_kept(self, client, free):
        assert client.post(f"{API}/jobs", json=job_doc(pupil="pupil-wf", status="submitted"), headers=free["pupil"]).json()["code"] == "paid_feature"
        jid = client.post(f"{API}/jobs", json=job_doc(pupil="pupil-wf"), headers=free["pupil"]).json()["id"]
        r = client.post(f"{API}/jobs/{jid}/submit", headers=free["pupil"])
        assert r.status_code == 403 and r.json()["code"] == "paid_feature"

    def test_a_laser_cannot_connect(self, client, free, tokens):
        import copy
        from starlette.websockets import WebSocketDisconnect
        m = copy.deepcopy(client.get(f"{API}/machines/station-1", headers=auth(tokens["teacher"])).json())
        m["id"] = "station-wf"
        assert client.put(f"{API}/machines/station-wf", json=m, headers=free["admin"]).status_code == 200
        with pytest.raises(WebSocketDisconnect) as e:
            with client.websocket_connect(f"{API}/ws/cutter", headers=free["station"]) as ws:
                ws.receive_json()
        assert e.value.code == 4402


class TestPlatform:
    def test_the_site_admin_sets_the_plan_and_the_paid_service_opens(self, client, free):
        r = client.patch(f"{API}/schools/westfield-high", json={"plan": "paid"}, headers=free["root"])
        assert r.status_code == 200 and r.json()["plan"] == "paid"
        assert client.get(f"{API}/queue", headers=free["pupil"]).status_code == 200
        assert client.patch(f"{API}/schools/westfield-high", json={"plan": "gold"}, headers=free["root"]).status_code == 422

    def test_school_admins_are_not_site_admins(self, client, free, tokens):
        for who in (free["admin"], auth(tokens["teacher"])):
            assert client.get(f"{API}/schools", headers=who).status_code == 403
            assert client.patch(f"{API}/schools/westfield-high", json={"plan": "paid"}, headers=who).status_code == 403
        assert any(s["id"] == "westfield-high" and s["code"] for s in client.get(f"{API}/schools", headers=free["root"]).json())
