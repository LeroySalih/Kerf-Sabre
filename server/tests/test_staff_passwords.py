"""Staff sign in with school email + password (shared 0.2.47). Email only checks the address: invites, registering a school and
"Forgot your password?" send a one-time link that leads to choosing a password."""
from __future__ import annotations

import logging
import re
from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from kerf_server import services_staffpw as pw
from kerf_server.app import create_app
from kerf_server.config import Settings
from kerf_server.db import utcnow
from kerf_server.models import StaffAccount, Token
from kerf_server.security import issue_token

from .conftest import auth

API = "/api/v1"
PW = "violet canal biscuit"


def make_school(client, app, sid: str, name: str) -> None:
    root = auth(issue_token(app.state.db, "platform", "root"))
    r = client.post(f"{API}/schools", json={"id": sid, "name": name}, headers=root)
    assert r.status_code == 201, r.text


def make_account(app, email: str, school: str, password: str | None = PW, role: str = "teacher", pid: str | None = None, **kw) -> str:
    pid = pid or f"st-{school[:4]}{abs(hash(email)) % 10000}"
    with app.state.db.session() as s:
        s.add(StaffAccount(person_id=pid, school_id=school, email=email, role=role, failed_attempts=0,
                           password_hash=pw.hash_password(password, **kw) if password else None))
    return pid


def login(client, email: str, password: str = PW, **kw):
    return client.post(f"{API}/auth/staff/login", json={"email": email, "password": password, **kw})


def last_link(app) -> str:
    return re.search(r"signin=([A-Za-z0-9_-]+)", app.state.mailer.outbox[-1].text).group(1)  # type: ignore[union-attr]


@pytest.fixture()
def west(client, app):
    make_school(client, app, "westfield-high", "Westfield High")
    return make_account(app, "art@westfield.example", "westfield-high")


class TestHashing:
    def test_format_salt_and_verify(self):
        a, b = pw.hash_password(PW), pw.hash_password(PW)
        assert re.fullmatch(r"scrypt\$32768\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{64}", a)
        assert a != b and a.split("$")[4] != b.split("$")[4]  # a new salt every time
        assert pw.check_password(PW, a) and pw.check_password(PW, b)
        assert not pw.check_password(PW + "x", a) and not pw.check_password("", a)
        assert PW not in a

    def test_no_password_or_a_damaged_hash_never_matches_but_costs_the_same(self, monkeypatch):
        calls = []
        real = pw._derive
        monkeypatch.setattr(pw, "_derive", lambda *a: calls.append(a[2:]) or real(*a))
        for stored in (None, "", "scrypt$nonsense", "bcrypt$1$2$3$aa$bb", "scrypt$3$8$1$00$00"):
            assert pw.check_password(PW, stored) is False
        assert calls == [(pw.N, pw.R, pw.P)] * 5  # one full-cost scrypt each time

    def test_old_parameters_still_check_and_are_raised_at_sign_in(self, client, app, west):
        pid = make_account(app, "old@westfield.example", "westfield-high", n=2**14)
        with app.state.db.session() as s:
            old = s.get(StaffAccount, pid).password_hash
        assert old.startswith("scrypt$16384$") and pw.needs_rehash(old) and not pw.needs_rehash(pw.hash_password("x"))
        assert login(client, "old@westfield.example").status_code == 200
        with app.state.db.session() as s:
            new = s.get(StaffAccount, pid).password_hash
        assert new.startswith("scrypt$32768$8$1$") and pw.check_password(PW, new)


class TestRules:
    @pytest.mark.parametrize("bad", ["", "short", "123456789", "a" * 129, "password123", "QWERTY1234", "kerf123456",
                                     "art@westfield.example", "westfield", "aaaaaaaaaaaa", None, 12345678901])
    def test_refused(self, bad):
        with pytest.raises(Exception) as e:
            pw.check_rules(bad, "art@westfield.example")
        assert e.value.status == 422 and e.value.code == "weak_password"  # type: ignore[attr-defined]
        if isinstance(bad, str) and bad:
            assert bad not in e.value.message  # type: ignore[attr-defined]

    @pytest.mark.parametrize("good", [PW, "Tr0ub4dor&3x", "x" * 9 + "yz", "a" * 125 + "bcd"])
    def test_accepted(self, good):
        assert pw.check_rules(good, "art@westfield.example") == good

    def test_short_message(self):
        with pytest.raises(Exception) as e:
            pw.check_rules("abc", "a@b.example")
        assert e.value.message == "Use at least 10 characters. Three random words work well."  # type: ignore[attr-defined]


class TestSignIn:
    def test_good(self, client, app, west):
        r = login(client, " ART@Westfield.example ")
        assert r.status_code == 200, r.text
        out = r.json()
        assert out["id"] == west and out["role"] == "teacher" and out["school"] == "westfield-high" and out["expiresAt"]
        me = client.get(f"{API}/auth/me", headers=auth(out["token"])).json()
        assert me["school"] == "westfield-high" and me["method"] == "password"
        with app.state.db.session() as s:
            tok = s.query(Token).filter(Token.subject_id == west).one()
            assert tok.method == "password" and tok.expires_at is not None
            assert s.get(StaffAccount, west).last_login is not None

    def test_wrong_password_and_unknown_address_are_the_same_answer(self, client, app, west, monkeypatch):
        pw.dummy_check("warm up")  # the dummy hash is made once
        calls = []
        real = pw._derive
        monkeypatch.setattr(pw, "_derive", lambda *a: calls.append(1) or real(*a))
        wrong = login(client, "art@westfield.example", "not the right one")
        unknown = login(client, "nobody@westfield.example", "not the right one")
        junk = login(client, "not an address", "not the right one")
        assert wrong.status_code == unknown.status_code == junk.status_code == 401
        assert wrong.json() == unknown.json() == junk.json() == {"code": "bad_login", "message": "That email address or password is not right."}
        assert len(calls) == 3  # the same scrypt work each time
        assert client.post(f"{API}/auth/staff/login", json={"email": "art@westfield.example"}).status_code == 422

    def test_lockout_and_its_end(self, client, app, west):
        for _ in range(pw.MAX_FAILURES):
            assert login(client, "art@westfield.example", "wrong wrong wrong").status_code == 401
        r = login(client, "art@westfield.example")  # even the right password, while locked
        assert r.status_code == 429 and r.json()["code"] == "locked" and "Forgot your password" in r.json()["message"]
        with app.state.db.session() as s:
            s.get(StaffAccount, west).locked_until = utcnow() - timedelta(seconds=1)
        assert login(client, "art@westfield.example").status_code == 200
        with app.state.db.session() as s:
            a = s.get(StaffAccount, west)
            assert a.failed_attempts == 0 and a.locked_until is None

    def test_a_right_password_resets_the_count(self, client, app, west):
        for _ in range(pw.MAX_FAILURES - 1):
            login(client, "art@westfield.example", "wrong wrong wrong")
        assert login(client, "art@westfield.example").status_code == 200
        assert login(client, "art@westfield.example", "wrong wrong wrong").status_code == 401  # count started again

    def test_per_computer_throttle(self, tmp_path):
        cfg = Settings.from_env(data_dir=tmp_path / "data", auth_mode="pins", resend_api_key="", login_ip_failures=3)
        with TestClient(create_app(cfg)) as c:
            make_school(c, c.app, "westfield-high", "Westfield High")
            make_account(c.app, "art@westfield.example", "westfield-high")
            codes = [login(c, f"n{i}@westfield.example", "wrong wrong wrong").status_code for i in range(3)]
            assert codes == [401, 401, 401]
            r = login(c, "art@westfield.example")
            assert r.status_code == 429 and r.json()["code"] == "too_many_attempts"

    def test_a_removed_account_cannot_sign_in(self, client, app, west):
        with app.state.db.session() as s:
            s.get(StaffAccount, west).disabled = True
        assert login(client, "art@westfield.example").json()["code"] == "bad_login"

    def test_an_account_without_a_password_cannot_sign_in(self, client, app, west):
        make_account(app, "linkonly@westfield.example", "westfield-high", password=None)
        assert login(client, "linkonly@westfield.example").json()["code"] == "bad_login"

    def test_the_school_must_have_email_sign_in_on(self, client, app):
        make_account(app, "head@main.example", "main")  # the main school is from before per-school sign-in: DINO only
        r = login(client, "head@main.example")
        assert r.status_code == 403 and r.json()["code"] == "sign_in_off"
        assert login(client, "head@main.example", "wrong wrong wrong").json()["code"] == "bad_login"  # says nothing without the password

    def test_the_same_address_at_two_schools(self, client, app, west):
        make_school(client, app, "eastfield", "Eastfield Academy")
        east = make_account(app, "art@westfield.example", "eastfield", pid="st-east1")
        r = login(client, "art@westfield.example")
        assert r.status_code == 409 and r.json()["code"] == "choose_school"
        assert sorted(r.json()["details"], key=lambda d: d["school"]) == [{"school": "eastfield", "name": "Eastfield Academy"},
                                                                           {"school": "westfield-high", "name": "Westfield High"}]
        r = login(client, "art@westfield.example", school="eastfield")
        assert r.status_code == 200 and r.json()["id"] == east and r.json()["school"] == "eastfield"
        assert login(client, "art@westfield.example", school="nowhere").json()["code"] == "bad_login"
        # a different password at each school: only the one that matches, no question
        with app.state.db.session() as s:
            s.get(StaffAccount, east).password_hash = pw.hash_password("another long password")
        r = login(client, "art@westfield.example")
        assert r.status_code == 200 and r.json()["id"] == west


class TestLinks:
    def test_invite_then_choose_a_password_then_sign_in(self, client, app, west):
        admin = auth(issue_token(app.state.db, "admin", "A-west", school="westfield-high"))
        r = client.post(f"{API}/staff/invite", json={"email": "Tech@Westfield.example", "role": "technician", "name": "Pat"}, headers=admin)
        assert r.status_code == 201 and r.json()["hasPassword"] is False
        mail = app.state.mailer.outbox[-1]
        assert "choose your password" in mail.text.lower() and "7 days" in mail.text and "/sign-in?signin=" in mail.text
        tok = last_link(app)
        r = client.post(f"{API}/auth/email/finish", json={"token": tok})  # an old page: no password, the link is kept
        assert r.status_code == 422 and r.json()["code"] == "password_needed"
        r = client.post(f"{API}/auth/email/finish", json={"token": tok, "password": "tech@westfield.example"})
        assert r.json()["code"] == "weak_password"
        r = client.post(f"{API}/auth/email/finish", json={"token": tok, "password": PW})
        assert r.status_code == 200 and r.json()["role"] == "technician"
        assert login(client, "tech@westfield.example").status_code == 200

    def test_forgot_then_reset_ends_the_old_sessions(self, client, app, west):
        old = auth(login(client, "art@westfield.example").json()["token"])
        for _ in range(pw.MAX_FAILURES):
            login(client, "art@westfield.example", "wrong wrong wrong")
        r = client.post(f"{API}/auth/password/forgot", json={"email": "ART@westfield.example", "app": "editor"})
        assert r.status_code == 200 and r.json()["message"].startswith("If that address has a Kerf account, a link to set a new password")
        mail = app.state.mailer.outbox[-1]
        assert mail.subject == "Reset your Kerf password (Westfield High)" and "30 minutes" in mail.text and "&app=editor" in mail.text
        with app.state.db.session() as s:
            assert s.query(Token).filter(Token.subject_id == west, Token.revoked.is_(False)).count() == 1
        r = client.post(f"{API}/auth/email/finish", json={"token": last_link(app), "password": "a brand new password"})
        assert r.status_code == 200
        new = auth(r.json()["token"])
        assert client.get(f"{API}/auth/me", headers=old).status_code == 401  # the old session is over
        assert client.get(f"{API}/auth/me", headers=new).status_code == 200
        assert login(client, "art@westfield.example").json()["code"] == "bad_login"  # the old password is gone
        assert login(client, "art@westfield.example", "a brand new password").status_code == 200  # and the lockout too
        assert client.post(f"{API}/auth/email/finish", json={"token": last_link(app), "password": "another new password"}).status_code == 401

    def test_reset_links_expire(self, client, app, west):
        from kerf_server.models import SignInLink

        client.post(f"{API}/auth/password/forgot", json={"email": "art@westfield.example"})
        with app.state.db.session() as s:
            link = s.query(SignInLink).one()
            assert link.purpose == "reset"
            assert abs((link.expires_at.replace(tzinfo=None) - utcnow().replace(tzinfo=None)) - timedelta(minutes=30)) < timedelta(minutes=1)
            link.expires_at = utcnow() - timedelta(seconds=1)
        assert client.post(f"{API}/auth/email/finish", json={"token": last_link(app), "password": PW}).json()["code"] == "link_invalid"

    def test_the_old_address_still_sends_a_reset_link(self, client, app, west):
        n = len(app.state.mailer.outbox)
        assert client.post(f"{API}/auth/email/start", json={"email": "art@westfield.example"}).status_code == 200
        assert len(app.state.mailer.outbox) == n + 1 and app.state.mailer.outbox[-1].kind == "password reset link"

    def test_no_reset_link_when_the_school_has_email_sign_in_off(self, client, app):
        make_account(app, "head@main.example", "main")
        n = len(app.state.mailer.outbox)
        assert client.post(f"{API}/auth/password/forgot", json={"email": "head@main.example"}).status_code == 200
        assert len(app.state.mailer.outbox) == n


class TestChangePassword:
    def test_change(self, client, app, west):
        other = auth(login(client, "art@westfield.example").json()["token"])
        here = auth(login(client, "art@westfield.example").json()["token"])
        r = client.post(f"{API}/auth/password/change", json={"current": "wrong wrong wrong", "new": "a brand new password"}, headers=here)
        assert r.status_code == 403 and r.json()["code"] == "wrong_password"
        r = client.post(f"{API}/auth/password/change", json={"current": PW, "new": "qwerty1234"}, headers=here)
        assert r.status_code == 422 and r.json()["code"] == "weak_password"
        r = client.post(f"{API}/auth/password/change", json={"current": PW, "new": PW}, headers=here)
        assert r.json()["code"] == "weak_password"
        r = client.post(f"{API}/auth/password/change", json={"current": PW, "new": "a brand new password"}, headers=here)
        assert r.status_code == 200, r.text
        assert client.get(f"{API}/auth/me", headers=here).status_code == 200  # this session stays
        assert client.get(f"{API}/auth/me", headers=other).status_code == 401  # the others end
        assert login(client, "art@westfield.example", "a brand new password").status_code == 200

    def test_wrong_current_passwords_count_towards_the_lockout(self, client, app, west):
        here = auth(login(client, "art@westfield.example").json()["token"])
        for _ in range(pw.MAX_FAILURES):
            client.post(f"{API}/auth/password/change", json={"current": "wrong wrong wrong", "new": "a brand new password"}, headers=here)
        assert login(client, "art@westfield.example").json()["code"] == "locked"

    def test_only_for_kerf_passwords(self, client, app, west):
        stored = auth(issue_token(app.state.db, "teacher", "T001"))
        r = client.post(f"{API}/auth/password/change", json={"current": PW, "new": "a brand new password"}, headers=stored)
        assert r.status_code == 409 and r.json()["code"] == "no_password"
        assert client.post(f"{API}/auth/password/change", json={"current": PW, "new": "x" * 12}).status_code == 401


class TestWalls:
    def test_a_password_session_sees_only_its_school(self, client, app, west):
        make_school(client, app, "eastfield", "Eastfield Academy")
        east_admin = auth(issue_token(app.state.db, "admin", "EADMIN", school="eastfield"))
        assert client.post(f"{API}/classes", json={"code": "E9"}, headers=east_admin).status_code == 201
        t = auth(login(client, "art@westfield.example").json()["token"])
        assert client.get(f"{API}/classes", headers=t).json() == []
        assert client.get(f"{API}/classes/E9/pupils", headers=t).status_code == 404
        assert all(p["id"] != west for p in client.get(f"{API}/staff/people", headers=east_admin).json())

    def test_changing_a_password_only_touches_your_own_account(self, client, app, west):
        make_school(client, app, "eastfield", "Eastfield Academy")
        east = make_account(app, "art@westfield.example", "eastfield", password="eastfield password", pid="st-east2")
        east_session = auth(login(client, "art@westfield.example", "eastfield password").json()["token"])
        here = auth(login(client, "art@westfield.example").json()["token"])
        assert client.post(f"{API}/auth/password/change", json={"current": PW, "new": "a brand new password"}, headers=here).status_code == 200
        assert client.get(f"{API}/auth/me", headers=east_session).json()["id"] == east  # the other school's session stays
        assert login(client, "art@westfield.example", "eastfield password").status_code == 200


def test_no_password_or_email_reaches_the_log(client, app, west):
    seen: list[str] = []

    class Grab(logging.Handler):
        def emit(self, record):
            seen.append(record.getMessage())

    g = Grab(level=logging.DEBUG)
    root = logging.getLogger()
    old = root.level
    root.addHandler(g)
    root.setLevel(logging.DEBUG)
    for name in ("kerf.audit", "kerf.email"):
        logging.getLogger(name).addHandler(g)
    try:
        login(client, "art@westfield.example")
        login(client, "art@westfield.example", "the wrong one!")
        login(client, "nobody@westfield.example", "the wrong one!")
        client.post(f"{API}/auth/password/forgot", json={"email": "art@westfield.example"})
        client.post(f"{API}/auth/email/finish", json={"token": last_link(app), "password": "a brand new password"})
        t = auth(login(client, "art@westfield.example", "a brand new password").json()["token"])
        client.post(f"{API}/auth/password/change", json={"current": "a brand new password", "new": "the newest password"}, headers=t)
    finally:
        root.removeHandler(g)
        root.setLevel(old)
        for name in ("kerf.audit", "kerf.email"):
            logging.getLogger(name).removeHandler(g)
    text = "\n".join(seen).lower()
    assert "staff_login ok person=" + west in text and "staff_password_set person=" + west in text and "staff_password_changed" in text
    for secret in ("westfield.example", PW, "the wrong one", "a brand new password", "the newest password", "signin="):
        assert secret not in text, secret


def test_an_older_database_gets_the_password_columns(tmp_path):
    """Staff accounts made before passwords keep working: the new columns are added (NULL), and they use Forgot your password once."""
    import sqlite3

    data = tmp_path / "data"
    data.mkdir()
    con = sqlite3.connect(data / "kerf.db")
    con.execute("CREATE TABLE staff_accounts (person_id VARCHAR(64) PRIMARY KEY, school_id VARCHAR(32), email VARCHAR(254), role VARCHAR(16),"
                " name VARCHAR(128), invited_by VARCHAR(64), disabled BOOLEAN, last_login DATETIME, created_at DATETIME)")
    con.execute("INSERT INTO staff_accounts VALUES ('st-old', 'main', 'old@main.example', 'admin', NULL, NULL, 0, '2026-01-01 00:00:00', '2026-01-01 00:00:00')")
    con.commit()
    con.close()
    cfg = Settings.from_env(data_dir=data, auth_mode="pins", resend_api_key="")
    with TestClient(create_app(cfg)) as c:
        with c.app.state.db.session() as s:
            a = s.get(StaffAccount, "st-old")
            assert a is not None and a.password_hash is None and a.failed_attempts is None
        assert login(c, "old@main.example").json()["code"] == "bad_login"  # no password yet
