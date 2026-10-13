from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from kerf_server.app import create_app
from kerf_server.config import Settings
from kerf_server.security import issue_token


@pytest.fixture()
def settings(tmp_path: Path) -> Settings:
    return Settings.from_env(data_dir=tmp_path / "data")


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
