import json

from kerf_server.admin import main as admin
from kerf_server.models import Token
from kerf_server.security import hash_token, issue_token

from .conftest import auth


def test_health_needs_no_token(client):
    assert client.get("/health").json()["status"] == "ok"


def test_me_reports_role_and_id(client, tokens):
    assert client.get("/api/v1/auth/me", headers=auth(tokens["pupil"])).json() == {"role": "pupil", "id": "P001"}
    assert client.get("/api/v1/auth/me", headers=auth(tokens["teacher"])).json() == {"role": "teacher", "id": "T001"}
    assert client.get("/api/v1/auth/me", headers=auth(tokens["station"])).json() == {"role": "station", "id": "station-1"}


def test_missing_or_bad_token_is_401_in_the_contract_error_shape(client, tokens):
    r = client.get("/api/v1/auth/me")
    assert r.status_code == 401
    assert set(r.json()) >= {"code", "message"} and r.json()["code"] == "unauthorized"
    assert client.get("/api/v1/auth/me", headers=auth("nope")).status_code == 401
    assert client.get("/api/v1/auth/me", headers={"Authorization": "Basic abc"}).status_code == 401


def test_tokens_are_stored_hashed_never_in_clear(client, app, tokens):
    with app.state.db.session() as s:
        stored = [t.token_hash for t in s.query(Token).all()]
    assert hash_token(tokens["pupil"]) in stored
    assert all(tokens["pupil"] not in h for h in stored)
    assert all(len(h) == 64 for h in stored)


def test_revoked_token_stops_working(client, app, tokens):
    with app.state.db.session() as s:
        for t in s.query(Token).filter(Token.subject_id == "P001"):
            t.revoked = True
    assert client.get("/api/v1/auth/me", headers=auth(tokens["pupil"])).status_code == 401
    assert client.get("/api/v1/auth/me", headers=auth(tokens["pupil2"])).status_code == 200


def test_ids_must_be_ids_not_names(app):
    import pytest

    db = app.state.db
    for bad in ["Ali Hassan", "", "x" * 65, "a/b", "J. Smith"]:
        with pytest.raises(ValueError):
            issue_token(db, "pupil", bad)
    with pytest.raises(ValueError):
        issue_token(db, "admin", "P1")


def test_unknown_route_uses_the_error_shape(client):
    r = client.get("/api/v1/nothing-here")
    assert r.status_code == 404 and r.json()["code"] == "not_found"


def test_admin_cli_creates_and_lists_tokens(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("KERF_DATA_DIR", str(tmp_path / "d"))
    assert admin(["create-token", "--role", "teacher", "--id", "T9"]) == 0
    token = capsys.readouterr().out.strip()
    assert token.startswith("kt_")
    admin(["list-tokens"])
    out = capsys.readouterr().out
    assert "T9" in out and token not in out  # the list never shows tokens
    admin(["revoke", "--id", "T9"])
    assert "Revoked 1" in capsys.readouterr().out


def test_admin_cli_imports_pupil_ids_from_a_csv(tmp_path, monkeypatch):
    monkeypatch.setenv("KERF_DATA_DIR", str(tmp_path / "d"))
    src = tmp_path / "pupils.csv"
    src.write_text("pupilId\nP101\nP102\nP103\n")
    out = tmp_path / "tokens.csv"
    admin(["import-pupils", str(src), "--out", str(out)])
    lines = out.read_text().splitlines()
    assert lines[0] == "pupilId,token" and len(lines) == 4
    assert lines[1].startswith("P101,kp_")
