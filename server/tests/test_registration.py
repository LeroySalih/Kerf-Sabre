"""Free schools register themselves (shared 0.2.40): /register -> a confirmation link -> the school, its first admin, signed in."""
from __future__ import annotations

import logging
import re

import pytest
from fastapi.testclient import TestClient

from kerf_server.app import create_app
from kerf_server.config import Settings
from kerf_server.models import PendingRegistration, School, StaffAccount
from kerf_server.security import issue_token

from .conftest import auth

API = "/api/v1"
FORM = {"schoolName": "Westfield High", "name": "Sam Head", "email": "Head@Westfield.example"}


def reg_token(app) -> str:
    mail = app.state.mailer.outbox[-1]
    return re.search(r"register=([A-Za-z0-9_-]+)", mail.text).group(1)  # type: ignore[union-attr]


def register(client, app, form=None) -> dict:
    r = client.post(f"{API}/auth/register", json=form or FORM)
    assert r.status_code == 200, r.text
    f = client.post(f"{API}/auth/register/finish", json={"token": reg_token(app)})
    assert f.status_code == 200, f.text
    return f.json()


class TestRegistering:
    def test_happy_path(self, client, app, caplog):
        caplog.set_level(logging.DEBUG)
        r = client.post(f"{API}/auth/register", json=FORM)
        assert r.status_code == 200 and r.json()["message"].startswith("Thank you")
        mail = app.state.mailer.outbox[-1]
        assert mail.to == "head@westfield.example" and mail.subject.startswith("Confirm your school on Kerf")
        assert "24 hours" in mail.text and "/sign-in?register=" in mail.text and "free plan" in mail.text
        with app.state.db.session() as s:  # nothing is made until the link is used
            assert s.get(School, "westfield-high") is None
            row = s.query(PendingRegistration).one()
            assert reg_token(app) not in row.token_hash  # only the hash is stored
        tok = reg_token(app)
        f = client.post(f"{API}/auth/register/finish", json={"token": tok})
        assert f.status_code == 200, f.text
        out = f.json()
        assert out["role"] == "admin" and out["school"] == "westfield-high" and out["name"] == "Sam Head" and out["schoolName"] == "Westfield High"
        t = auth(out["token"])
        me = client.get(f"{API}/auth/me", headers=t).json()
        assert me["role"] == "admin" and me["school"] == "westfield-high" and me["plan"] == "free" and me["schoolCode"]
        signin = client.get(f"{API}/school/sign-in", headers=t).json()
        assert signin["methods"]["groupCode"] and signin["methods"]["email"] and not signin["methods"]["dino"]
        assert client.get(f"{API}/school/terms", headers=t).status_code == 200
        with app.state.db.session() as s:
            acct = s.query(StaffAccount).one()
            assert acct.email == "head@westfield.example" and acct.role == "admin" and acct.name == "Sam Head"
            assert s.get(School, "westfield-high").terms is not None  # a copy of the default terms
        # the new admin can later ask for a sign-in link like any member of staff
        n = len(app.state.mailer.outbox)
        client.post(f"{API}/auth/email/start", json={"email": "head@westfield.example"})
        assert len(app.state.mailer.outbox) == n + 1
        logged = caplog.text.lower()
        assert "head@westfield.example" not in logged and tok not in caplog.text and "sam head" not in logged

    def test_a_link_works_once(self, client, app):
        register(client, app)
        r = client.post(f"{API}/auth/register/finish", json={"token": reg_token(app)})
        assert r.status_code == 401 and r.json()["code"] == "link_invalid"
        with app.state.db.session() as s:
            assert s.query(School).filter(School.name == "Westfield High").count() == 1

    def test_an_expired_link_makes_nothing(self, client, app):
        from datetime import timedelta

        from kerf_server.db import utcnow

        client.post(f"{API}/auth/register", json=FORM)
        with app.state.db.session() as s:
            s.query(PendingRegistration).one().expires_at = utcnow() - timedelta(minutes=1)
        r = client.post(f"{API}/auth/register/finish", json={"token": reg_token(app)})
        assert r.status_code == 401 and r.json()["code"] == "link_invalid"
        assert client.post(f"{API}/auth/register/finish", json={"token": "made-up"}).status_code == 401
        with app.state.db.session() as s:
            assert s.get(School, "westfield-high") is None

    def test_checks_the_form(self, client):
        for bad in ({**FORM, "schoolName": " "}, {**FORM, "name": ""}, {**FORM, "email": "not an email"}, {**FORM, "name": "me@x.example"}, {**FORM, "schoolName": "x" * 200}):
            r = client.post(f"{API}/auth/register", json=bad)
            assert r.status_code == 422, bad

    def test_same_answer_for_an_address_that_already_has_an_account(self, client, app):
        register(client, app)
        r = client.post(f"{API}/auth/register", json={**FORM, "schoolName": "Eastfield"})
        assert r.status_code == 200 and r.json()["message"].startswith("Thank you")


class TestLimits:
    def test_per_address(self, client, app):
        n = len(app.state.mailer.outbox)
        for _ in range(5):
            assert client.post(f"{API}/auth/register", json=FORM).status_code == 200
        assert len(app.state.mailer.outbox) == n + 3

    def test_per_computer(self, client, app):
        codes = [client.post(f"{API}/auth/register", json={**FORM, "email": f"t{i}@westfield.example"}).status_code for i in range(12)]
        assert codes[:10] == [200] * 10 and codes[10:] == [429, 429]


class TestClosed:
    def test_registration_can_be_switched_off(self, tmp_path):
        cfg = Settings.from_env(data_dir=tmp_path / "data", auth_mode="pins", resend_api_key="", registration=False)
        with TestClient(create_app(cfg)) as c:
            assert c.get(f"{API}/auth/config").json()["registration"] is False
            r = c.post(f"{API}/auth/register", json=FORM)
            assert r.status_code == 403 and r.json()["code"] == "registration_closed"
            assert c.post(f"{API}/auth/register/finish", json={"token": "x" * 40}).json()["code"] == "registration_closed"
            assert not c.app.state.mailer.outbox

    def test_open_by_default(self, client):
        assert client.get(f"{API}/auth/config").json()["registration"] is True


class TestSchoolIds:
    def test_a_clash_adds_a_number(self, client, app):
        assert register(client, app)["school"] == "westfield-high"
        assert register(client, app, {**FORM, "email": "b@westfield.example"})["school"] == "westfield-high-2"
        assert register(client, app, {**FORM, "email": "c@westfield.example"})["school"] == "westfield-high-3"

    def test_made_from_the_name(self, client, app):
        assert register(client, app, {**FORM, "schoolName": "St. Mary's C of E Primary School, Little Wittering-on-the-Marsh"})["school"] == "st-mary-s-c-of-e-primary-school"
        assert register(client, app, {**FORM, "schoolName": "École Ørsted  !!", "email": "e@x.example"})["school"] == "ecole-rsted"
        assert register(client, app, {**FORM, "schoolName": "!!!", "email": "f@x.example"})["school"] == "school"


class TestOwnerNote:
    def test_kerf_is_told_which_school_registered(self, tmp_path):
        cfg = Settings.from_env(data_dir=tmp_path / "data", auth_mode="pins", resend_api_key="", admin_email="owner@kerf.example")
        with TestClient(create_app(cfg)) as c:
            out = register(c, c.app)
            note = c.app.state.mailer.outbox[-1]
            assert note.to == "owner@kerf.example" and "Westfield High" in note.text and out["school"] in note.text
            assert "head@westfield.example" not in note.text.lower() and "Sam Head" not in note.text

    def test_no_note_without_the_setting(self, client, app):
        register(client, app)
        assert all(m.kind != "school registered" for m in app.state.mailer.outbox)


class TestWalls:
    @pytest.fixture()
    def other(self, client, app):
        root = auth(issue_token(app.state.db, "platform", "root"))
        assert client.post(f"{API}/schools", json={"id": "eastfield", "name": "Eastfield", "plan": "paid"}, headers=root).status_code == 201
        east = auth(issue_token(app.state.db, "admin", "EADMIN", school="eastfield"))
        assert client.post(f"{API}/classes", json={"code": "E9", "label": "East 9"}, headers=east).status_code == 201
        return east

    def test_a_registered_schools_admin_sees_only_their_school(self, client, app, other):
        t = auth(register(client, app)["token"])
        assert client.get(f"{API}/classes", headers=t).json() == []
        assert client.get(f"{API}/classes/E9/pupils", headers=t).status_code == 404
        assert client.put(f"{API}/classes/E9", json={"label": "mine"}, headers=t).status_code == 404
        assert client.get(f"{API}/schools", headers=t).status_code == 403  # not a site admin
        assert client.post(f"{API}/classes", json={"code": "W9"}, headers=t).status_code == 201
        assert client.get(f"{API}/classes/W9/pupils", headers=other).status_code == 404
        assert [c["code"] for c in client.get(f"{API}/classes", headers=other).json()] == ["E9"]

    def test_the_new_school_is_free_and_gated(self, client, app):
        t = auth(register(client, app)["token"])
        assert client.get(f"{API}/queue", headers=t).status_code == 403


class TestAccessLog:
    def test_links_in_addresses_are_not_logged(self, client):
        import logging as lg

        from kerf_server.app import HideLinks

        rec = lg.LogRecord("uvicorn.access", lg.INFO, "", 0, '%s - "%s %s HTTP/%s" %d', ("127.0.0.1:1", "GET", "/sign-in?register=SECRETTOKEN&app=admin", "1.1", 200), None)
        HideLinks().filter(rec)
        assert "SECRETTOKEN" not in rec.getMessage() and "register=…&app=admin" in rec.getMessage()
        rec = lg.LogRecord("uvicorn.access", lg.INFO, "", 0, "GET /sign-in?signin=ABC", None, None)
        HideLinks().filter(rec)
        assert rec.getMessage() == "GET /sign-in?signin=…"
        assert sum(isinstance(f, HideLinks) for f in lg.getLogger("uvicorn.access").filters) == 1  # added once by create_app


def test_what_happens_to_each_email_is_in_the_server_log(client):
    """`kerf.email` lines reach the log (without the address or the link), so a missing RESEND_API is easy to spot."""
    import logging

    lg = logging.getLogger("kerf.email")
    assert lg.handlers and lg.getEffectiveLevel() <= logging.INFO  # set up by create_app, whatever else configures logging
    seen: list[str] = []

    class Grab(logging.Handler):
        def emit(self, record):
            seen.append(record.getMessage())

    g = Grab()
    lg.addHandler(g)
    try:
        client.post("/api/v1/auth/register", json={"schoolName": "Log Test High", "name": "Sam Taylor", "email": "sam@logtest.example"})
    finally:
        lg.removeHandler(g)
    assert seen == ["email kept (no RESEND_API set): registration link"]
