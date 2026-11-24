"""Pupil Card sign-in (shared 0.2.40): school code + group code + pupil ID + two-word password, generated pupil IDs and
display names, new passwords for a group, and the walls between schools."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from kerf_server.app import create_app
from kerf_server.config import Settings
from kerf_server.security import issue_token
from kerf_server.services_passwords import WORDS, normalise

from .conftest import auth

API = "/api/v1"


@pytest.fixture()
def school(client, app):
    root = auth(issue_token(app.state.db, "platform", "root"))
    doc = client.post(f"{API}/schools", json={"id": "westfield-high", "name": "Westfield High"}, headers=root).json()
    t = auth(issue_token(app.state.db, "teacher", "T-wf", school="westfield-high"))
    g = client.post(f"{API}/classes", json={"label": "Year 9", "joinCode": "9B-DT"}, headers=t).json()
    r = client.post(f"{API}/classes/{g['code']}/pupils", json={"pupils": [{"name": "Zoë Adams"}, {"id": "wf-ben", "name": "Ben Cole"}], "generate": 1}, headers=t)
    assert r.status_code == 201, r.text
    return {"code": doc["code"], "teacher": t, "group": g["code"], "created": r.json()["created"]}


def card_login(client, school, pupil, password=None, group="9B-DT"):
    return client.post(f"{API}/auth/pupil", json={"schoolCode": school["code"], "groupCode": group, "pupilId": pupil["pupilId"], "password": password or pupil["password"]})


class TestCards:
    def test_new_pupils_get_ids_names_and_two_word_passwords(self, school):
        made = school["created"]
        assert [m.get("displayName") for m in made] == ["Zoë Adams", "Ben Cole", None]
        assert made[1]["pupilId"] == "wf-ben" and made[0]["pupilId"].isdigit() and len(made[0]["pupilId"]) == 5
        for m in made:
            a, b = m["password"].split("-")
            assert a in WORDS and b in WORDS and a != b and m["pin"] == m["password"]

    def test_a_pupil_signs_in_with_their_card(self, client, school):
        r = card_login(client, school, school["created"][0])
        assert r.status_code == 200, r.text
        me = client.get(f"{API}/auth/me", headers=auth(r.json()["token"])).json()
        assert me["role"] == "pupil" and me["school"] == "westfield-high"

    def test_typing_is_forgiving_but_wrong_anything_is_the_same_answer(self, client, school):
        p = school["created"][0]
        a, b = p["password"].split("-")
        sloppy = {"schoolCode": school["code"].lower(), "groupCode": "9b-dt", "pupilId": p["pupilId"], "password": f" {a.upper()} {b} "}
        assert client.post(f"{API}/auth/pupil", json=sloppy).status_code == 200
        wrong = [card_login(client, school, p, "zebra-zebra"), card_login(client, school, p, group="NOPE"),
                 client.post(f"{API}/auth/pupil", json={**sloppy, "schoolCode": "AAAAA"}), card_login(client, school, {"pupilId": "99999", "password": p["password"]})]
        assert {(r.status_code, r.json()["message"]) for r in wrong} == {(401, "That school code, group code, pupil ID or password is not right. Check your Pupil Card.")}
        assert normalise("Tiger_River") == "tiger-river"

    def test_new_passwords_for_a_group(self, client, school):
        p = school["created"][0]
        s = auth(card_login(client, school, p).json()["token"])
        r = client.post(f"{API}/classes/{school['group']}/passwords", json={}, headers=school["teacher"])
        assert r.status_code == 200 and len(r.json()) == 3 and sum(1 for x in r.json() if x.get("displayName")) == 2
        new = {x["pupilId"]: x["password"] for x in r.json()}
        assert client.get(f"{API}/auth/me", headers=s).status_code == 401  # signed out
        assert card_login(client, school, p).status_code == 401  # the old password is gone
        assert card_login(client, school, p, new[p["pupilId"]]).status_code == 200

    def test_display_names_can_be_changed_or_cleared(self, client, school):
        pid = school["created"][2]["pupilId"]
        r = client.put(f"{API}/classes/{school['group']}/pupils/{pid}", json={"displayName": "Sam Lee"}, headers=school["teacher"])
        assert r.json()["displayName"] == "Sam Lee"
        names = {p["pupilId"]: p.get("displayName") for p in client.get(f"{API}/classes/{school['group']}/pupils", headers=school["teacher"]).json()}
        assert names[pid] == "Sam Lee"
        assert client.put(f"{API}/classes/{school['group']}/pupils/{pid}", json={"displayName": ""}, headers=school["teacher"]).json()["displayName"] is None

    def test_archived_groups_and_pupils_cannot_sign_in(self, client, school):
        p = school["created"][0]
        client.put(f"{API}/classes/{school['group']}", json={"archived": True}, headers=school["teacher"])
        assert card_login(client, school, p).status_code == 401

    def test_a_school_with_pupil_cards_off_says_so(self, client, app, school):
        admin = auth(issue_token(app.state.db, "admin", "A-wf", school="westfield-high"))
        assert client.patch(f"{API}/school/sign-in", json={"methods": {"groupCode": False}}, headers=admin).status_code == 200
        r = card_login(client, school, school["created"][0])
        assert r.status_code == 403 and r.json()["code"] == "sign_in_off"

    def test_another_schools_teacher_cannot_reset_or_rename(self, client, school, tokens):
        other = auth(tokens["teacher"])
        assert client.post(f"{API}/classes/{school['group']}/passwords", json={}, headers=other).status_code == 404
        assert client.put(f"{API}/classes/{school['group']}/pupils/wf-ben", json={"displayName": "x"}, headers=other).status_code == 404


def test_pupil_card_sessions_work_on_a_dino_server(tmp_path):
    cfg = Settings.from_env(data_dir=tmp_path / "data", auth_mode="planner", sso_issuer="https://dino.example", resend_api_key="")
    with TestClient(create_app(cfg)) as c:
        root = auth(issue_token(c.app.state.db, "platform", "root"))
        code = c.post(f"{API}/schools", json={"id": "eastfield", "name": "Eastfield"}, headers=root).json()["code"]
        from kerf_server import services_classes as sc

        with c.app.state.db.session() as s:  # teachers there sign in with links; make the group directly
            sc.create_class(s, "EF1", None, school="eastfield")
            made = sc.add_pupils(s, "EF1", ["ef-1"], school="eastfield")["created"][0]
        r = c.post(f"{API}/auth/pupil", json={"schoolCode": code, "groupCode": "EF1", "pupilId": "ef-1", "password": made["password"]})
        assert r.status_code == 200, r.text
        assert c.get(f"{API}/auth/me", headers=auth(r.json()["token"])).json()["school"] == "eastfield"
        assert c.post(f"{API}/auth/login", json={"classCode": "EF1", "pupilId": "ef-1", "pin": made["password"]}).status_code == 404  # the old class login stays off
