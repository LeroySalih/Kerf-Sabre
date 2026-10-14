from __future__ import annotations

import pytest

from kerf_server.security import issue_token

from .conftest import auth
from .test_classes import login, setup_class_with
from .test_jobs import job_doc, rect_obj

API = "/api/v1"


def make(client, tokens, ids=("P001", "P002")):
    """A class with two pupils who can sign in; returns their session headers."""
    pins = setup_class_with(client, tokens, ids=ids)
    return {pid: auth(login(client, pid=pid, pin=pin).json()["token"]) for pid, pin in pins.items()}


def act(client, tokens, **body):
    body = {"title": "Cut a keyring", "instructions": "Design a keyring 60 x 30 mm.", "published": True, **body}
    r = client.post(f"{API}/classes/9B-DT/activities", json=body, headers=auth(tokens["teacher"]))
    assert r.status_code == 201, r.text
    return r.json()


def post_job(client, h, pupil, activity_id=None, status="draft"):
    doc = job_doc(pupil=pupil, status=status)
    if activity_id:
        doc["activityId"] = activity_id
    return client.post(f"{API}/jobs", json=doc, headers=h)


class TestTeacherSetsActivities:
    def test_create_edit_order_publish_archive(self, client, tokens):
        make(client, tokens)
        t = auth(tokens["teacher"])
        a = act(client, tokens, title="One", published=False, presetId="ply-3mm", dueAt="2026-11-05T15:00:00Z")
        b = act(client, tokens, title="Two")
        assert (a["position"], b["position"], a["published"], a["dueAt"]) == (1, 2, False, "2026-11-05T15:00:00Z")
        lst = client.get(f"{API}/classes/9B-DT/activities", headers=t).json()
        assert [x["title"] for x in lst] == ["One", "Two"] and lst[0]["counts"] == {"working": 0, "submitted": 0, "revise": 0, "complete": 0}
        r = client.put(f"{API}/classes/9B-DT/activities/{a['id']}", json={"title": "Uno", "published": True, "presetId": None}, headers=t)
        assert r.json()["title"] == "Uno" and r.json()["published"] is True and r.json()["presetId"] is None
        assert client.post(f"{API}/classes/9B-DT/activities-order", json={"ids": [b["id"], a["id"]]}, headers=t).json()[0]["id"] == b["id"]
        assert client.post(f"{API}/classes/9B-DT/activities-order", json={"ids": [b["id"]]}, headers=t).status_code == 422
        assert client.delete(f"{API}/classes/9B-DT/activities/{a['id']}", headers=t).status_code == 204
        assert [x["id"] for x in client.get(f"{API}/classes/9B-DT/activities", headers=t).json()] == [b["id"]]

    def test_validation(self, client, tokens):
        make(client, tokens)
        t = auth(tokens["teacher"])
        post = lambda body: client.post(f"{API}/classes/9B-DT/activities", json=body, headers=t)
        assert post({"title": "  "}).status_code == 422
        assert post({"title": "x", "presetId": "nope"}).json()["code"] == "unknown_preset"
        assert post({"title": "x", "dueAt": "soon"}).status_code == 422

    def test_only_the_classes_own_teacher(self, client, tokens, app):
        make(client, tokens)
        a = act(client, tokens)
        other = auth(issue_token(app.state.db, "teacher", "T002"))
        assert client.get(f"{API}/classes", headers=other).json() == []  # not their class
        for call in (lambda: client.get(f"{API}/classes/9B-DT/activities", headers=other), lambda: client.post(f"{API}/classes/9B-DT/activities", json={"title": "x"}, headers=other),
                     lambda: client.get(f"{API}/classes/9B-DT/progress", headers=other), lambda: client.get(f"{API}/classes/9B-DT/pupils", headers=other),
                     lambda: client.post(f"{API}/pupils/P001/reset-pin", headers=other), lambda: client.get(f"{API}/classes/9B-DT/pupils/P001/jobs", headers=other),
                     lambda: client.post(f"{API}/classes/9B-DT/activities/{a['id']}/work/P001/feedback", json={"text": "hi"}, headers=other)):
            assert call().status_code == 404
        for who in ("pupil", "station"):
            assert client.post(f"{API}/classes/9B-DT/activities", json={"title": "x"}, headers=auth(tokens[who])).status_code == 403


class TestPupilWorksThrough:
    def test_pupils_see_only_published_activities_of_their_own_class(self, client, tokens, app):
        h = make(client, tokens)
        act(client, tokens, title="Draft one", published=False)
        shown = act(client, tokens, title="Visible")
        t = auth(tokens["teacher"])
        client.post(f"{API}/classes", json={"code": "10A"}, headers=t)
        client.post(f"{API}/classes/10A/pupils", json={"pupilIds": ["P900"]}, headers=t)
        client.post(f"{API}/classes/10A/activities", json={"title": "Elsewhere", "published": True}, headers=t)
        mine = client.get(f"{API}/activities", headers=h["P001"]).json()
        assert [a["title"] for a in mine] == ["Visible"] and mine[0]["status"] == "todo" and mine[0]["jobId"] is None
        assert client.get(f"{API}/activities/{shown['id']}", headers=h["P001"]).status_code == 200
        ids = {a["title"]: a["id"] for a in client.get(f"{API}/classes/9B-DT/activities", headers=t).json()}
        assert client.get(f"{API}/activities/{ids['Draft one']}", headers=h["P001"]).status_code == 404
        # a pupil who signs in with an old-style token has no class and so no activities
        assert client.get(f"{API}/activities", headers=auth(issue_token(app.state.db, "pupil", "P777"))).json() == []

    def test_saving_a_file_for_an_activity_starts_the_work_and_handing_in_submits_it(self, client, tokens):
        h = make(client, tokens)
        a = act(client, tokens)
        assert client.post(f"{API}/activities/{a['id']}/submit", headers=h["P001"]).json()["code"] == "no_file"
        jid = post_job(client, h["P001"], "P001", a["id"]).json()["id"]
        assert client.get(f"{API}/jobs/{jid}", headers=h["P001"]).json()["activityId"] == a["id"]
        assert client.get(f"{API}/activities", headers=h["P001"]).json()[0]["status"] == "working"
        r = client.post(f"{API}/activities/{a['id']}/submit", headers=h["P001"]).json()
        assert (r["status"], r["jobId"]) == ("submitted", jid) and r["submittedAt"]
        j2 = post_job(client, h["P001"], "P001", a["id"]).json()["id"]
        assert client.post(f"{API}/activities/{a['id']}/submit", json={"jobId": j2}, headers=h["P001"]).json()["jobId"] == j2

    def test_cannot_use_an_activity_that_is_not_theirs_or_hand_in_someone_elses_file(self, client, tokens):
        h = make(client, tokens)
        a = act(client, tokens)
        draft = act(client, tokens, title="hidden", published=False)
        assert post_job(client, h["P001"], "P001", draft["id"]).json()["code"] == "unknown_activity" or post_job(client, h["P001"], "P001", draft["id"]).status_code in (404, 422)
        assert post_job(client, h["P001"], "P001", "act-nope").status_code in (404, 422)
        theirs = post_job(client, h["P002"], "P002", a["id"]).json()["id"]
        assert client.post(f"{API}/activities/{a['id']}/submit", json={"jobId": theirs}, headers=h["P001"]).status_code == 404

    def test_files_without_an_activity_still_work(self, client, tokens):
        h = make(client, tokens)
        assert post_job(client, h["P001"], "P001").status_code == 201


class TestFeedback:
    def setup(self, client, tokens):
        h = make(client, tokens)
        a = act(client, tokens)
        jid = post_job(client, h["P001"], "P001", a["id"]).json()["id"]
        client.post(f"{API}/activities/{a['id']}/submit", headers=h["P001"])
        return h, a, jid

    def test_teacher_sees_progress_files_and_gives_feedback_the_pupil_reads(self, client, tokens):
        h, a, jid = self.setup(client, tokens)
        t = auth(tokens["teacher"])
        prog = client.get(f"{API}/classes/9B-DT/progress", headers=t).json()
        assert [x["title"] for x in prog["activities"]] == ["Cut a keyring"]
        by = {p["pupilId"]: p["work"][a["id"]] for p in prog["pupils"]}
        assert by["P001"]["status"] == "submitted" and by["P001"]["jobId"] == jid and by["P002"]["status"] == "todo"
        w = client.get(f"{API}/classes/9B-DT/activities/{a['id']}/work/P001", headers=t).json()
        assert w["status"] == "submitted" and [f["id"] for f in w["files"]] == [jid]
        files = client.get(f"{API}/classes/9B-DT/pupils/P001/jobs", headers=t).json()
        assert [f["id"] for f in files] == [jid] and files[0]["objects"]
        r = client.post(f"{API}/classes/9B-DT/activities/{a['id']}/work/P001/feedback", json={"text": "Nice start. Make the hole bigger.", "outcome": "revise"}, headers=t)
        assert r.status_code == 201 and r.json()["teacherId"] == "T001" and r.json()["jobId"] == jid
        mine = client.get(f"{API}/activities/{a['id']}", headers=h["P001"]).json()
        assert mine["status"] == "revise" and [(f["text"], f["outcome"]) for f in mine["feedback"]] == [("Nice start. Make the hole bigger.", "revise")]
        assert client.get(f"{API}/activities", headers=h["P001"]).json()[0]["feedbackCount"] == 1
        assert client.get(f"{API}/activities/{a['id']}", headers=h["P002"]).json()["feedback"] == []  # others don't see it

    def test_revise_then_resubmit_then_complete(self, client, tokens):
        h, a, _ = self.setup(client, tokens)
        t = auth(tokens["teacher"])
        fb = f"{API}/classes/9B-DT/activities/{a['id']}/work/P001/feedback"
        client.post(fb, json={"text": "again", "outcome": "revise"}, headers=t)
        assert client.post(f"{API}/activities/{a['id']}/submit", headers=h["P001"]).json()["status"] == "submitted"
        client.post(fb, json={"text": "Great.", "outcome": "complete"}, headers=t)
        assert client.get(f"{API}/activities/{a['id']}", headers=h["P001"]).json()["status"] == "complete"
        assert client.post(f"{API}/activities/{a['id']}/submit", headers=h["P001"]).status_code == 409

    def test_a_plain_comment_does_not_change_the_status_and_needs_text(self, client, tokens):
        h, a, _ = self.setup(client, tokens)
        t = auth(tokens["teacher"])
        fb = f"{API}/classes/9B-DT/activities/{a['id']}/work/P001/feedback"
        assert client.post(fb, json={"text": ""}, headers=t).status_code == 422
        assert client.post(fb, json={"text": "ok", "outcome": "perfect"}, headers=t).status_code == 422
        client.post(fb, json={"text": "Good use of the grid."}, headers=t)
        assert client.get(f"{API}/activities/{a['id']}", headers=h["P001"]).json()["status"] == "submitted"
        assert client.post(f"{API}/classes/9B-DT/activities/{a['id']}/work/P404/feedback", json={"text": "x"}, headers=t).status_code == 404

    def test_pupils_cannot_give_feedback(self, client, tokens):
        h, a, _ = self.setup(client, tokens)
        assert client.post(f"{API}/classes/9B-DT/activities/{a['id']}/work/P001/feedback", json={"text": "x"}, headers=h["P002"]).status_code == 403

    def test_archiving_hides_the_activity_but_keeps_the_work(self, client, tokens, app):
        h, a, _ = self.setup(client, tokens)
        t = auth(tokens["teacher"])
        client.delete(f"{API}/classes/9B-DT/activities/{a['id']}", headers=t)
        assert client.get(f"{API}/activities", headers=h["P001"]).json() == []
        from sqlalchemy import select

        from kerf_server.models import ActivityWork

        with app.state.db.session() as s:
            assert s.scalar(select(ActivityWork).where(ActivityWork.activity_id == a["id"])) is not None


def test_an_old_database_gains_the_new_columns(tmp_path):
    import sqlite3

    from kerf_server.db import Database

    p = tmp_path / "old.db"
    c = sqlite3.connect(p)
    c.execute("create table classes (code varchar(32) primary key, label varchar(128), created_at datetime)")
    c.execute("insert into classes values ('9B','x','2026-01-01 00:00:00')")
    c.commit()
    c.close()
    db = Database(f"sqlite:///{p}")
    db.create_all()
    from sqlalchemy import select

    from kerf_server.models import SchoolClass

    with db.session() as s:
        row = s.scalar(select(SchoolClass))
        assert (row.code, row.label, row.teacher_id) == ("9B", "x", None)
