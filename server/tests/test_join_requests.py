"""Pupils ask to join a group; a teacher approves (shared 0.2.44). The walls: a pupil only finds groups of their own school, and only
a teacher who may manage the group (admins: every group of the school) sees or decides its requests."""
from __future__ import annotations

import pytest

from kerf_server.models import JoinRequest, Pupil
from kerf_server.security import issue_token

from .conftest import auth

API = "/api/v1"


@pytest.fixture()
def world(client, app):
    db = app.state.db
    root = auth(issue_token(db, "platform", "root"))
    for sid, name in (("westfield-high", "Westfield High"), ("eastfield", "Eastfield")):
        assert client.post(f"{API}/schools", json={"id": sid, "name": name}, headers=root).status_code == 201
    w = {
        "root": root,
        "admin": auth(issue_token(db, "admin", "WADMIN", school="westfield-high")),
        "t1": auth(issue_token(db, "teacher", "WT1", school="westfield-high")),
        "t2": auth(issue_token(db, "teacher", "WT2", school="westfield-high")),
        "east": auth(issue_token(db, "teacher", "ET1", school="eastfield")),
        "dino": auth(issue_token(db, "pupil", "D100", school="westfield-high")),  # a pupil Kerf has no row for yet (signs in with DINO)
        "eastpupil": auth(issue_token(db, "pupil", "E200", school="eastfield")),
    }
    assert client.post(f"{API}/classes", json={"code": "W9B", "joinCode": "9B-DT", "label": "Year 9 DT"}, headers=w["t1"]).status_code == 201
    assert client.post(f"{API}/classes", json={"code": "W8", "label": "Year 8"}, headers=w["t2"]).status_code == 201
    assert client.post(f"{API}/classes", json={"code": "E9", "joinCode": "9B-DT"}, headers=w["east"]).status_code == 201  # same join code, other school
    return w


def ask(client, who, code="9B-DT"):
    return client.post(f"{API}/groups/join", json={"groupCode": code}, headers=who)


def card_pupil(client, teacher, code: str) -> tuple[str, dict]:
    """A Pupil Card pupil in a group, signed in."""
    made = client.post(f"{API}/classes/{code}/pupils", json={"generate": 1}, headers=teacher).json()["created"][0]
    me = client.get(f"{API}/auth/me", headers=teacher).json()
    school_code = client.get(f"{API}/school", headers=teacher).json()["code"]
    join = next(c for c in client.get(f"{API}/classes", headers=teacher).json() if c["code"] == code)["joinCode"]
    r = client.post(f"{API}/auth/pupil", json={"schoolCode": school_code, "groupCode": join, "pupilId": made["pupilId"], "password": made["password"]})
    assert r.status_code == 200, (r.text, me)
    return made["pupilId"], auth(r.json()["token"])


class TestAsking:
    def test_ask_wait_and_see_my_requests(self, client, world):
        r = ask(client, world["dino"], " 9b-dt ")
        assert r.status_code == 201 and r.json()["status"] == "pending" and r.json()["groupCode"] == "9B-DT" and r.json()["groupLabel"] == "Year 9 DT"
        again = ask(client, world["dino"])
        assert again.status_code == 200 and again.json()["id"] == r.json()["id"]  # not made twice
        mine = client.get(f"{API}/me/join-requests", headers=world["dino"]).json()
        assert [(m["groupCode"], m["status"]) for m in mine] == [("9B-DT", "pending")]

    def test_unknown_or_archived_group(self, client, world):
        r = ask(client, world["dino"], "NOPE")
        assert r.status_code == 404 and "NOPE" in r.json()["message"]
        assert client.put(f"{API}/classes/W9B", json={"archived": True}, headers=world["t1"]).status_code == 200
        assert ask(client, world["dino"]).status_code == 404
        assert ask(client, world["dino"], "").status_code == 422

    def test_only_pupils_ask(self, client, world):
        assert ask(client, world["t1"]).status_code == 403
        assert client.post(f"{API}/groups/join", json={"groupCode": "9B-DT"}).status_code == 401

    def test_already_a_member(self, client, world):
        pid, tok = card_pupil(client, world["t1"], "W9B")
        r = ask(client, tok)
        assert r.status_code == 409 and r.json()["code"] == "already_member"

    def test_a_pupil_cannot_have_lots_waiting(self, client, world):
        for i in range(10):
            assert client.post(f"{API}/classes", json={"code": f"G{i}"}, headers=world["admin"]).status_code == 201
            assert ask(client, world["dino"], f"G{i}").status_code == 201
        r = ask(client, world["dino"])
        assert r.status_code == 409 and r.json()["code"] == "too_many_requests"


class TestDeciding:
    def test_approve_adds_a_new_pupil_who_keeps_signing_in_with_dino(self, client, app, world):
        rid = ask(client, world["dino"]).json()["id"]
        cls = {c["code"]: c for c in client.get(f"{API}/classes", headers=world["admin"]).json()}
        assert cls["W9B"]["joinRequests"] == 1 and cls["W8"]["joinRequests"] == 0
        waiting = client.get(f"{API}/classes/W9B/join-requests", headers=world["t1"]).json()
        assert [(w["id"], w["pupilId"], w["status"]) for w in waiting] == [(rid, "D100", "pending")]
        r = client.post(f"{API}/classes/W9B/join-requests/{rid}/approve", headers=world["t1"])
        assert r.status_code == 200 and r.json()["status"] == "approved"
        assert "D100" in [p["pupilId"] for p in client.get(f"{API}/classes/W9B/pupils", headers=world["t1"]).json()]
        with app.state.db.session() as s:
            row = s.get(Pupil, "D100")
            assert row is not None and row.class_code == "W9B" and row.pin_hash.startswith("scrypt$")
            jr = s.get(JoinRequest, rid)
            assert jr.decided_by == "WT1" and jr.decided_at is not None
        assert client.get(f"{API}/classes/W9B/join-requests", headers=world["t1"]).json() == []
        assert next(c for c in client.get(f"{API}/classes", headers=world["t1"]).json() if c["code"] == "W9B")["joinRequests"] == 0
        assert client.get(f"{API}/me/join-requests", headers=world["dino"]).json()[0]["status"] == "approved"
        assert ask(client, world["dino"]).json()["code"] == "already_member"
        again = client.post(f"{API}/classes/W9B/join-requests/{rid}/approve", headers=world["t1"])
        assert again.status_code == 409 and again.json()["code"] == "already_decided"

    def test_decline(self, client, world):
        rid = ask(client, world["dino"]).json()["id"]
        r = client.post(f"{API}/classes/W9B/join-requests/{rid}/decline", headers=world["t1"])
        assert r.status_code == 200 and r.json()["status"] == "declined"
        assert "D100" not in [p["pupilId"] for p in client.get(f"{API}/classes/W9B/pupils", headers=world["t1"]).json()]
        assert client.get(f"{API}/me/join-requests", headers=world["dino"]).json()[0]["status"] == "declined"
        assert ask(client, world["dino"]).status_code == 201  # they may ask again

    def test_a_pupil_card_pupil_joins_a_second_group(self, client, world):
        pid, tok = card_pupil(client, world["t2"], "W8")
        rid = ask(client, tok).json()["id"]
        assert client.post(f"{API}/classes/W9B/join-requests/{rid}/approve", headers=world["admin"]).status_code == 200  # admins: every group
        groups = next(p for p in client.get(f"{API}/classes/W9B/pupils", headers=world["t1"]).json() if p["pupilId"] == pid)["groups"]
        assert groups == ["W8", "W9B"]

    def test_approving_brings_an_archived_pupil_back(self, client, app, world):
        pid, tok = card_pupil(client, world["t2"], "W8")
        rid = ask(client, tok).json()["id"]
        assert client.delete(f"{API}/classes/W8/pupils/{pid}", headers=world["t2"]).status_code == 204  # out of their last group: archived
        waiting = client.get(f"{API}/classes/W9B/join-requests", headers=world["t1"]).json()
        assert waiting[0]["archived"] is True
        assert client.post(f"{API}/classes/W9B/join-requests/{rid}/approve", headers=world["t1"]).status_code == 200
        with app.state.db.session() as s:
            row = s.get(Pupil, pid)
            assert row.archived_at is None and row.class_code == "W9B"

    def test_the_free_limit_is_kept(self, client, world):
        terms = client.get(f"{API}/schools/westfield-high/terms", headers=world["root"]).json()["terms"]
        terms["limits"]["pupilsPerGroup"] = 1
        assert client.put(f"{API}/schools/westfield-high/terms", json=terms, headers=world["root"]).status_code == 200
        client.post(f"{API}/classes/W9B/pupils", json={"generate": 1}, headers=world["t1"])
        rid = ask(client, world["dino"]).json()["id"]
        r = client.post(f"{API}/classes/W9B/join-requests/{rid}/approve", headers=world["t1"])
        assert r.status_code == 409 and r.json()["code"] == "limit_reached"
        assert client.get(f"{API}/classes/W9B/join-requests", headers=world["t1"]).json()[0]["status"] == "pending"  # still waiting

    def test_display_name_shown_to_staff(self, client, app, world):
        from kerf_server import services_people as people

        with app.state.db.session() as s:
            people.remember(s, "D100", "westfield-high", "Dina Ode")
        ask(client, world["dino"])
        assert client.get(f"{API}/classes/W9B/join-requests", headers=world["t1"]).json()[0]["displayName"] == "Dina Ode"


class TestWalls:
    def test_a_pupil_only_finds_groups_in_their_own_school(self, client, world):
        r = ask(client, world["eastpupil"])  # the same join code exists in both schools: they get their own school's group
        assert r.status_code == 201
        assert client.get(f"{API}/classes/E9/join-requests", headers=world["east"]).json()[0]["pupilId"] == "E200"
        assert client.get(f"{API}/classes/W9B/join-requests", headers=world["t1"]).json() == []
        assert client.post(f"{API}/classes", json={"code": "WONLY"}, headers=world["t1"]).status_code == 201
        assert ask(client, world["eastpupil"], "WONLY").status_code == 404

    def test_another_schools_teacher_cannot_see_or_decide(self, client, world):
        rid = ask(client, world["dino"]).json()["id"]
        assert client.get(f"{API}/classes/W9B/join-requests", headers=world["east"]).status_code == 404
        assert client.post(f"{API}/classes/W9B/join-requests/{rid}/approve", headers=world["east"]).status_code == 404
        assert client.post(f"{API}/classes/E9/join-requests/{rid}/approve", headers=world["east"]).status_code == 404  # their own group, our request
        assert client.post(f"{API}/classes/W9B/join-requests/{rid}/decline", headers=world["east"]).status_code == 404
        assert client.get(f"{API}/classes/W9B/join-requests", headers=world["t1"]).json()[0]["status"] == "pending"

    def test_a_teacher_who_does_not_manage_the_group_cannot_decide(self, client, world):
        rid = ask(client, world["dino"]).json()["id"]
        assert client.get(f"{API}/classes/W9B/join-requests", headers=world["t2"]).status_code == 404
        assert client.post(f"{API}/classes/W9B/join-requests/{rid}/approve", headers=world["t2"]).status_code == 404
        assert client.post(f"{API}/classes/W8/join-requests/{rid}/approve", headers=world["t2"]).status_code == 404  # their group, not this request
        assert "W9B" not in [c["code"] for c in client.get(f"{API}/classes", headers=world["t2"]).json()]

    def test_a_pupil_sees_only_their_own_requests(self, client, world):
        ask(client, world["dino"])
        assert client.get(f"{API}/me/join-requests", headers=world["eastpupil"]).json() == []
        assert client.get(f"{API}/classes/W9B/join-requests", headers=world["dino"]).status_code == 403
