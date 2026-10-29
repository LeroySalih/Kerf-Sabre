"""Rename and delete a file; the open tabs kept per person so another browser shows the same ones."""
from __future__ import annotations

from .conftest import auth
from .test_jobs import API, post, rect_obj
from .test_stations import approved_job


def ids(client, token):
    return [j["id"] for j in client.get(f"{API}/jobs", headers=auth(token)).json()]


class TestRename:
    def test_a_file_can_be_named_at_save_and_renamed_later(self, client, tokens):
        r = post(client, tokens, name="Phone stand")
        jid = r.json()["id"]
        got = client.get(f"{API}/jobs/{jid}", headers=auth(tokens["pupil"])).json()
        assert got["name"] == "Phone stand"
        r = client.put(f"{API}/jobs/{jid}/name", json={"name": "  Stand v2  "}, headers=auth(tokens["pupil"]))
        assert r.status_code == 200 and r.json() == {"id": jid, "name": "Stand v2"}
        assert client.get(f"{API}/jobs/{jid}", headers=auth(tokens["pupil"])).json()["name"] == "Stand v2"
        client.put(f"{API}/jobs/{jid}/name", json={"name": ""}, headers=auth(tokens["pupil"]))
        assert "name" not in client.get(f"{API}/jobs/{jid}", headers=auth(tokens["pupil"])).json()

    def test_a_name_is_cut_to_60_characters_and_must_be_text(self, client, tokens):
        jid = post(client, tokens).json()["id"]
        r = client.put(f"{API}/jobs/{jid}/name", json={"name": "x" * 90}, headers=auth(tokens["pupil"]))
        assert len(r.json()["name"]) == 60
        assert client.put(f"{API}/jobs/{jid}/name", json={"name": 5}, headers=auth(tokens["pupil"])).status_code == 422
        assert client.put(f"{API}/jobs/{jid}/name", json={}, headers=auth(tokens["pupil"])).status_code == 422

    def test_only_the_owner_can_rename_even_a_sent_file(self, client, tokens):
        jid = approved_job(client, tokens)
        assert client.put(f"{API}/jobs/{jid}/name", json={"name": "ok"}, headers=auth(tokens["pupil"])).status_code == 200
        assert client.put(f"{API}/jobs/{jid}/name", json={"name": "no"}, headers=auth(tokens["pupil2"])).status_code == 404
        assert client.put(f"{API}/jobs/{jid}/name", json={"name": "no"}, headers=auth(tokens["teacher"])).status_code == 403


class TestDelete:
    def test_a_draft_can_be_deleted_and_is_gone(self, client, tokens):
        jid = post(client, tokens).json()["id"]
        assert client.delete(f"{API}/jobs/{jid}", headers=auth(tokens["pupil"])).status_code == 204
        assert client.get(f"{API}/jobs/{jid}", headers=auth(tokens["pupil"])).status_code == 404
        assert jid not in ids(client, tokens["pupil"])

    def test_a_cancelled_file_can_be_deleted(self, client, tokens):
        jid = post(client, tokens, status="submitted").json()["id"]
        client.post(f"{API}/jobs/{jid}/cancel", headers=auth(tokens["pupil"]))
        assert client.delete(f"{API}/jobs/{jid}", headers=auth(tokens["pupil"])).status_code == 204

    def test_a_waiting_file_must_be_cancelled_first(self, client, tokens):
        jid = approved_job(client, tokens)
        r = client.delete(f"{API}/jobs/{jid}", headers=auth(tokens["pupil"]))
        assert r.status_code == 409 and r.json()["code"] == "in_queue"
        assert jid in ids(client, tokens["pupil"])

    def test_nobody_else_can_delete_it(self, client, tokens):
        jid = post(client, tokens).json()["id"]
        assert client.delete(f"{API}/jobs/{jid}", headers=auth(tokens["pupil2"])).status_code == 404
        assert client.delete(f"{API}/jobs/{jid}", headers=auth(tokens["teacher"])).status_code == 403
        assert jid in ids(client, tokens["pupil"])

    def test_a_finished_cut_is_kept(self, client, tokens, app):
        from kerf_server.models import Job

        jid = post(client, tokens).json()["id"]
        with app.state.db.session() as s:
            s.get(Job, jid).status = "done"
        r = client.delete(f"{API}/jobs/{jid}", headers=auth(tokens["pupil"]))
        assert r.status_code == 409 and r.json()["code"] == "keep_record"


class TestWorkspace:
    def test_nothing_is_saved_at_first(self, client, tokens):
        r = client.get(f"{API}/workspace", headers=auth(tokens["pupil"])).json()
        assert r == {"tabs": [], "active": None, "updatedAt": None}

    def test_the_open_tabs_come_back_in_order_with_the_one_showing(self, client, tokens):
        a, b, c = (post(client, tokens).json()["id"] for _ in range(3))
        body = {"tabs": [{"jobId": c, "name": "Lid"}, {"jobId": a, "name": "Base", "renamed": True}, {"jobId": b}], "active": a}
        r = client.put(f"{API}/workspace", json=body, headers=auth(tokens["pupil"]))
        assert r.status_code == 200 and r.json()["updatedAt"]
        got = client.get(f"{API}/workspace", headers=auth(tokens["pupil"])).json()
        assert [t["jobId"] for t in got["tabs"]] == [c, a, b]
        assert got["tabs"][1] == {"jobId": a, "name": "Base", "renamed": True}
        assert got["active"] == a

    def test_only_your_own_files_are_kept(self, client, tokens):
        mine = post(client, tokens).json()["id"]
        theirs = post(client, tokens, who="pupil2", pupil="P002").json()["id"]
        r = client.put(f"{API}/workspace", json={"tabs": [{"jobId": theirs}, {"jobId": mine}, {"jobId": "job-nope"}, {"jobId": mine}], "active": theirs}, headers=auth(tokens["pupil"]))
        assert [t["jobId"] for t in r.json()["tabs"]] == [mine] and r.json()["active"] is None
        assert client.get(f"{API}/workspace", headers=auth(tokens["pupil2"])).json()["tabs"] == []  # and nobody sees another's list

    def test_a_deleted_file_drops_out_of_the_tabs(self, client, tokens):
        a, b = (post(client, tokens).json()["id"] for _ in range(2))
        client.put(f"{API}/workspace", json={"tabs": [{"jobId": a}, {"jobId": b}], "active": b}, headers=auth(tokens["pupil"]))
        client.delete(f"{API}/jobs/{b}", headers=auth(tokens["pupil"]))
        got = client.get(f"{API}/workspace", headers=auth(tokens["pupil"])).json()
        assert [t["jobId"] for t in got["tabs"]] == [a] and got["active"] is None

    def test_limits(self, client, tokens):
        too_many = {"tabs": [{"jobId": f"job-{i:04d}"} for i in range(31)]}
        assert client.put(f"{API}/workspace", json=too_many, headers=auth(tokens["pupil"])).status_code == 422
        assert client.put(f"{API}/workspace", json={"nope": 1}, headers=auth(tokens["pupil"])).status_code == 422
        assert client.put(f"{API}/workspace", json={"tabs": []}).status_code == 401
