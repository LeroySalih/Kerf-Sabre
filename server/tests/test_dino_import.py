"""Import DINO classes as Kerf groups and re-sync them (shared 0.2.42)."""
from __future__ import annotations

from fastapi.testclient import TestClient

from kerf_server.security import issue_token

from .conftest import auth
from .test_sso import jwks, mint, sso_app  # noqa: F401  (fixtures)

API = "/api/v1"


def dino(app, classes):
    app.state.sso.fetch_userinfo = lambda url, token: {"groups": classes}


CLASSES = [{"id": "26-11-DT", "name": "26-11-DT", "subject": "Design Technology", "yearGroup": "11", "pupils": ["P1", "P2"]},
           {"id": "25-10-EN1", "name": "25-10-EN1", "pupils": ["P3"]}]


class TestImport:
    def test_a_teacher_imports_their_classes_with_pupils(self, sso_app):  # noqa: F811
        dino(sso_app, CLASSES)
        with TestClient(sso_app) as c:
            t = auth(mint(sub="T1", roles=["teacher"]))
            listed = c.get(f"{API}/dino/classes", headers=t).json()
            assert [(x["id"], x["pupilCount"], x["importedAs"]) for x in listed] == [("25-10-EN1", 1, None), ("26-11-DT", 2, None)]
            r = c.post(f"{API}/dino/classes/import", json={"ids": ["26-11-DT"]}, headers=t)
            assert r.status_code == 201 and r.json()[0]["pupils"] == 2
            code = r.json()[0]["code"]
            g = next(x for x in c.get(f"{API}/classes", headers=t).json() if x["code"] == code)
            assert g["label"] == "26-11-DT · Design Technology" and g["source"] == "dino" and g["teacherId"] == "T1" and g["pupilCount"] == 2
            assert c.get(f"{API}/dino/classes", headers=t).json()[1]["importedAs"] == code
            again = c.post(f"{API}/dino/classes/import", json={"ids": ["26-11-DT"]}, headers=t).json()[0]
            assert again["already"] is True and again["code"] == code  # not imported twice
            assert c.post(f"{API}/dino/classes/import", json={"ids": ["not-mine"]}, headers=t).status_code == 404

    def test_resync_shows_the_changes_first_and_removes_from_the_group_only(self, sso_app):  # noqa: F811
        dino(sso_app, CLASSES)
        with TestClient(sso_app) as c:
            t = auth(mint(sub="T1", roles=["teacher"]))
            code = c.post(f"{API}/dino/classes/import", json={"ids": ["26-11-DT"]}, headers=t).json()[0]["code"]
            dino(sso_app, [{**CLASSES[0], "pupils": ["P2", "P4"]}])
            preview = c.post(f"{API}/classes/{code}/dino-sync", json={}, headers=t).json()
            assert (preview["add"], preview["remove"], preview["applied"]) == (["P4"], ["P1"], False)
            assert {p["pupilId"] for p in c.get(f"{API}/classes/{code}/pupils", headers=t).json()} == {"P1", "P2"}  # nothing changed yet
            done = c.post(f"{API}/classes/{code}/dino-sync", json={"apply": True}, headers=t).json()
            assert done["applied"] is True
            assert {p["pupilId"] for p in c.get(f"{API}/classes/{code}/pupils", headers=t).json()} == {"P2", "P4"}
            assert [p["pupilId"] for p in c.get(f"{API}/pupils/archived", headers=t).json()] == ["P1"]  # kept, archived (no other group)

    def test_needs_a_dino_sign_in_and_stays_in_the_school(self, sso_app):  # noqa: F811
        dino(sso_app, CLASSES)
        with TestClient(sso_app) as c:
            stored = auth(issue_token(sso_app.state.db, "teacher", "T9"))
            assert c.get(f"{API}/dino/classes", headers=stored).json()["code"] == "dino_needed"
            assert c.get(f"{API}/dino/classes", headers=auth(mint(sub="P1", roles=["pupil"]))).status_code == 403
            t1 = auth(mint(sub="T1", roles=["teacher"]))
            code = c.post(f"{API}/dino/classes/import", json={"ids": ["25-10-EN1"]}, headers=t1).json()[0]["code"]
            other = auth(mint(sub="T2", roles=["teacher"]))  # another teacher (the group is T1's)
            assert c.post(f"{API}/classes/{code}/dino-sync", json={}, headers=other).status_code == 404
            plain = c.post(f"{API}/classes", json={"code": "PLAIN"}, headers=t1).json()["code"]
            assert c.post(f"{API}/classes/{plain}/dino-sync", json={}, headers=t1).json()["code"] == "not_linked"

    def test_dino_down_is_a_clear_502(self, sso_app):  # noqa: F811
        def down(url, token):
            raise OSError("down")
        sso_app.state.sso.fetch_userinfo = down
        with TestClient(sso_app) as c:
            assert c.get(f"{API}/dino/classes", headers=auth(mint(sub="T1", roles=["teacher"]))).json()["code"] == "groups_unavailable"
