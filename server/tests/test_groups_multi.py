"""Groups (docs/ACCOUNTS.md, shared 0.2.42): a pupil in several groups, join codes unique per school and editable,
archived groups, and a free school's limits (20 groups, 50 pupils per group, 20 files per pupil)."""
from __future__ import annotations

from kerf_server.security import issue_token

from .conftest import auth
from .test_classes import login, setup_class_with
from .test_jobs import job_doc
from .test_plans import free  # noqa: F401  (fixture)

API = "/api/v1"


class TestSeveralGroups:
    def test_a_pupil_in_two_groups_signs_in_through_either_and_leaves_one(self, client, tokens):
        pins = setup_class_with(client, tokens, ids=("P001",))
        t = auth(tokens["teacher"])
        client.post(f"{API}/classes", json={"code": "ART"}, headers=t)
        assert client.post(f"{API}/classes/ART/pupils", json={"pupilIds": ["P001"]}, headers=t).json()["added"] == ["P001"]
        assert login(client, code="ART", pin=pins["P001"]).status_code == 200
        assert login(client, code="9B-DT", pin=pins["P001"]).status_code == 200
        pupils = client.get(f"{API}/classes/ART/pupils", headers=t).json()
        assert pupils[0]["groups"] == ["9B-DT", "ART"]
        assert [c["pupilCount"] for c in client.get(f"{API}/classes", headers=t).json()] == [1, 1]
        assert client.delete(f"{API}/classes/9B-DT/pupils/P001", headers=t).status_code == 204  # out of one group only
        assert login(client, code="9B-DT", pin=pins["P001"]).status_code == 401
        assert login(client, code="ART", pin=pins["P001"]).status_code == 200  # account and PIN kept
        assert client.delete(f"{API}/classes/ART/pupils/P001", headers=t).status_code == 204  # the last group: archived, not deleted
        assert login(client, code="ART", pin=pins["P001"]).status_code == 401
        assert [p["pupilId"] for p in client.get(f"{API}/pupils/archived", headers=t).json()] == ["P001"]

    def test_activities_of_every_group_are_shown(self, client, tokens):
        pins = setup_class_with(client, tokens, ids=("P001",))
        t = auth(tokens["teacher"])
        client.post(f"{API}/classes", json={"code": "ART"}, headers=t)
        client.post(f"{API}/classes/ART/pupils", json={"pupilIds": ["P001"]}, headers=t)
        for code in ("9B-DT", "ART"):
            client.post(f"{API}/classes/{code}/activities", json={"title": f"Task {code}", "published": True}, headers=t)
        pt = auth(login(client, code="ART", pin=pins["P001"]).json()["token"])
        assert sorted(a["classCode"] for a in client.get(f"{API}/activities", headers=pt).json()) == ["9B-DT", "ART"]
        assert len(client.get(f"{API}/classes/9B-DT/progress", headers=t).json()["pupils"]) == 1


class TestJoinCodes:
    def test_kerf_makes_a_code_and_the_join_code_can_be_changed(self, client, tokens):
        t = auth(tokens["teacher"])
        g = client.post(f"{API}/classes", json={"label": "Year 7"}, headers=t).json()
        assert len(g["code"]) == 5 and g["joinCode"] == g["code"]
        r = client.put(f"{API}/classes/{g['code']}", json={"joinCode": "y7-dt"}, headers=t)
        assert r.status_code == 200 and r.json()["joinCode"] == "Y7-DT" and r.json()["code"] == g["code"]

    def test_join_codes_are_unique_in_a_school(self, client, tokens):
        t = auth(tokens["teacher"])
        client.post(f"{API}/classes", json={"code": "9A"}, headers=t)
        assert client.post(f"{API}/classes", json={"code": "9B", "joinCode": "9a"}, headers=t).status_code == 409
        client.post(f"{API}/classes", json={"code": "9B"}, headers=t)
        assert client.put(f"{API}/classes/9B", json={"joinCode": "9A"}, headers=t).status_code == 409
        assert client.put(f"{API}/classes/9B", json={"joinCode": "bad code!"}, headers=t).status_code == 422


class TestArchive:
    def test_an_archived_group_is_hidden_and_cannot_be_signed_in_through(self, client, tokens):
        pins = setup_class_with(client, tokens, ids=("P001",))
        t = auth(tokens["teacher"])
        r = client.put(f"{API}/classes/9B-DT", json={"archived": True, "label": "Y10 set 2"}, headers=t)
        assert r.status_code == 200 and r.json()["archived"] is True and r.json()["label"] == "Y10 set 2"
        assert client.get(f"{API}/classes", headers=t).json() == []
        assert [c["code"] for c in client.get(f"{API}/classes?archived=true", headers=t).json()] == ["9B-DT"]
        assert login(client, pin=pins["P001"]).status_code == 401
        client.put(f"{API}/classes/9B-DT", json={"archived": False}, headers=t)
        assert login(client, pin=pins["P001"]).status_code == 200


class TestFreeLimits:
    def test_twenty_groups(self, client, free):  # noqa: F811
        for i in range(20):
            assert client.post(f"{API}/classes", json={"code": f"WF{i}"}, headers=free["teacher"]).status_code == 201
        r = client.post(f"{API}/classes", json={"code": "WF20"}, headers=free["teacher"])
        assert r.status_code == 409 and r.json()["code"] == "limit_reached" and "20 groups" in r.json()["message"]
        client.put(f"{API}/classes/WF0", json={"archived": True}, headers=free["teacher"])  # archived groups do not count
        assert client.post(f"{API}/classes", json={"code": "WF20"}, headers=free["teacher"]).status_code == 201
        assert client.put(f"{API}/classes/WF0", json={"archived": False}, headers=free["teacher"]).json()["code"] == "limit_reached"

    def test_fifty_pupils_per_group_nothing_added_past_it(self, client, free):  # noqa: F811
        t = free["teacher"]
        client.post(f"{API}/classes", json={"code": "WFA"}, headers=t)
        assert client.post(f"{API}/classes/WFA/pupils", json={"pupilIds": [f"W{i:03}" for i in range(45)]}, headers=t).status_code == 201
        r = client.post(f"{API}/classes/WFA/pupils", json={"pupilIds": [f"W{i:03}" for i in range(40, 51)]}, headers=t)
        assert r.status_code == 409 and r.json()["code"] == "limit_reached" and "would make 51" in r.json()["message"]
        assert len(client.get(f"{API}/classes/WFA/pupils", headers=t).json()) == 45

    def test_twenty_files_per_pupil(self, client, free):  # noqa: F811
        for _ in range(20):
            assert client.post(f"{API}/jobs", json=job_doc(pupil="pupil-wf"), headers=free["pupil"]).status_code == 201
        r = client.post(f"{API}/jobs", json=job_doc(pupil="pupil-wf"), headers=free["pupil"])
        assert r.status_code == 409 and r.json()["code"] == "limit_reached" and "20 files per pupil" in r.json()["message"]

    def test_a_paid_school_has_no_limits(self, client, tokens):
        t = auth(tokens["teacher"])
        for i in range(21):
            assert client.post(f"{API}/classes", json={"code": f"G{i}"}, headers=t).status_code == 201


class TestArchivedPupils:
    def _archived_with_a_file(self, client, tokens):
        pins = setup_class_with(client, tokens, ids=("P001",))
        t = auth(tokens["teacher"])
        pt = auth(login(client, pin=pins["P001"]).json()["token"])
        jid = client.post(f"{API}/jobs", json=job_doc(pupil="P001"), headers=pt).json()["id"]
        client.delete(f"{API}/classes/9B-DT/pupils/P001", headers=t)
        return pins, t, pt, jid

    def test_archived_pupils_keep_their_files_and_come_back_when_added(self, client, tokens):
        pins, t, pt, jid = self._archived_with_a_file(client, tokens)
        assert client.get(f"{API}/jobs/{jid}", headers=pt).status_code == 401  # signed out
        assert client.get(f"{API}/jobs/{jid}", headers=t).status_code == 200  # the file is kept
        r = client.post(f"{API}/classes/9B-DT/pupils", json={"pupilIds": ["P001"]}, headers=t).json()
        assert r["restored"] == ["P001"] and r["created"] == []
        assert login(client, pin=pins["P001"]).status_code == 200  # same PIN
        assert client.get(f"{API}/pupils/archived", headers=t).json() == []

    def test_only_an_admin_deletes_for_good_only_when_archived_and_it_is_logged(self, client, tokens, app):
        from kerf_server.models import AuditEvent

        pins, t, pt, jid = self._archived_with_a_file(client, tokens)
        assert client.delete(f"{API}/pupils/P001", headers=t).status_code == 403  # a teacher cannot
        admin = auth(issue_token(app.state.db, "admin", "A001"))
        setup_class_with(client, tokens, ids=("P002",), code="9C")
        assert client.delete(f"{API}/pupils/P002", headers=admin).json()["code"] == "not_archived"
        r = client.delete(f"{API}/pupils/P001", headers=admin)
        assert r.status_code == 200 and r.json()["filesDeleted"] == 1
        assert client.get(f"{API}/jobs/{jid}", headers=t).status_code == 404
        assert client.get(f"{API}/pupils/archived", headers=t).json() == []
        with app.state.db.session() as s:
            ev = s.query(AuditEvent).one()
            assert (ev.action, ev.subject_id, ev.actor_id) == ("pupil_deleted", "P001", "A001")


class TestGroupsOnQueueAndFiles:
    def test_staff_see_each_pupils_groups_pupils_do_not(self, client, tokens):
        pins = setup_class_with(client, tokens, ids=("P001",))
        t = auth(tokens["teacher"])
        client.post(f"{API}/classes", json={"code": "ART", "label": "Year 9 art"}, headers=t)
        client.post(f"{API}/classes/ART/pupils", json={"pupilIds": ["P001"]}, headers=t)
        pt = auth(login(client, pin=pins["P001"]).json()["token"])
        jid = client.post(f"{API}/jobs", json=job_doc(pupil="P001", status="submitted"), headers=pt).json()["id"]
        client.post(f"{API}/jobs/{jid}/approve", json={}, headers=t)
        want = [{"code": "9B-DT", "label": "Y9 set 2"}, {"code": "ART", "label": "Year 9 art"}]
        q = client.get(f"{API}/queue", headers=t).json()
        assert q[0]["pupilGroups"] == want
        assert [j["pupilGroups"] for j in client.get(f"{API}/jobs", headers=t).json()] == [want]
        assert "pupilGroups" not in client.get(f"{API}/queue", headers=pt).json()[0]
        assert "pupilGroups" not in client.get(f"{API}/jobs", headers=pt).json()[0]
