"""Terms (docs/ACCOUNTS.md, shared 0.2.41): the site admin sets Kerf's default terms (features, limits, time-limited grants);
a new free school gets a copy that later default changes never touch; the site admin can change one school's terms."""
from __future__ import annotations

from datetime import timedelta

from kerf_server.db import iso, utcnow
from kerf_server.security import issue_token
from kerf_server.services_terms import add_months

from .conftest import auth
from .test_jobs import job_doc

API = "/api/v1"
TRIAL = {"features": {"laser": False, "activities": False}, "limits": {"groupsPerSchool": 10, "pupilsPerGroup": 50, "filesPerPupil": 20, "laserGroups": 2},
         "grants": [{"label": "Laser for 12 months", "months": 12, "features": {"laser": True}}]}


def school(client, app, root, sid):
    assert client.post(f"{API}/schools", json={"id": sid, "name": sid.title()}, headers=root).status_code == 201
    return {r: auth(issue_token(app.state.db, r, f"{r}-{sid}", school=sid)) for r in ("pupil", "teacher", "admin")}


def root_of(app):
    return auth(issue_token(app.state.db, "platform", "root"))


class TestDefaultTerms:
    def test_only_the_site_admin_sees_or_sets_them(self, client, tokens, app):
        assert client.get(f"{API}/platform/terms", headers=auth(tokens["teacher"])).status_code == 403
        root = root_of(app)
        assert client.get(f"{API}/platform/terms", headers=root).json()["limits"]["groupsPerSchool"] == 20
        assert client.put(f"{API}/platform/terms", json={**TRIAL, "grants": [{"label": "x", "months": 0}]}, headers=root).status_code == 422
        assert client.put(f"{API}/platform/terms", json={"features": {"teleport": True}}, headers=root).status_code == 422

    def test_a_new_school_gets_a_copy_later_changes_leave_it_alone(self, client, app):
        root = root_of(app)
        assert client.put(f"{API}/platform/terms", json=TRIAL, headers=root).status_code == 200
        a = school(client, app, root, "westfield-high")
        me = client.get(f"{API}/auth/me", headers=a["teacher"]).json()
        assert me["features"] == {"laser": True, "activities": False} and me["limits"]["groupsPerSchool"] == 10
        t = client.get(f"{API}/schools/westfield-high/terms", headers=root).json()
        assert t["terms"]["grants"][0]["until"][:7] == iso(add_months(utcnow(), 12))[:7]
        client.put(f"{API}/platform/terms", json={**TRIAL, "grants": []}, headers=root)  # the default changes...
        assert client.get(f"{API}/auth/me", headers=a["teacher"]).json()["features"]["laser"] is True  # ...this school keeps its copy
        b = school(client, app, root, "eastfield")
        assert client.get(f"{API}/auth/me", headers=b["teacher"]).json()["features"]["laser"] is False


class TestSchoolTerms:
    def test_a_grant_ends_on_its_date(self, client, app):
        root = root_of(app)
        a = school(client, app, root, "westfield-high")
        assert client.get(f"{API}/queue", headers=a["pupil"]).json()["code"] == "paid_feature"
        past = {"features": {}, "grants": [{"label": "Trial", "until": iso(utcnow() - timedelta(days=1)), "features": {"laser": True, "activities": True}}]}
        assert client.put(f"{API}/schools/westfield-high/terms", json=past, headers=root).json()["now"]["features"]["laser"] is False
        now = {"features": {}, "grants": [{"label": "Trial", "until": iso(utcnow() + timedelta(days=90)), "features": {"laser": True, "activities": True},
                                           "limits": {"groupsPerSchool": None}}]}
        r = client.put(f"{API}/schools/westfield-high/terms", json=now, headers=root).json()["now"]
        assert r["features"] == {"laser": True, "activities": True} and r["limits"]["groupsPerSchool"] is None and r["grants"][0]["label"] == "Trial"
        assert client.get(f"{API}/queue", headers=a["pupil"]).status_code == 200
        assert client.get(f"{API}/school/terms", headers=a["teacher"]).json()["features"]["activities"] is True

    def test_a_paid_school_has_everything(self, client, tokens):
        me = client.get(f"{API}/auth/me", headers=auth(tokens["teacher"])).json()
        assert me["features"] == {"laser": True, "activities": True} and set(me["limits"].values()) == {None}


class TestLaserGroups:
    def test_only_the_picked_groups_send_and_only_so_many(self, client, app):
        root = root_of(app)
        client.put(f"{API}/platform/terms", json={**TRIAL, "limits": {**TRIAL["limits"], "laserGroups": 1}}, headers=root)
        a = school(client, app, root, "westfield-high")
        for code in ("WA", "WB"):
            client.post(f"{API}/classes", json={"code": code}, headers=a["teacher"])
            client.post(f"{API}/classes/{code}/pupils", json={"pupilIds": ["pupil-westfield-high"] if code == "WA" else ["other-1"]}, headers=a["teacher"])
        jid = client.post(f"{API}/jobs", json=job_doc(pupil="pupil-westfield-high"), headers=a["pupil"]).json()["id"]
        r = client.post(f"{API}/jobs/{jid}/submit", headers=a["pupil"])
        assert r.status_code == 403 and r.json()["code"] == "not_laser_group"
        assert client.put(f"{API}/classes/WA", json={"laser": True}, headers=a["teacher"]).status_code == 403  # admins pick
        assert client.put(f"{API}/classes/WA", json={"laser": True}, headers=a["admin"]).json()["laser"] is True
        assert client.put(f"{API}/classes/WB", json={"laser": True}, headers=a["admin"]).json()["code"] == "limit_reached"
        r = client.post(f"{API}/jobs/{jid}/submit", headers=a["pupil"])
        assert r.json()["code"] == "no_machines", r.text  # past the plan's checks: this new school simply has no laser yet
