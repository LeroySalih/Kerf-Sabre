from __future__ import annotations

import pytest

from .conftest import auth
from .fakecutter import FakeCutter
from .test_jobs import post, rect_obj
from .test_stations import approved_job, st, wait_for

API = "/api/v1"


def queue(client, token, station=None):
    return client.get(f"{API}/queue" + (f"?station={station}" if station else ""), headers=auth(token)).json()


class TestOrder:
    def test_tickets_go_up_in_approval_order_and_positions_follow(self, client, tokens):
        a = post(client, tokens, status="submitted").json()["id"]
        b = post(client, tokens, status="submitted").json()["id"]
        t = auth(tokens["teacher"])
        # approved in the opposite order to submission: the queue follows approval
        rb = client.post(f"{API}/jobs/{b}/approve", headers=t).json()
        ra = client.post(f"{API}/jobs/{a}/approve", headers=t).json()
        assert (rb["ticket"], rb["position"]) == (1, 1)
        assert (ra["ticket"], ra["position"]) == (2, 2)
        q = queue(client, tokens["teacher"])
        assert [(e["ticket"], e["jobId"], e["position"]) for e in q] == [(1, b, 1), (2, a, 2)]
        assert client.get(f"{API}/jobs/{a}", headers=auth(tokens["pupil"])).json()["ticket"] == 2

    def test_unapproved_jobs_are_not_in_the_queue(self, client, tokens):
        post(client, tokens, status="submitted")
        post(client, tokens)
        assert queue(client, tokens["teacher"]) == []

    def test_cancelled_jobs_leave_and_tickets_are_never_reused(self, client, tokens):
        a, b = approved_job(client, tokens), approved_job(client, tokens)
        client.post(f"{API}/jobs/{a}/cancel", headers=auth(tokens["pupil"]))
        assert [e["jobId"] for e in queue(client, tokens["teacher"])] == [b]
        c = approved_job(client, tokens)
        assert [e["ticket"] for e in queue(client, tokens["teacher"])] == [2, 3]
        assert client.get(f"{API}/jobs/{c}", headers=auth(tokens["pupil"])).json()["ticket"] == 3

    def test_pupils_see_the_queue_but_only_their_own_details(self, client, tokens):
        mine = approved_job(client, tokens)
        theirs = client.post(f"{API}/jobs", json={**__import__("tests.test_jobs", fromlist=["job_doc"]).job_doc(pupil="P002", status="submitted")}, headers=auth(tokens["pupil2"])).json()["id"]
        client.post(f"{API}/jobs/{theirs}/approve", headers=auth(tokens["teacher"]))
        q = queue(client, tokens["pupil"])
        assert [e["own"] for e in q] == [True, False]
        assert q[0]["jobId"] == mine and q[0]["pupilId"] == "P001"
        assert q[1]["jobId"] is None and q[1]["pupilId"] is None and q[1]["ticket"] == 2 and q[1]["position"] == 2

    def test_wait_estimate_adds_up_what_is_ahead(self, client, tokens):
        approved_job(client, tokens)
        approved_job(client, tokens)
        a, b = queue(client, tokens["teacher"])
        assert a["aheadS"] == 0 and b["aheadS"] == pytest.approx(a["estimatedS"])


class TestReorder:
    def make(self, client, tokens, n=4):
        return [approved_job(client, tokens) for _ in range(n)]

    def order(self, client, tokens):
        return [e["jobId"] for e in queue(client, tokens["teacher"])]

    def test_move_front_back_up_down_and_position(self, client, tokens):
        ids = self.make(client, tokens)
        t = auth(tokens["teacher"])
        mv = lambda j, **b: client.post(f"{API}/queue/{j}/move", json=b, headers=t)
        assert mv(ids[3], to="front").status_code == 200
        assert self.order(client, tokens) == [ids[3], ids[0], ids[1], ids[2]]
        mv(ids[3], to="back")
        assert self.order(client, tokens) == ids
        mv(ids[2], to="up")
        assert self.order(client, tokens) == [ids[0], ids[2], ids[1], ids[3]]
        mv(ids[2], to="down")
        assert self.order(client, tokens) == ids
        mv(ids[0], position=3)
        assert self.order(client, tokens) == [ids[1], ids[2], ids[0], ids[3]]
        mv(ids[3], position=99)
        assert self.order(client, tokens)[-1] == ids[3]

    def test_tickets_do_not_change_when_moved(self, client, tokens):
        ids = self.make(client, tokens, 3)
        client.post(f"{API}/queue/{ids[2]}/move", json={"to": "front"}, headers=auth(tokens["teacher"]))
        assert [(e["ticket"], e["position"]) for e in queue(client, tokens["teacher"])] == [(3, 1), (1, 2), (2, 3)]

    def test_many_moves_keep_a_strict_order(self, client, tokens):
        ids = self.make(client, tokens, 3)
        t = auth(tokens["teacher"])
        for _ in range(30):  # squeeze between the same two neighbours repeatedly
            client.post(f"{API}/queue/{ids[2]}/move", json={"position": 2}, headers=t)
            client.post(f"{API}/queue/{ids[1]}/move", json={"position": 2}, headers=t)
        assert sorted(self.order(client, tokens)) == sorted(ids) and len(set(self.order(client, tokens))) == 3

    def test_only_teachers_and_only_waiting_jobs_and_valid_requests(self, client, tokens):
        a, b = self.make(client, tokens, 2)
        assert client.post(f"{API}/queue/{a}/move", json={"to": "back"}, headers=auth(tokens["pupil"])).status_code == 403
        assert client.post(f"{API}/queue/{a}/move", json={"to": "back"}, headers=auth(tokens["station"])).status_code == 403
        t = auth(tokens["teacher"])
        assert client.post(f"{API}/queue/{a}/move", json={}, headers=t).status_code == 422
        assert client.post(f"{API}/queue/{a}/move", json={"to": "sideways"}, headers=t).status_code == 422
        assert client.post(f"{API}/queue/{a}/move", json={"to": "back", "position": 1}, headers=t).status_code == 422
        assert client.post(f"{API}/queue/{a}/move", json={"position": 0}, headers=t).status_code == 422
        client.post(f"{API}/jobs/{b}/cancel", headers=auth(tokens["pupil"]))
        assert client.post(f"{API}/queue/{b}/move", json={"to": "front"}, headers=t).json()["code"] == "not_waiting"

    def test_defer_sends_to_the_back_for_owner_station_and_teacher(self, client, tokens):
        a, b, c = self.make(client, tokens, 3)
        r = client.post(f"{API}/jobs/{a}/defer", headers=auth(tokens["pupil"]))
        assert r.status_code == 200 and r.json()["position"] == 3 and r.json()["ticket"] == 1
        assert self.order(client, tokens) == [b, c, a]
        assert client.post(f"{API}/jobs/{b}/defer", headers=auth(tokens["station"])).status_code == 200
        assert client.post(f"{API}/jobs/{c}/defer", headers=auth(tokens["teacher"])).status_code == 200
        assert self.order(client, tokens) == [a, b, c]
        assert client.post(f"{API}/jobs/{a}/defer", headers=auth(tokens["pupil2"])).status_code == 404  # someone else's


class TestServedInOrder:
    def run(self, client, tokens, jid, **extra):
        sh = auth(tokens["station"])
        f = client.post(f"{API}/jobs/{jid}/frame", json={"station": "station-1", **extra}, headers=sh)
        return f

    def test_only_the_next_ticket_can_be_framed_or_started(self, client, tokens):
        first, second = approved_job(client, tokens), approved_job(client, tokens)
        with FakeCutter(client, tokens["station"]):
            wait_for(lambda: st(client, tokens)["online"])
            r = self.run(client, tokens, second)
            assert r.status_code == 409 and r.json()["code"] == "not_your_turn" and "Ticket 1 is next" in r.json()["message"] and "2nd" in r.json()["message"]
            body = {"station": "station-1", "materialConfirmed": True}
            assert client.post(f"{API}/jobs/{second}/assign", json=body, headers=auth(tokens["station"])).json()["code"] == "not_your_turn"
            assert self.run(client, tokens, first).status_code == 202
            q = queue(client, tokens["station"], "station-1")
            assert [e["next"] for e in q] == [True, False]

    def test_teacher_can_skip_the_queue_but_a_station_cannot(self, client, tokens):
        approved_job(client, tokens)
        second = approved_job(client, tokens)
        with FakeCutter(client, tokens["station"]):
            wait_for(lambda: st(client, tokens)["online"])
            assert self.run(client, tokens, second, skipQueue=True).json()["code"] == "not_your_turn"
            r = client.post(f"{API}/jobs/{second}/frame", json={"station": "station-1", "skipQueue": True}, headers=auth(tokens["teacher"]))
            assert r.status_code == 202

    def test_moving_a_job_to_the_front_changes_who_is_next(self, client, tokens):
        first, second = approved_job(client, tokens), approved_job(client, tokens)
        client.post(f"{API}/queue/{second}/move", json={"to": "front"}, headers=auth(tokens["teacher"]))
        with FakeCutter(client, tokens["station"]):
            wait_for(lambda: st(client, tokens)["online"])
            assert self.run(client, tokens, first).json()["code"] == "not_your_turn"
            assert self.run(client, tokens, second).status_code == 202

    def test_a_deferred_job_lets_the_next_one_go(self, client, tokens):
        first, second = approved_job(client, tokens), approved_job(client, tokens)
        client.post(f"{API}/jobs/{first}/defer", headers=auth(tokens["pupil"]))
        with FakeCutter(client, tokens["station"]):
            wait_for(lambda: st(client, tokens)["online"])
            assert self.run(client, tokens, second).status_code == 202

    def test_jobs_pinned_to_another_station_do_not_block_this_one(self, client, tokens):
        pinned = post(client, tokens, status="submitted").json()["id"]
        client.post(f"{API}/jobs/{pinned}/approve", json={"station": "station-2"}, headers=auth(tokens["teacher"]))
        free = approved_job(client, tokens)
        with FakeCutter(client, tokens["station"]):
            wait_for(lambda: st(client, tokens)["online"])
            assert self.run(client, tokens, free).status_code == 202  # pinned job is ahead, but not for this laser

    def test_a_job_being_lined_up_on_one_station_is_reserved_from_the_others(self, client, tokens):
        a, b = approved_job(client, tokens), approved_job(client, tokens)
        with FakeCutter(client, tokens["station"]) as c:
            wait_for(lambda: st(client, tokens)["online"])
            assert self.run(client, tokens, a).status_code == 202
            q = queue(client, tokens["station"], "station-2")
            assert [e["next"] for e in q] == [False, True]  # station-2's next is b: a is reserved on station-1
            assert q[0]["framedOn"] == "station-1"

    def test_the_job_in_progress_leaves_the_waiting_list_and_shows_as_cutting(self, client, tokens):
        a, b = approved_job(client, tokens), approved_job(client, tokens)
        sh = auth(tokens["station"])
        with FakeCutter(client, tokens["station"], auto_finish=None):
            wait_for(lambda: st(client, tokens)["online"])
            client.post(f"{API}/jobs/{a}/frame", json={"station": "station-1"}, headers=sh)
            assert client.post(f"{API}/jobs/{a}/assign", json={"station": "station-1", "materialConfirmed": True}, headers=sh).status_code == 200
            q = queue(client, tokens["teacher"])
            assert [(e["jobId"], e["status"], e["position"]) for e in q] == [(a, "running", None), (b, "approved", 1)]

    def test_a_refused_start_keeps_its_place(self, client, tokens):
        a, b = approved_job(client, tokens), approved_job(client, tokens)
        sh = auth(tokens["station"])
        with FakeCutter(client, tokens["station"], accept=False):
            wait_for(lambda: st(client, tokens)["online"])
            client.post(f"{API}/jobs/{a}/frame", json={"station": "station-1"}, headers=sh)
            assert client.post(f"{API}/jobs/{a}/assign", json={"station": "station-1", "materialConfirmed": True}, headers=sh).status_code == 409
        assert [e["jobId"] for e in queue(client, tokens["teacher"])] == [a, b]
