"""Staff accounts and their emails (shared 0.2.47): invites and reset links lead to choosing a password; sessions alongside DINO;
the walls. Passwords themselves are in test_staff_passwords.py."""
from __future__ import annotations

import re

import pytest
from fastapi.testclient import TestClient

from kerf_server.app import create_app
from kerf_server.config import Settings
from kerf_server.security import issue_token

from .conftest import auth

API = "/api/v1"


PW = "cobalt harbour lantern"


def link_token(app) -> str:
    mail = app.state.mailer.outbox[-1]
    return re.search(r"signin=([A-Za-z0-9_-]+)", mail.text).group(1)  # type: ignore[union-attr]


def use_link(client, app, password: str = PW):
    return client.post(f"{API}/auth/email/finish", json={"token": link_token(app), "password": password})


def login(client, email: str, password: str = PW, **kw):
    return client.post(f"{API}/auth/staff/login", json={"email": email, "password": password, **kw})


@pytest.fixture()
def world(client, app):
    root = auth(issue_token(app.state.db, "platform", "root"))
    r = client.post(f"{API}/schools", json={"id": "westfield-high", "name": "Westfield High", "adminEmail": "Head@Westfield.example", "adminName": "Ms Head"}, headers=root)
    assert r.status_code == 201, r.text
    return {"root": root, "invite": r.json()["adminInvite"]}


class TestInvitesAndLinks:
    def test_the_first_admin_is_invited_by_email_and_signs_in(self, client, app, world):
        mail = app.state.mailer.outbox[-1]
        assert mail.to == "head@westfield.example" and "Westfield High" in mail.subject and "school admin" in mail.text
        assert "choose your password" in mail.text.lower()
        assert world["invite"]["status"] == "invited" and world["invite"]["hasPassword"] is False
        r = use_link(client, app)
        assert r.status_code == 200 and r.json()["role"] == "admin"
        t = auth(r.json()["token"])
        me = client.get(f"{API}/auth/me", headers=t).json()
        assert me["school"] == "westfield-high" and me["role"] == "admin"
        assert use_link(client, app).status_code == 401  # a link works once
        assert me["method"] == "password"

    def test_an_admin_invites_a_teacher_who_chooses_a_password_and_signs_in_again(self, client, app, world):
        admin = auth(use_link(client, app).json()["token"])
        r = client.post(f"{API}/staff/invite", json={"email": "art@westfield.example", "role": "teacher"}, headers=admin)
        assert r.status_code == 201 and r.json()["role"] == "teacher"
        tid = r.json()["id"]
        teacher = auth(use_link(client, app, "teal otter meadow").json()["token"])
        assert client.post(f"{API}/classes", json={"code": "WART"}, headers=teacher).status_code == 201
        assert client.post(f"{API}/staff/invite", json={"email": "x@westfield.example"}, headers=teacher).status_code == 403  # only admins invite
        people = {p["id"]: p for p in client.get(f"{API}/staff/people", headers=admin).json()}
        assert people[tid]["status"] == "active" and people[tid]["hasPassword"] is True
        assert client.post(f"{API}/staff/invite", json={"email": "art@westfield.example"}, headers=admin).json()["code"] == "conflict"
        # later: email + password
        r = login(client, "ART@westfield.example", "teal otter meadow")
        assert r.status_code == 200 and r.json()["id"] == tid and r.json()["school"] == "westfield-high"
        # removing them ends their sessions and their password
        assert client.delete(f"{API}/staff/people/{tid}", headers=admin).status_code == 204
        assert client.get(f"{API}/auth/me", headers=teacher).status_code == 401
        assert login(client, "art@westfield.example", "teal otter meadow").json()["code"] == "bad_login"
        n = len(app.state.mailer.outbox)
        client.post(f"{API}/auth/password/forgot", json={"email": "art@westfield.example"})
        assert len(app.state.mailer.outbox) == n  # no link for a removed account

    def test_send_again_sends_a_fresh_invite_until_they_choose_a_password(self, client, app, world):
        first = link_token(app)
        admin_tok = issue_token(app.state.db, "admin", "A-west", school="westfield-high")
        assert client.post(f"{API}/staff/invite", json={"email": "head@westfield.example", "role": "admin"}, headers=auth(admin_tok)).status_code == 201
        assert link_token(app) != first
        assert client.post(f"{API}/auth/email/finish", json={"token": first, "password": PW}).status_code == 200  # both links work until one is used
        assert use_link(client, app).status_code == 401  # choosing a password used up the other link

    def test_unknown_addresses_get_the_same_answer_and_no_email(self, client, app, world):
        n = len(app.state.mailer.outbox)
        r = client.post(f"{API}/auth/password/forgot", json={"email": "nobody@nowhere.example"})
        assert r.status_code == 200 and r.json()["message"].startswith("If that address has a Kerf account") and len(app.state.mailer.outbox) == n
        assert client.post(f"{API}/auth/password/forgot", json={"email": "not an email"}).status_code == 422
        assert client.post(f"{API}/auth/email/finish", json={"token": "made-up", "password": PW}).status_code == 401

    def test_links_per_address_are_limited(self, client, app, world):
        n = len(app.state.mailer.outbox)
        for _ in range(5):
            assert client.post(f"{API}/auth/password/forgot", json={"email": "head@westfield.example"}).status_code == 200
        assert len(app.state.mailer.outbox) == n + 3

    def test_a_school_that_turns_email_off_gets_no_links(self, client, app, world):
        admin = auth(use_link(client, app).json()["token"])
        # email is the only staff method this school has, so it cannot be turned off
        assert client.patch(f"{API}/school/sign-in", json={"methods": {"email": False}}, headers=admin).json()["code"] == "would_lock_out"


class TestDinoServers:
    """On a DINO server (planner mode) email sessions still work, and links point at KERF_PUBLIC_URL only."""

    def make(self, tmp_path, **kw):
        cfg = Settings.from_env(data_dir=tmp_path / "data", auth_mode="planner", sso_issuer="https://dino.example", resend_api_key="", **kw)
        return TestClient(create_app(cfg))

    def test_needs_a_public_url_for_links(self, tmp_path):
        with self.make(tmp_path) as c:
            root = auth(issue_token(c.app.state.db, "platform", "root"))
            r = c.post(f"{API}/schools", json={"id": "eastfield", "name": "Eastfield", "adminEmail": "a@eastfield.example"}, headers=root)
            assert r.status_code == 503 and r.json()["code"] == "email_not_set_up"

    def test_email_sessions_work_alongside_dino(self, tmp_path):
        with self.make(tmp_path, public_url="https://kerf.example.org") as c:
            root = auth(issue_token(c.app.state.db, "platform", "root"))
            assert c.post(f"{API}/schools", json={"id": "eastfield", "name": "Eastfield", "adminEmail": "a@eastfield.example"}, headers=root).status_code == 201
            assert re.search(r"https://kerf\.example\.org/sign-in\?signin=[A-Za-z0-9_-]+&app=admin", c.app.state.mailer.outbox[-1].text)
            t = c.post(f"{API}/auth/email/finish", json={"token": link_token(c.app), "password": PW}).json()["token"]
            assert c.get(f"{API}/auth/me", headers=auth(t)).json()["school"] == "eastfield"
            t2 = c.post(f"{API}/auth/staff/login", json={"email": "a@eastfield.example", "password": PW}).json()["token"]
            assert c.get(f"{API}/auth/me", headers=auth(t2)).json()["method"] == "password"  # password sessions work alongside DINO
            stored = issue_token(c.app.state.db, "teacher", "T9", school="eastfield")  # a plain stored person token is still refused
            assert c.get(f"{API}/auth/me", headers=auth(stored)).status_code == 401


class TestMailer:
    def test_sends_to_resend_without_logging_the_address(self, monkeypatch, caplog):
        import json

        from kerf_server import services_email as em

        seen = {}

        class Res:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self): return b"{}"

        def fake(req, timeout):
            seen["url"], seen["auth"], seen["body"] = req.full_url, req.get_header("Authorization"), json.loads(req.data)
            return Res()

        monkeypatch.setattr(em.urllib.request, "urlopen", fake)
        m = em.Mailer("re_test", "Kerf <kerf-no-reply@mr-salih.org>")
        with caplog.at_level("INFO", logger="kerf.email"):
            m.send(em.reset_email("p@school.example", "https://kerf.example/sign-in?signin=abc&app=admin", "Westfield", 30))
        assert seen["url"] == em.RESEND_URL and seen["auth"] == "Bearer re_test"
        assert seen["body"]["from"] == "Kerf <kerf-no-reply@mr-salih.org>" and seen["body"]["to"] == ["p@school.example"]
        assert "p@school.example" not in caplog.text and "signin=abc" not in caplog.text and "sent" in caplog.text


class TestSchoolsAreWalls:
    def test_another_schools_admin_cannot_see_or_remove_staff(self, client, app, world):
        head = use_link(client, app).json()
        other = auth(issue_token(app.state.db, "admin", "A-other"))  # the main school's admin
        assert all(p["id"] != head["id"] for p in client.get(f"{API}/staff/people", headers=other).json())
        assert client.delete(f"{API}/staff/people/{head['id']}", headers=other).status_code == 404
        assert client.get(f"{API}/auth/me", headers=auth(head["token"])).status_code == 200
