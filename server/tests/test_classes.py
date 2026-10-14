from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from kerf_server.app import create_app
from kerf_server.config import Settings

from .conftest import auth
from .test_jobs import job_doc

API = "/api/v1"


def setup_class_with(client, tokens, ids=("P001", "P002"), code="9B-DT"):
    t = auth(tokens["teacher"])
    assert client.post(f"{API}/classes", json={"code": code, "label": "Y9 set 2"}, headers=t).status_code == 201
    r = client.post(f"{API}/classes/{code}/pupils", json={"pupilIds": list(ids)}, headers=t)
    assert r.status_code == 201, r.text
    return {c["pupilId"]: c["pin"] for c in r.json()["created"]}


def login(client, code="9B-DT", pid="P001", pin="00000"):
    return client.post(f"{API}/auth/login", json={"classCode": code, "pupilId": pid, "pin": pin})


class TestLogin:
    def test_pupil_logs_in_and_works_like_any_pupil(self, client, tokens):
        pins = setup_class_with(client, tokens)
        assert all(len(p) == 5 and p.isdigit() for p in pins.values())
        r = login(client, pin=pins["P001"])
        assert r.status_code == 200, r.text
        body = r.json()
        assert (body["role"], body["id"], body["classCode"]) == ("pupil", "P001", "9B-DT") and body["token"].startswith("kp_")
        h = auth(body["token"])
        assert client.get(f"{API}/auth/me", headers=h).json() == {"role": "pupil", "id": "P001", "school": "main"}
        assert client.post(f"{API}/jobs", json=job_doc(pupil="P001"), headers=h).status_code == 201
        assert client.post(f"{API}/jobs", json=job_doc(pupil="P002"), headers=h).status_code == 403  # still only their own

    def test_class_code_and_id_are_not_case_sensitive_about_the_code(self, client, tokens):
        pins = setup_class_with(client, tokens)
        assert login(client, code=" 9b-dt ", pin=pins["P001"]).status_code == 200

    def test_wrong_class_id_or_pin_all_look_the_same(self, client, tokens):
        pins = setup_class_with(client, tokens)
        bad = [login(client, code="9C", pin=pins["P001"]), login(client, pid="P999", pin=pins["P001"]), login(client, pin="99999" if pins["P001"] != "99999" else "11111")]
        assert [b.status_code for b in bad] == [401, 401, 401]
        assert len({b.json()["message"] for b in bad}) == 1 and bad[0].json()["code"] == "bad_login"

    def test_pupil_in_another_class_cannot_use_this_class_code(self, client, tokens):
        pins = setup_class_with(client, tokens)
        t = auth(tokens["teacher"])
        client.post(f"{API}/classes", json={"code": "10A"}, headers=t)
        assert login(client, code="10A", pin=pins["P001"]).status_code == 401

    def test_missing_fields(self, client, tokens):
        assert client.post(f"{API}/auth/login", json={"classCode": "x"}).status_code == 422

    def test_locks_out_after_repeated_wrong_pins_and_a_right_pin_does_not_get_through_while_locked(self, client, tokens):
        pins = setup_class_with(client, tokens)
        for _ in range(5):
            assert login(client, pin="x").status_code == 401
        r = login(client, pin=pins["P001"])
        assert r.status_code == 429 and r.json()["code"] == "locked"
        assert login(client, pid="P002", pin=pins["P002"]).status_code == 200  # others are unaffected

    def test_a_right_pin_resets_the_count(self, client, tokens):
        pins = setup_class_with(client, tokens)
        for _ in range(4):
            login(client, pin="x")
        assert login(client, pin=pins["P001"]).status_code == 200
        for _ in range(4):
            login(client, pin="x")
        assert login(client, pin=pins["P001"]).status_code == 200  # four more wrong would not have locked: the count restarted

    def test_lockout_ends(self, tmp_path):
        app = create_app(Settings.from_env(data_dir=tmp_path / "d", login_lockout_minutes=0.001))
        from kerf_server.security import issue_token

        with TestClient(app) as c:
            tk = issue_token(app.state.db, "teacher", "T1")
            pins = setup_class_with(c, {"teacher": tk})
            for _ in range(5):
                login(c, pin="x")
            assert login(c, pin=pins["P001"]).status_code == 429
            import time

            time.sleep(0.2)
            assert login(c, pin=pins["P001"]).status_code == 200

    def test_too_many_failures_from_one_address_slow_everyone_down(self, tmp_path):
        app = create_app(Settings.from_env(data_dir=tmp_path / "d", login_ip_failures=3))
        with TestClient(app) as c:
            for i in range(3):
                assert login(c, pid=f"P{i}").status_code == 401
            r = login(c, pid="P9")
            assert r.status_code == 429 and r.json()["code"] == "too_many_attempts"


class TestSessions:
    def test_logout_ends_the_session(self, client, tokens):
        pins = setup_class_with(client, tokens)
        h = auth(login(client, pin=pins["P001"]).json()["token"])
        assert client.post(f"{API}/auth/logout", headers=h).status_code == 204
        assert client.get(f"{API}/auth/me", headers=h).status_code == 401

    def test_logout_does_not_kill_an_administrators_token(self, client, tokens):
        assert client.post(f"{API}/auth/logout", headers=auth(tokens["pupil"])).status_code == 204
        assert client.get(f"{API}/auth/me", headers=auth(tokens["pupil"])).status_code == 200

    def test_sessions_expire(self, tmp_path):
        app = create_app(Settings.from_env(data_dir=tmp_path / "d", session_hours=0.00005))  # 0.18 s
        from kerf_server.security import issue_token

        with TestClient(app) as c:
            pins = setup_class_with(c, {"teacher": issue_token(app.state.db, "teacher", "T1")})
            h = auth(login(c, pin=pins["P001"]).json()["token"])
            assert c.get(f"{API}/auth/me", headers=h).status_code == 200
            import time

            time.sleep(0.4)
            assert c.get(f"{API}/auth/me", headers=h).status_code == 401


class TestTeacherSide:
    def test_only_teachers_manage_classes(self, client, tokens):
        for who in ("pupil", "station"):
            h = auth(tokens[who])
            assert client.get(f"{API}/classes", headers=h).status_code == 403
            assert client.post(f"{API}/classes", json={"code": "X"}, headers=h).status_code == 403
            assert client.post(f"{API}/pupils/P001/reset-pin", headers=h).status_code == 403

    def test_classes_pupils_and_counts(self, client, tokens):
        setup_class_with(client, tokens, ids=("P001", "P002", "P003"))
        t = auth(tokens["teacher"])
        assert client.get(f"{API}/classes", headers=t).json() == [{"code": "9B-DT", "label": "Y9 set 2", "teacherId": "T001", "pupilCount": 3, "requireApproval": True}]
        listing = client.get(f"{API}/classes/9b-dt/pupils", headers=t).json()
        assert [p["pupilId"] for p in listing] == ["P001", "P002", "P003"] and "pin" not in str(listing)
        assert client.post(f"{API}/classes", json={"code": "9b-dt"}, headers=t).status_code == 409
        assert client.post(f"{API}/classes", json={"code": "bad code!"}, headers=t).status_code == 422

    def test_adding_again_keeps_pins_and_reports_conflicts(self, client, tokens):
        pins = setup_class_with(client, tokens)
        t = auth(tokens["teacher"])
        client.post(f"{API}/classes", json={"code": "10A"}, headers=t)
        r = client.post(f"{API}/classes/10A/pupils", json={"pupilIds": ["P002", "P010"]}, headers=t).json()
        assert [c["pupilId"] for c in r["created"]] == ["P010"] and r["conflicts"] == ["P002"] and r["existing"] == []
        again = client.post(f"{API}/classes/9B-DT/pupils", json={"pupilIds": ["P001", "P003"]}, headers=t).json()
        assert again["existing"] == ["P001"] and [c["pupilId"] for c in again["created"]] == ["P003"]
        assert login(client, pin=pins["P001"]).status_code == 200  # the first PIN still works

    def test_ids_not_names(self, client, tokens):
        t = auth(tokens["teacher"])
        client.post(f"{API}/classes", json={"code": "9B"}, headers=t)
        r = client.post(f"{API}/classes/9B/pupils", json={"pupilIds": ["Jane Smith"]}, headers=t)
        assert r.status_code == 422
        assert client.post(f"{API}/classes/9B/pupils", json={"pupilIds": []}, headers=t).status_code == 422
        assert client.post(f"{API}/classes/NOPE/pupils", json={"pupilIds": ["P1"]}, headers=t).status_code == 404

    def test_reset_pin_gives_a_new_pin_clears_lock_and_ends_sessions(self, client, tokens):
        pins = setup_class_with(client, tokens)
        h = auth(login(client, pin=pins["P001"]).json()["token"])
        for _ in range(5):
            login(client, pin="x")
        r = client.post(f"{API}/pupils/P001/reset-pin", headers=auth(tokens["teacher"]))
        new = r.json()["pin"]
        assert new != pins["P001"] and len(new) == 5
        assert client.get(f"{API}/auth/me", headers=h).status_code == 401  # old session ended
        assert login(client, pin=pins["P001"]).status_code == 401
        assert login(client, pin=new).status_code == 200
        assert client.post(f"{API}/pupils/P404/reset-pin", headers=auth(tokens["teacher"])).status_code == 404

    def test_removing_a_pupil_ends_their_sessions_and_login(self, client, tokens):
        pins = setup_class_with(client, tokens)
        h = auth(login(client, pin=pins["P001"]).json()["token"])
        t = auth(tokens["teacher"])
        assert client.delete(f"{API}/classes/9B-DT/pupils/P001", headers=t).status_code == 204
        assert client.get(f"{API}/auth/me", headers=h).status_code == 401
        assert login(client, pin=pins["P001"]).status_code == 401
        assert client.delete(f"{API}/classes/9B-DT/pupils/P001", headers=t).status_code == 404

    def test_pins_are_stored_hashed(self, client, tokens, app):
        from sqlalchemy import select

        from kerf_server.models import Pupil

        pins = setup_class_with(client, tokens)
        with app.state.db.session() as s:
            stored = s.scalar(select(Pupil.pin_hash).where(Pupil.pupil_id == "P001"))
        assert pins["P001"] not in stored and stored.startswith("scrypt$")


class TestApprovalPerClass:
    """A class can be set to skip teacher approval (e.g. Year 10) while another still needs it (e.g. Year 7)."""

    def submit_as(self, client, tokens, code, pid):
        pins = setup_class_with(client, tokens, ids=(pid,), code=code)
        h = auth(login(client, code=code, pid=pid, pin=pins[pid]).json()["token"])
        jid = client.post(f"{API}/jobs", json=job_doc(pupil=pid), headers=h).json()["id"]
        return client.post(f"{API}/jobs/{jid}/submit", headers=h).json()

    def test_classes_need_approval_by_default(self, client, tokens):
        client.post(f"{API}/classes", json={"code": "Y7"}, headers=auth(tokens["teacher"]))
        assert client.get(f"{API}/classes", headers=auth(tokens["teacher"])).json()[0]["requireApproval"] is True
        assert self.submit_as(client, tokens, "Y7B", "P101")["status"] == "submitted"

    def test_a_class_set_to_skip_approval_goes_straight_to_the_queue(self, client, tokens):
        t = auth(tokens["teacher"])
        assert client.post(f"{API}/classes", json={"code": "Y10", "requireApproval": False}, headers=t).json()["requireApproval"] is False
        client.post(f"{API}/classes/Y10/pupils", json={"pupilIds": ["P201"]}, headers=t)
        pin = client.post(f"{API}/pupils/P201/reset-pin", headers=t).json()["pin"]
        h = auth(login(client, code="Y10", pid="P201", pin=pin).json()["token"])
        jid = client.post(f"{API}/jobs", json=job_doc(pupil="P201"), headers=h).json()["id"]
        r = client.post(f"{API}/jobs/{jid}/submit", headers=h).json()
        assert r["status"] == "approved" and r["ticket"] is not None

    def test_a_teacher_can_change_it_later_and_it_only_affects_new_files(self, client, tokens):
        t = auth(tokens["teacher"])
        client.post(f"{API}/classes", json={"code": "Y8"}, headers=t)
        r = client.put(f"{API}/classes/Y8", json={"requireApproval": False, "label": "Year 8"}, headers=t)
        assert r.status_code == 200 and r.json()["requireApproval"] is False and r.json()["label"] == "Year 8"
        assert client.put(f"{API}/classes/Y8", json={"requireApproval": "no"}, headers=t).status_code == 422
        assert client.put(f"{API}/classes/NOPE", json={"requireApproval": True}, headers=t).status_code == 404
        assert client.put(f"{API}/classes/Y8", json={"requireApproval": True}, headers=auth(tokens["pupil"])).status_code == 403

    def test_a_pupil_with_no_class_always_needs_approval(self, client, tokens):
        h = auth(tokens["pupil"])
        jid = client.post(f"{API}/jobs", json=job_doc(), headers=h).json()["id"]
        assert client.post(f"{API}/jobs/{jid}/submit", headers=h).json()["status"] == "submitted"
