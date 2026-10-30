from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from kerf_server.app import create_app
from kerf_server.config import Settings
from kerf_server.security import issue_token


@pytest.fixture()
def settings(tmp_path: Path) -> Settings:
    # most tests put several files from the same pupil in the queue; TestANewSendReplacesTheOldOne turns replacement on
    return Settings.from_env(data_dir=tmp_path / "data", replace_old_sends=False, auth_mode="pins", auto_approve_default=False)  # the tests sign in with stored tokens; test_sso.py covers DINO


@pytest.fixture()
def app(settings: Settings):
    return create_app(settings)


@pytest.fixture()
def client(app):
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def tokens(client, app) -> dict[str, str]:
    db = app.state.db
    return {
        "pupil": issue_token(db, "pupil", "P001"),
        "pupil2": issue_token(db, "pupil", "P002"),
        "teacher": issue_token(db, "teacher", "T001"),
        "station": issue_token(db, "station", "station-1"),
    }


def auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture(autouse=True)
def _stored_tokens_for_tests(monkeypatch):
    """A running server is DINO-only by default; most tests (and the kerf-admin CLI they run) use stored tokens. test_sso.py asks for DINO itself."""
    monkeypatch.setenv("KERF_AUTH_MODE", "pins")
