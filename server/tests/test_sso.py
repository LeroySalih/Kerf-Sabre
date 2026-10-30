"""Sign in with planner-004 (DINO): JWT verification, role mapping, auth modes. No network: a local key and a fake JWKS."""
from __future__ import annotations

import json
import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from jwt.algorithms import RSAAlgorithm

from kerf_server.app import create_app
from kerf_server.config import Settings
from kerf_server.security import issue_token
from kerf_server.sso import Verifier, pick_role

from .conftest import auth

ISS = "https://dino.example.org"


def make_key(kid: str):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = json.loads(RSAAlgorithm.to_jwk(key.public_key()))
    jwk.update(kid=kid, use="sig", alg="RS256")
    return key, jwk


KEY, JWK = make_key("k1")


def mint(sub="u-123", roles=("pupil",), key=KEY, kid="k1", alg="RS256", typ="at+jwt", **over):
    now = int(time.time())
    claims = {"iss": ISS, "sub": sub, "aud": "kerf-sabre", "iat": now, "nbf": now, "exp": now + 900, "jti": "x",
              "client_id": "kerf-editor", "scope": "", "roles": list(roles)}
    claims.update(over)
    claims = {k: v for k, v in claims.items() if v is not None}
    return jwt.encode(claims, key, algorithm=alg, headers={"kid": kid, "typ": typ})


class Jwks:
    """A fake /oauth/jwks that counts fetches and can be changed or broken."""

    def __init__(self, *jwks):
        self.keys, self.calls, self.down = list(jwks), 0, False

    def __call__(self, url):
        self.calls += 1
        assert url == f"{ISS}/oauth/jwks"
        if self.down:
            raise OSError("planner-004 is down")
        return {"keys": self.keys}


@pytest.fixture()
def jwks():
    return Jwks(JWK)


@pytest.fixture()
def sso_app(tmp_path, jwks):
    cfg = Settings.from_env(data_dir=tmp_path / "data", replace_old_sends=False, auth_mode="both", sso_issuer=ISS, auto_approve_default=False)
    app = create_app(cfg)
    app.state.sso = Verifier(cfg, fetch=jwks)
    return app


@pytest.fixture()
def sso_client(sso_app):
    with TestClient(sso_app) as c:
        yield c


def me(client, token):
    return client.get("/api/v1/auth/me", headers=auth(token))


class TestRoles:
    @pytest.mark.parametrize("roles,want", [(["pupil"], "pupil"), (["teacher"], "teacher"), (["Teacher", "pupil"], "teacher"),
                                            (["admin", "teacher"], "admin"), (["technician"], "technician"), (["technician", "pupil"], "technician"),
                                            (["technician", "teacher"], "teacher"), (["pupil", "admin"], "admin")])
    def test_pick_role(self, roles, want):
        assert pick_role(roles) == want

    @pytest.mark.parametrize("roles", [[], ["station"], ["platform"], "admin", None, [1], ["parent"]])
    def test_unknown_roles_get_nothing(self, roles):
        assert pick_role(roles) is None


class TestSignedInPeople:
    @pytest.mark.parametrize("roles,role", [(["pupil"], "pupil"), (["teacher"], "teacher"), (["admin"], "admin"), (["technician"], "technician")])
    def test_me(self, sso_client, roles, role):
        r = me(sso_client, mint(roles=roles))
        assert r.status_code == 200
        assert r.json()["role"] == role and r.json()["id"] == "u-123" and r.json()["school"]

    def test_a_pupil_jwt_cannot_do_teacher_things(self, sso_client):
        r = sso_client.get("/api/v1/classes", headers=auth(mint(roles=["pupil"])))
        assert r.status_code == 403

    def test_a_teacher_jwt_can(self, sso_client):
        assert sso_client.get("/api/v1/classes", headers=auth(mint(roles=["teacher"]))).status_code == 200

    def test_logout_with_a_jwt_is_harmless(self, sso_client):
        assert sso_client.post("/api/v1/auth/logout", headers=auth(mint())).status_code == 204

    def test_station_tokens_still_work(self, sso_client, app):
        from kerf_server.security import issue_token

        t = issue_token(sso_client.app.state.db, "station", "station-1")
        assert me(sso_client, t).json()["role"] == "station"


class TestRefusals:
    def test_expired(self, sso_client):
        assert me(sso_client, mint(exp=int(time.time()) - 600)).status_code == 401

    def test_inside_the_leeway_is_ok(self, sso_client):
        assert me(sso_client, mint(exp=int(time.time()) - 10)).status_code == 200

    def test_not_yet_valid(self, sso_client):
        assert me(sso_client, mint(nbf=int(time.time()) + 600)).status_code == 401

    @pytest.mark.parametrize("over", [{"aud": "something-else"}, {"iss": "https://evil.example"}, {"client_id": "claude"}, {"client_id": None}, {"sub": None},
                                      {"sub": "has space"}, {"sub": "x" * 65}, {"sub": ""}])
    def test_wrong_claims(self, sso_client, over):
        assert me(sso_client, mint(**over)).status_code == 401

    def test_an_id_token_is_not_an_access_token(self, sso_client):
        assert me(sso_client, mint(typ="JWT")).status_code == 401

    def test_nbf_is_required(self, sso_client):
        assert me(sso_client, mint(nbf=None)).status_code == 401

    def test_no_known_role_is_403(self, sso_client):
        assert me(sso_client, mint(roles=["parent"])).status_code == 403

    def test_a_jwt_can_never_be_a_station_or_platform(self, sso_client):
        for r in ("station", "platform"):
            assert me(sso_client, mint(roles=[r])).status_code == 403

    def test_signed_by_someone_else(self, sso_client):
        other, _ = make_key("k1")  # same kid, different key
        assert me(sso_client, mint(key=other)).status_code == 401

    def test_unknown_kid(self, sso_client):
        assert me(sso_client, mint(kid="nope")).status_code == 401

    def test_alg_none(self, sso_client):
        now = int(time.time())
        t = jwt.encode({"iss": ISS, "sub": "u", "aud": "kerf-sabre", "exp": now + 99, "client_id": "kerf-editor", "roles": ["admin"]}, None, algorithm="none", headers={"kid": "k1"})
        assert me(sso_client, t).status_code == 401

    def test_hs256_with_the_public_key_as_secret(self, sso_client):
        now = int(time.time())
        t = jwt.encode({"iss": ISS, "sub": "u", "aud": "kerf-sabre", "exp": now + 99, "client_id": "kerf-editor", "roles": ["admin"]}, "secret" * 8, algorithm="HS256", headers={"kid": "k1"})
        assert me(sso_client, t).status_code == 401

    def test_garbage(self, sso_client):
        assert me(sso_client, "eyJhbGciOi.not.ajwt").status_code == 401

    def test_no_token_at_all(self, sso_client):
        assert sso_client.get("/api/v1/auth/me").status_code == 401


class TestKeys:
    def test_keys_are_cached(self, sso_client, jwks):
        for _ in range(3):
            assert me(sso_client, mint()).status_code == 200
        assert jwks.calls == 1

    def test_rotation_is_picked_up_on_an_unknown_kid(self, tmp_path):
        key2, jwk2 = make_key("k2")
        jwks = Jwks(JWK)
        t = [0.0]
        v = Verifier(Settings.from_env(data_dir=tmp_path, auth_mode="both", sso_issuer=ISS), fetch=jwks, clock=lambda: t[0])
        assert v.verify(mint())[1] == "u-123"
        jwks.keys = [jwk2, JWK]
        t[0] += 60  # past the "don't refetch too often" gap, inside the cache lifetime
        assert v.verify(mint(key=key2, kid="k2"))[1] == "u-123"
        assert jwks.calls == 2

    def test_unknown_kids_cannot_make_us_hammer_planner(self, tmp_path):
        jwks = Jwks(JWK)
        t = [0.0]
        v = Verifier(Settings.from_env(data_dir=tmp_path, auth_mode="both", sso_issuer=ISS), fetch=jwks, clock=lambda: t[0])
        v.verify(mint())
        for _ in range(20):
            with pytest.raises(Exception):
                v.verify(mint(kid="bogus"))
        assert jwks.calls == 1

    def test_planner_down_with_no_keys_is_503(self, sso_client, jwks):
        jwks.down = True
        r = me(sso_client, mint())
        assert r.status_code == 503 and r.json()["code"] == "sso_unavailable"

    def test_planner_down_after_keys_were_fetched_keeps_working(self, tmp_path):
        jwks = Jwks(JWK)
        t = [0.0]
        v = Verifier(Settings.from_env(data_dir=tmp_path, auth_mode="both", sso_issuer=ISS), fetch=jwks, clock=lambda: t[0])
        v.verify(mint())
        jwks.down = True
        t[0] += 3600  # the cache has expired and the refetch fails
        assert v.verify(mint())[1] == "u-123"


class TestModes:
    def test_pins_mode_refuses_jwts(self, client):
        r = client.get("/api/v1/auth/me", headers=auth(mint()))
        assert r.status_code == 401

    def test_config_in_pins_mode(self, client):
        assert client.get("/api/v1/auth/config").json() == {"mode": "pins", "sso": None}

    def test_config_in_both_mode(self, sso_client):
        c = sso_client.get("/api/v1/auth/config").json()
        assert c["mode"] == "both" and c["sso"]["authorizeUrl"] == f"{ISS}/oauth/authorize"
        assert c["sso"]["clientIds"] == {"editor": "kerf-editor", "admin": "kerf-admin"} and c["sso"]["scopes"] == ["profile"]

    def test_config_needs_no_token(self, sso_client):
        assert sso_client.get("/api/v1/auth/config").status_code == 200

    def test_planner_mode_has_no_pin_login(self, tmp_path):
        cfg = Settings.from_env(data_dir=tmp_path / "d", auth_mode="planner", sso_issuer=ISS)
        with TestClient(create_app(cfg)) as c:
            r = c.post("/api/v1/auth/login", json={"classCode": "9B", "pupilId": "P001", "pin": "00000"})
            assert r.status_code == 404 and r.json()["code"] == "sso_only"

    def test_both_mode_keeps_pin_login(self, sso_client):
        r = sso_client.post("/api/v1/auth/login", json={"classCode": "9B", "pupilId": "P001", "pin": "00000"})
        assert r.status_code == 401  # wrong, but it is the PIN check answering

    def test_bad_settings_are_refused_at_start(self, tmp_path):
        with pytest.raises(ValueError):
            create_app(Settings.from_env(data_dir=tmp_path, auth_mode="sometimes"))
        with pytest.raises(ValueError):
            create_app(Settings.from_env(data_dir=tmp_path, auth_mode="planner"))


# ------------------------------------------------ DINO is the only way in; technicians run the stations and nothing else

@pytest.fixture()
def planner_client(tmp_path, jwks):
    cfg = Settings.from_env(data_dir=tmp_path / "data", replace_old_sends=False, auth_mode="planner", sso_issuer=ISS, auto_approve_default=False)
    app = create_app(cfg)
    app.state.sso = Verifier(cfg, fetch=jwks)
    with TestClient(app) as c:
        # stored tokens made directly in the database, as an old install or someone with the database could have
        c.tokens = {r: issue_token(app.state.db, r, f"{r}-1") for r in ("pupil", "teacher", "admin", "station", "platform")}
        yield c


class TestOnlyDinoSignsPeopleIn:
    @pytest.mark.parametrize("role", ["pupil", "teacher", "admin"])
    def test_a_stored_people_token_is_refused(self, planner_client, role):
        assert planner_client.get("/api/v1/auth/me", headers=auth(planner_client.tokens[role])).status_code == 401

    @pytest.mark.parametrize("role", ["station", "platform"])
    def test_the_cutter_and_platform_tokens_still_work(self, planner_client, role):
        assert planner_client.get("/api/v1/auth/me", headers=auth(planner_client.tokens[role])).json()["role"] == role

    def test_class_code_and_pin_login_is_gone(self, planner_client):
        r = planner_client.post("/api/v1/auth/login", json={"classCode": "A", "pupilId": "P1", "pin": "12345"})
        assert r.status_code == 404 and r.json()["code"] == "sso_only"

    def test_only_station_tokens_can_be_made(self, planner_client, jwks):
        tok = mint(roles=["admin"])
        for role in ("teacher", "admin", "pupil", "technician"):
            r = planner_client.post("/api/v1/staff", json={"role": role, "id": "x1"}, headers=auth(tok))
            assert r.status_code == 422, role
        assert planner_client.post("/api/v1/staff", json={"role": "station", "id": "station-9"}, headers=auth(tok)).status_code == 201


class TestTechnician:
    def hdr(self):
        return auth(mint(roles=["technician"]))

    def test_can_see_and_run_the_station_side(self, planner_client):
        h = self.hdr()
        assert planner_client.get("/api/v1/stations", headers=h).status_code == 200
        assert planner_client.get("/api/v1/queue?station=station-1", headers=h).status_code == 200
        assert planner_client.get("/api/v1/presets", headers=h).status_code == 200

    def test_can_calibrate(self, planner_client):
        r = planner_client.post("/api/v1/stations/station-1/calibration-marks", json={"centerX": 100, "centerY": 100}, headers=self.hdr())
        assert r.status_code != 403

    @pytest.mark.parametrize("method,path", [("get", "/api/v1/classes"), ("get", "/api/v1/staff"), ("get", "/api/v1/school"), ("get", "/api/v1/pupils"),
                                             ("post", "/api/v1/schools"), ("get", "/api/v1/stations/station-1/logs")])
    def test_has_none_of_the_other_admin_pages(self, planner_client, method, path):
        r = getattr(planner_client, method)(path, headers=self.hdr())
        assert r.status_code in (403, 404, 405, 422) and r.status_code != 200, path


class TestTechnicianPicksAndRejects:
    @pytest.fixture()
    def tk(self, sso_app):
        return {"pupil": issue_token(sso_app.state.db, "pupil", "P001"), "teacher": issue_token(sso_app.state.db, "teacher", "T001")}

    def test_a_technician_rejects_a_waiting_file_with_a_note_the_pupil_sees(self, sso_client, tk):
        from .test_stations import approved_job
        jid = approved_job(sso_client, tk)
        r = sso_client.post(f"/api/v1/jobs/{jid}/reject", json={"reason": "Lines overlap"}, headers=auth(mint(roles=["technician"])))
        assert r.status_code == 200
        j = sso_client.get(f"/api/v1/jobs/{jid}", headers=auth(tk["pupil"])).json()
        assert j["status"] == "cancelled" and j["statusReason"] == "Rejected at the laser: Lines overlap"

    def test_a_note_is_required_and_a_pupil_cannot_reject(self, sso_client, tk):
        from .test_stations import approved_job
        jid = approved_job(sso_client, tk)
        assert sso_client.post(f"/api/v1/jobs/{jid}/reject", json={"reason": " "}, headers=auth(mint(roles=["technician"]))).status_code == 422
        assert sso_client.post(f"/api/v1/jobs/{jid}/reject", json={"reason": "x"}, headers=auth(mint(roles=["pupil"]))).status_code == 403

    def test_a_technician_cannot_reject_a_file_still_waiting_for_approval(self, sso_client, tk):
        from .test_jobs import post
        jid = post(sso_client, tk, status="submitted").json()["id"]
        assert sso_client.post(f"/api/v1/jobs/{jid}/reject", json={"reason": "x"}, headers=auth(mint(roles=["technician"]))).status_code == 409


class TestDisplayNames:
    """Option 2: a name taken from DINO's userinfo at sign-in is shown to staff of the same school, and only to them."""

    @pytest.fixture()
    def named(self, sso_app, jwks):
        sso_app.state.sso.fetch_userinfo = lambda url, token: {"sub": "u-123", "roles": ["pupil"], "name": "Sam Jones", "email": "sam@example.org"}
        return sso_app

    def test_the_profile_call_stores_the_name_not_the_email(self, named):
        with TestClient(named) as c:
            r = c.post("/api/v1/auth/profile", headers=auth(mint(roles=["pupil"])))
            assert r.json() == {"name": "Sam Jones"}
            from kerf_server.models import Person
            with named.state.db.session() as s:
                rows = s.query(Person).all()
                assert [(p.person_id, p.display_name) for p in rows] == [("u-123", "Sam Jones")]

    def test_staff_see_the_name_in_the_queue_but_other_pupils_do_not(self, named):
        from .test_stations import approved_job
        with TestClient(named) as c:
            tk = {"pupil": issue_token(named.state.db, "pupil", "P001"), "teacher": issue_token(named.state.db, "teacher", "T001")}
            named.state.sso.fetch_userinfo = lambda url, token: {"name": "Sam Jones"}
            assert c.post("/api/v1/auth/profile", headers=auth(mint(sub="P001", roles=["pupil"]))).json() == {"name": "Sam Jones"}
            approved_job(c, tk)
            staff = c.get("/api/v1/queue", headers=auth(mint(roles=["technician"]))).json()
            assert staff[0]["pupilName"] == "Sam Jones"
            other = issue_token(named.state.db, "pupil", "P999")
            assert "pupilName" not in c.get("/api/v1/queue", headers=auth(other)).json()[0]

    @pytest.mark.parametrize("bad", [None, "", "sam@example.org", 5, "   "])
    def test_a_missing_or_email_like_name_is_ignored(self, sso_app, bad):
        sso_app.state.sso.fetch_userinfo = lambda url, token: {"name": bad}
        with TestClient(sso_app) as c:
            assert c.post("/api/v1/auth/profile", headers=auth(mint(roles=["pupil"]))).json() == {"name": None}

    def test_dino_being_down_is_not_an_error(self, sso_app):
        def boom(url, token): raise OSError("down")
        sso_app.state.sso.fetch_userinfo = boom
        with TestClient(sso_app) as c:
            assert c.post("/api/v1/auth/profile", headers=auth(mint(roles=["pupil"]))).status_code == 200


def test_my_files_for_staff_lists_only_their_own(sso_client):
    from .test_jobs import post
    tk = {"pupil": issue_token(sso_client.app.state.db, "pupil", "P001"), "teacher": issue_token(sso_client.app.state.db, "teacher", "T001")}
    post(sso_client, tk, status="submitted")
    assert len(sso_client.get("/api/v1/jobs", headers=auth(tk["teacher"])).json()) == 1  # staff see every file in the school
    assert sso_client.get("/api/v1/jobs?mine=1", headers=auth(tk["teacher"])).json() == []  # but "my files" is only their own
    assert len(sso_client.get("/api/v1/jobs?mine=1", headers=auth(tk["pupil"])).json()) == 1
