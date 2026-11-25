"""Import DINO classes as Kerf groups and re-sync them (shared 0.2.47)."""
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
            assert code == "26-11-DT"  # the DINO class id is the group's code
            g = next(x for x in c.get(f"{API}/classes", headers=t).json() if x["code"] == code)
            assert g["joinCode"] is None  # no join code: its pupils come from DINO
            assert c.put(f"{API}/classes/{code}", json={"joinCode": "X1"}, headers=t).json()["code"] == "dino_group"
            assert c.post(f"{API}/groups/join", json={"groupCode": code}, headers=auth(mint(sub="P9", roles=["pupil"]))).status_code == 404
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


class TestCodesAndNames:
    def test_a_code_already_used_elsewhere_falls_back_to_one_kerf_makes(self, sso_app):  # noqa: F811
        dino(sso_app, CLASSES)
        with TestClient(sso_app) as c:
            root = auth(issue_token(sso_app.state.db, "platform", "root"))
            c.post(f"{API}/schools", json={"id": "eastfield", "name": "Eastfield"}, headers=root)
            other = auth(issue_token(sso_app.state.db, "teacher", "E1", school="eastfield"))
            assert c.post(f"{API}/classes", json={"code": "26-11-DT"}, headers=other).status_code == 201  # another school has it
            code = c.post(f"{API}/dino/classes/import", json={"ids": ["26-11-DT"]}, headers=auth(mint(sub="T1", roles=["teacher"]))).json()[0]["code"]
            assert code != "26-11-DT" and len(code) == 5

    def test_groups_imported_before_get_the_dino_id_at_start_up_with_everything_moved(self, sso_app):  # noqa: F811
        from kerf_server import services_classes as sc
        from kerf_server.services_dinoimport import ensure_dino_codes

        dino(sso_app, CLASSES)
        with TestClient(sso_app) as c:
            t = auth(mint(sub="T1", roles=["teacher"]))
            with sso_app.state.db.session() as s:  # as the first version imported it: a code Kerf made up
                g = sc.create_class(s, "ABCDE", "26-11-DT · Design Technology", teacher_id="T1", school="main", source="dino", source_id="26-11-DT")
                sc.add_pupils(s, g.code, ["P1", "P2"], school="main", from_dino=True)
            act = c.post(f"{API}/classes/ABCDE/activities", json={"title": "Name plate", "published": True}, headers=t)
            assert act.status_code == 201, act.text
            with sso_app.state.db.session() as s:
                ensure_dino_codes(s)
            assert [x["code"] for x in c.get(f"{API}/classes", headers=t).json()] == ["26-11-DT"]
            assert {p["pupilId"] for p in c.get(f"{API}/classes/26-11-DT/pupils", headers=t).json()} == {"P1", "P2"}
            assert [a["title"] for a in c.get(f"{API}/classes/26-11-DT/activities", headers=t).json()] == ["Name plate"]
            assert c.get(f"{API}/classes/ABCDE/pupils", headers=t).status_code == 404
            preview = c.post(f"{API}/classes/26-11-DT/dino-sync", json={}, headers=t).json()
            assert (preview["add"], preview["remove"]) == ([], [])  # still linked to its DINO class

    def test_the_teacher_is_shown_by_name(self, sso_app):  # noqa: F811
        from kerf_server import services_people as people

        dino(sso_app, CLASSES)
        with TestClient(sso_app) as c:
            t = auth(mint(sub="T1", roles=["teacher"]))
            c.post(f"{API}/dino/classes/import", json={"ids": ["25-10-EN1"]}, headers=t)
            assert c.get(f"{API}/classes", headers=t).json()[0]["teacherName"] is None  # Kerf has no name for them yet
            with sso_app.state.db.session() as s:
                people.remember(s, "T1", "main", "Leroy Salih")
            assert c.get(f"{API}/classes", headers=t).json()[0]["teacherName"] == "Leroy Salih"


def test_a_dino_group_only_changes_through_sync_except_archiving(sso_app):  # noqa: F811
    dino(sso_app, CLASSES)
    with TestClient(sso_app) as c:
        t = auth(mint(sub="T1", roles=["teacher"]))
        code = c.post(f"{API}/dino/classes/import", json={"ids": ["26-11-DT"]}, headers=t).json()[0]["code"]
        refused = [
            c.put(f"{API}/classes/{code}", json={"label": "renamed"}, headers=t),
            c.post(f"{API}/classes/{code}/pupils", json={"pupilIds": ["P9"]}, headers=t),
            c.delete(f"{API}/classes/{code}/pupils/P1", headers=t),
            c.put(f"{API}/classes/{code}/pupils/P1", json={"displayName": "x"}, headers=t),
            c.post(f"{API}/classes/{code}/passwords", json={}, headers=t),
        ]
        assert [(r.status_code, r.json()["code"]) for r in refused] == [(409, "dino_group")] * 5
        assert c.put(f"{API}/classes/{code}", json={"requireApproval": False}, headers=t).status_code == 200  # Kerf's own settings
        assert c.put(f"{API}/classes/{code}", json={"archived": True}, headers=t).json()["archived"] is True


def test_auth_me_carries_a_staff_members_own_name(sso_app):  # noqa: F811
    from kerf_server import services_people as people

    with TestClient(sso_app) as c:
        with sso_app.state.db.session() as s:
            people.remember(s, "T1", "main", "Leroy Salih")
            people.remember(s, "P1", "main", "Zoe Adams")
        assert c.get(f"{API}/auth/me", headers=auth(mint(sub="T1", roles=["admin"]))).json()["name"] == "Leroy Salih"
        assert c.get(f"{API}/auth/me", headers=auth(mint(sub="P1", roles=["pupil"]))).json()["name"] is None  # never for pupils


def test_pupil_names_from_dino_are_kept_for_staff(sso_app):  # noqa: F811
    with_names = [{"id": "26-11-DT", "name": "26-11-DT", "pupils": [{"id": "P1", "name": "Zoë Adams"}, "P2", {"id": "bad id", "name": "x"}]}]
    dino(sso_app, with_names)
    with TestClient(sso_app) as c:
        t = auth(mint(sub="T1", roles=["teacher"]))
        assert c.get(f"{API}/groups", headers=t).json()[0] == {"id": "26-11-DT", "name": "26-11-DT", "subject": None, "yearGroup": None, "pupils": ["P1", "P2"]}  # IDs only there
        code = c.post(f"{API}/dino/classes/import", json={"ids": ["26-11-DT"]}, headers=t).json()[0]["code"]
        names = {p["pupilId"]: p.get("displayName") for p in c.get(f"{API}/classes/{code}/pupils", headers=t).json()}
        assert names == {"P1": "Zoë Adams", "P2": None}
        dino(sso_app, [{**with_names[0], "pupils": [{"id": "P1", "name": "Zoë Adams"}, {"id": "P2", "name": "Ben Cole"}]}])
        c.post(f"{API}/classes/{code}/dino-sync", json={"apply": True}, headers=t)  # sync picks up names too
        names = {p["pupilId"]: p.get("displayName") for p in c.get(f"{API}/classes/{code}/pupils", headers=t).json()}
        assert names == {"P1": "Zoë Adams", "P2": "Ben Cole"}
