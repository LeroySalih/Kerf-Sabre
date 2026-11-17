"""MCP for staff: read-only tools over files, queue and stations. Auth is DINO (JWT bound to the MCP resource) or, offline, stored tokens."""
from __future__ import annotations

import json
import logging

import pytest
from fastapi.testclient import TestClient

from kerf_server import services_people as people
from kerf_server.app import create_app
from kerf_server.config import Settings
from kerf_server.sso import Verifier

from .conftest import auth
from .fakecutter import FakeCutter
from .test_jobs import job_doc, rect_obj
from .test_schools import world  # noqa: F401  (two schools, each with an admin, teacher, pupil and laser)
from .test_sso import ISS, JWK, KEY, Jwks, make_key, mint

API = "/api/v1"
PUBLIC = "https://kerf.example.org"
RESOURCE = f"{PUBLIC}/mcp"


@pytest.fixture()
def settings(tmp_path):
    return Settings.from_env(data_dir=tmp_path / "data", replace_old_sends=False, auth_mode="pins", auto_approve_default=False, mcp_enabled=True, public_url=PUBLIC)


def rpc(client, token, method, params=None, id_=1, headers=None):
    body = {"jsonrpc": "2.0", "method": method, **({"id": id_} if id_ is not None else {}), **({"params": params} if params is not None else {})}
    h = {**(auth(token) if token else {}), **(headers or {})}
    return client.post("/mcp", json=body, headers=h)


def call(client, token, tool, **args):
    r = rpc(client, token, "tools/call", {"name": tool, "arguments": args})
    assert r.status_code == 200, r.text
    res = r.json()["result"]
    return res


def data(res):
    assert res["isError"] is False, res
    return res["structuredContent"]


def submit(client, who, pupil="P001", approve=None, **over):
    jid = client.post(f"{API}/jobs", json=job_doc(pupil=pupil, **over), headers=who).json()["id"]
    assert client.post(f"{API}/jobs/{jid}/submit", headers=who).status_code == 200
    if approve:
        assert client.post(f"{API}/jobs/{jid}/approve", headers=approve).status_code == 200
    return jid


class TestSwitchAndDiscovery:
    def test_off_unless_asked_for(self, tmp_path):
        app = create_app(Settings.from_env(data_dir=tmp_path / "d", auth_mode="pins"))
        with TestClient(app) as c:
            assert c.post("/mcp", json={}).status_code == 404
            assert c.get("/.well-known/oauth-protected-resource").status_code == 404

    def test_with_dino_it_needs_to_know_its_own_address(self, tmp_path):
        with pytest.raises(ValueError, match="KERF_PUBLIC_URL"):
            create_app(Settings.from_env(data_dir=tmp_path / "d", auth_mode="planner", sso_issuer=ISS, mcp_enabled=True))

    def test_no_token_gets_the_discovery_pointer(self, client):
        r = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"})
        assert r.status_code == 401
        assert f'resource_metadata="{PUBLIC}/.well-known/oauth-protected-resource/mcp"' in r.headers["www-authenticate"]

    @pytest.mark.parametrize("path", ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"])
    def test_protected_resource_metadata(self, client, path):
        d = client.get(path).json()
        assert d["resource"] == RESOURCE and d["bearer_methods_supported"] == ["header"]

    def test_metadata_names_dino_as_the_authorization_server(self, tmp_path, jwks_fixture):
        cfg = Settings.from_env(data_dir=tmp_path / "d", auth_mode="both", sso_issuer=ISS, mcp_enabled=True, public_url=PUBLIC)
        with TestClient(create_app(cfg)) as c:
            assert c.get("/.well-known/oauth-protected-resource/mcp").json()["authorization_servers"] == [ISS]

    def test_no_event_stream_and_no_sessions(self, client, tokens):
        for m in (client.get, client.delete):
            r = m("/mcp", headers=auth(tokens["teacher"]))
            assert r.status_code == 405 and r.headers["allow"] == "POST"


@pytest.fixture()
def jwks_fixture():
    return Jwks(JWK)


class TestProtocol:
    def test_initialize_negotiates_and_announces_tools_only(self, client, tokens):
        t = tokens["teacher"]
        r = rpc(client, t, "initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "x", "version": "1"}}).json()["result"]
        assert r["protocolVersion"] == "2025-03-26" and list(r["capabilities"]) == ["tools"] and r["serverInfo"]["name"] == "kerf-server"
        assert rpc(client, t, "initialize", {"protocolVersion": "1999-01-01"}).json()["result"]["protocolVersion"] == "2025-06-18"

    def test_notifications_are_accepted_without_a_body(self, client, tokens):
        r = rpc(client, tokens["teacher"], "notifications/initialized", id_=None)
        assert r.status_code == 202 and r.content == b""

    def test_ping_and_unknown_method(self, client, tokens):
        assert rpc(client, tokens["teacher"], "ping").json()["result"] == {}
        assert rpc(client, tokens["teacher"], "resources/list").json()["error"]["code"] == -32601

    def test_batch_for_older_clients(self, client, tokens):
        r = client.post("/mcp", json=[{"jsonrpc": "2.0", "id": 1, "method": "ping"}, {"jsonrpc": "2.0", "method": "notifications/initialized"}], headers=auth(tokens["teacher"]))
        assert [x["id"] for x in r.json()] == [1]

    def test_garbage_is_refused_politely(self, client, tokens):
        h = auth(tokens["teacher"])
        assert client.post("/mcp", content=b"{nope", headers=h).status_code == 400
        assert client.post("/mcp", json={"hello": 1}, headers=h).json()["error"]["code"] == -32600

    def test_every_tool_is_marked_read_only(self, client, tokens):
        tools = rpc(client, tokens["teacher"], "tools/list").json()["result"]["tools"]
        assert {t["name"] for t in tools} == {"list_files", "get_file", "get_gcode", "get_queue", "list_stations", "get_station"}
        assert all(t["annotations"]["readOnlyHint"] is True and t["annotations"]["destructiveHint"] is False for t in tools)

    @pytest.mark.parametrize("name,args", [("nope", {}), ("list_files", {"limit": 5000}), ("list_files", {"status": ["bogus"]}), ("get_file", {}), ("get_station", {"id": "s", "log_lines": 101})])
    def test_bad_calls_are_protocol_errors(self, client, tokens, name, args):
        r = rpc(client, tokens["teacher"], "tools/call", {"name": name, "arguments": args}).json()
        assert r["error"]["code"] == -32602


class TestWhoMayUseIt:
    @pytest.mark.parametrize("who,status", [("teacher", 200), ("pupil", 403), ("station", 403)])
    def test_staff_only(self, client, tokens, who, status):
        assert rpc(client, tokens[who], "ping").status_code == status

    def test_an_unknown_token_is_401(self, client):
        r = rpc(client, "kt_made_up", "ping")
        assert r.status_code == 401 and "resource_metadata" in r.headers["www-authenticate"]

    def test_a_browser_from_another_origin_is_refused(self, client, tokens):
        h = auth(tokens["teacher"])
        assert client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"}, headers={**h, "Origin": "https://evil.example"}).status_code == 403
        assert client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"}, headers={**h, "Origin": PUBLIC}).status_code == 200


@pytest.fixture()
def dino(tmp_path):
    """DINO sign-in only (planner mode) with MCP on. A local key stands in for planner-004."""
    cfg = Settings.from_env(data_dir=tmp_path / "data", auth_mode="planner", sso_issuer=ISS, mcp_enabled=True, public_url=PUBLIC)
    app = create_app(cfg)
    app.state.sso = Verifier(cfg, fetch=Jwks(JWK))
    with TestClient(app) as c:
        c.app_ = app
        yield c


class TestDinoTokens:
    def mcp(self, **over):
        # a token DINO bound to the MCP resource, for a client the AI app registered itself
        return mint(**{"aud": RESOURCE, "client_id": "claude-ai-dcr-1234", **over})

    @pytest.mark.parametrize("roles,status", [(["teacher"], 200), (["admin"], 200), (["technician"], 200), (["pupil"], 403)])
    def test_roles(self, dino, roles, status):
        assert rpc(dino, self.mcp(roles=roles), "ping").status_code == status

    def test_an_editor_token_does_not_work_on_mcp(self, dino):
        editor = mint(roles=["teacher"])  # aud kerf-sabre, client kerf-editor: right for the REST API, wrong resource for MCP
        assert rpc(dino, editor, "ping").status_code == 401
        assert dino.get(f"{API}/auth/me", headers=auth(editor)).status_code == 200

    def test_an_mcp_token_does_not_work_on_the_rest_api(self, dino):
        t = self.mcp(roles=["teacher"])
        assert dino.get(f"{API}/auth/me", headers=auth(t)).status_code == 401
        assert dino.get(f"{API}/jobs", headers=auth(t)).status_code == 401

    @pytest.mark.parametrize("bad", [dict(aud="someone-else"), dict(iss="https://evil.example"), dict(exp=1), dict(sub=None)])
    def test_bad_tokens(self, dino, bad):
        assert rpc(dino, self.mcp(roles=["teacher"], **bad), "ping").status_code == 401

    def test_wrong_algorithm_and_unknown_key(self, dino):
        other, _ = make_key("k2")
        assert rpc(dino, mint(aud=RESOURCE, roles=["teacher"], key=other, kid="k2"), "ping").status_code == 401  # a key DINO never published
        assert rpc(dino, mint(aud=RESOURCE, roles=["teacher"], alg="HS256", key="x" * 40), "ping").status_code == 401

    def test_a_stored_teacher_token_is_refused_when_dino_is_the_only_way_in(self, dino):
        from kerf_server.security import issue_token

        assert rpc(dino, issue_token(dino.app_.state.db, "teacher", "T9"), "ping").status_code == 401

    def test_dino_is_down_and_the_keys_were_never_fetched(self, tmp_path):
        cfg = Settings.from_env(data_dir=tmp_path / "data", auth_mode="planner", sso_issuer=ISS, mcp_enabled=True, public_url=PUBLIC)
        app = create_app(cfg)
        j = Jwks(JWK)
        j.down = True
        app.state.sso = Verifier(cfg, fetch=j)
        with TestClient(app) as c:
            assert rpc(c, mint(aud=RESOURCE, roles=["teacher"]), "ping").status_code == 503


class TestFilesAndQueue:
    def test_list_filter_and_detail(self, client, tokens):
        p, t = auth(tokens["pupil"]), auth(tokens["teacher"])
        draft = client.post(f"{API}/jobs", json=job_doc(), headers=p).json()["id"]
        waiting = submit(client, p, approve=t, objects=[rect_obj("a", 20, 20, 50, 30), rect_obj("s", 5, 5, 10, 10, layer="score")])
        tt = tokens["teacher"]
        every = data(call(client, tt, "list_files"))
        assert {f["id"] for f in every["files"]} == {draft, waiting}
        only = data(call(client, tt, "list_files", status=["approved"], pupil_id="P001"))["files"]
        assert [f["id"] for f in only] == [waiting]
        f = only[0]
        assert f["status"] == "approved" and f["ticket"] == 1 and f["pupilId"] == "P001" and f["presetId"] == "ply-3mm"
        assert f["shapesByLayer"] == {"cut": 1, "score": 1} and f["estimatedDurationS"] > 0
        assert data(call(client, tt, "list_files", pupil_id="nobody"))["files"] == []
        d = data(call(client, tt, "get_file", id=waiting))
        assert [e["kind"] for e in d["events"]][-1] == "approved" and "design" not in d
        full = data(call(client, tt, "get_file", id=waiting, include_design=True, include_events=False))
        assert len(full["design"]["objects"]) == 2 and full["design"]["truncated"] is False and "events" not in full

    def test_paging(self, client, tokens):
        p = auth(tokens["pupil"])
        ids = [submit(client, p) for _ in range(3)]
        got = [f["id"] for off in (0, 2) for f in data(call(client, tokens["teacher"], "list_files", limit=2, offset=off))["files"]]
        assert sorted(got) == sorted(ids)

    def test_gcode_is_capped_and_labelled(self, client, tokens):
        jid = submit(client, auth(tokens["pupil"]), approve=auth(tokens["teacher"]))
        g = data(call(client, tokens["teacher"], "get_gcode", id=jid, max_lines=5))
        assert g["truncated"] is True and g["returnedLines"] == 5 and g["totalLines"] > 5 and len(g["gcode"].splitlines()) == 5
        assert g["gcode"].startswith("; Kerf") and "G92" not in g["gcode"] and len(g["sha256"]) == 64
        wrong = call(client, tokens["teacher"], "get_gcode", id=jid, station="no-such")
        assert wrong["isError"] and "No G-code for station 'no-such'" in wrong["content"][0]["text"]

    def test_a_draft_has_no_gcode_and_a_missing_file_is_a_tool_error(self, client, tokens):
        draft = client.post(f"{API}/jobs", json=job_doc(), headers=auth(tokens["pupil"])).json()["id"]
        r = call(client, tokens["teacher"], "get_gcode", id=draft)
        assert r["isError"] and "No G-code" in r["content"][0]["text"]
        r = call(client, tokens["teacher"], "get_file", id="job-does-not-exist")
        assert r["isError"] and "no such file" in r["content"][0]["text"].lower()

    def test_queue_in_order_with_the_next_file_for_a_station(self, client, tokens):
        p, t = auth(tokens["pupil"]), auth(tokens["teacher"])
        first, second = submit(client, p, approve=t), submit(client, auth(tokens["pupil2"]), pupil="P002", approve=t)
        q = data(call(client, tokens["teacher"], "get_queue"))
        assert q["waiting"] == 2 and q["onALaser"] == 0
        assert [(e["ticket"], e["jobId"], e["position"]) for e in q["entries"]] == [(1, first, 1), (2, second, 2)]
        n = data(call(client, tokens["teacher"], "get_queue", station="station-1"))["entries"]
        assert [e["next"] for e in n] == [True, False]
        assert call(client, tokens["teacher"], "get_queue", station="nowhere")["isError"]

    def test_display_names_reach_staff_only_and_never_the_audit_log(self, client, app, tokens, caplog):
        submit(client, auth(tokens["pupil"]))
        with app.state.db.session() as s:
            people.remember(s, "P001", "main", "Ada Lovelace")
        with caplog.at_level(logging.INFO, logger="kerf.mcp"):
            f = data(call(client, tokens["teacher"], "list_files"))["files"][0]
            call(client, tokens["teacher"], "get_queue")
        assert f["pupilName"] == "Ada Lovelace" and f["pupilId"] == "P001"
        log = "\n".join(r.getMessage() for r in caplog.records)
        assert "tool=list_files" in log and "by=T001" in log
        assert "Ada" not in log and tokens["teacher"] not in log and "P001" not in log


class TestStations:
    def test_offline_then_live(self, client, tokens):
        from .test_stations import wait_for

        s = data(call(client, tokens["teacher"], "list_stations"))["stations"]
        assert {x["id"] for x in s} >= {"station-1"} and all(x["online"] is False for x in s)
        one = next(x for x in s if x["id"] == "station-1")
        assert one["name"] and one["bed"] and one["nextTicket"] is None
        with FakeCutter(client, tokens["station"]) as fc:
            fc.status("Run", mpos=(12.5, 7.0, 0.0))
            live = wait_for(lambda: (x := data(call(client, tokens["teacher"], "get_station", id="station-1")))["state"] == "Run" and x)
            assert live["online"] is True and live["mpos"][:2] == [12.5, 7.0] and live["cutterVersion"] == "test" and live["s30"] == 1000
            assert "camera" not in json.dumps(live).replace("cameraAvailable", "")
        wait_for(lambda: data(call(client, tokens["teacher"], "get_station", id="station-1"))["online"] is False)

    def test_next_ticket_and_logs(self, client, tokens, app):
        jid = submit(client, auth(tokens["pupil"]), approve=auth(tokens["teacher"]))
        app.state.hub.server_log("station-1", "INFO", "frame sent", jid)
        app.state.hub.server_log("station-1", "ERROR", "grbl alarm", jid)
        st = data(call(client, tokens["teacher"], "get_station", id="station-1", log_lines=10))
        assert st["nextTicket"]["jobId"] == jid and st["waitingForThisLaser"] == 1
        assert [l["event"] for l in st["recentLogs"]] == ["frame sent", "grbl alarm"]
        only_errors = data(call(client, tokens["teacher"], "get_station", id="station-1", log_lines=10, log_level="ERROR"))["recentLogs"]
        assert [l["event"] for l in only_errors] == ["grbl alarm"]
        assert "recentLogs" not in data(call(client, tokens["teacher"], "get_station", id="station-1"))
        assert call(client, tokens["teacher"], "get_station", id="nope")["isError"]


class TestSchoolsAreWalls:
    """Another school's files, queue and lasers do not exist as far as MCP is concerned."""

    def mk(self, client, w):
        pid = client.get(f"{API}/auth/me", headers=w["pupil"]).json()["id"]
        jid = client.post(f"{API}/jobs", json=job_doc(pupil=pid), headers=w["pupil"]).json()["id"]
        assert client.post(f"{API}/jobs/{jid}/submit", headers=w["pupil"]).status_code == 200
        assert client.post(f"{API}/jobs/{jid}/approve", headers=w["teacher"]).status_code == 200
        return jid

    def tok(self, w, who):
        return w[who]["Authorization"].split()[1]

    def test_files_queue_gcode_and_stations(self, client, world):
        a, b = world["alpha"], world["beta"]
        ja, jb = self.mk(client, a), self.mk(client, b)
        for w, mine, theirs, laser, other_laser in ((a, ja, jb, "alpha-laser", "beta-laser"), (b, jb, ja, "beta-laser", "alpha-laser")):
            for who in ("teacher", "admin"):
                t = self.tok(w, who)
                assert [f["id"] for f in data(call(client, t, "list_files"))["files"]] == [mine]
                assert [e["jobId"] for e in data(call(client, t, "get_queue"))["entries"]] == [mine]
                assert [s["id"] for s in data(call(client, t, "list_stations"))["stations"]] == [laser]
                assert data(call(client, t, "get_file", id=mine))["id"] == mine
                assert call(client, t, "get_file", id=theirs)["isError"]
                assert call(client, t, "get_gcode", id=theirs)["isError"]
                assert call(client, t, "get_station", id=other_laser)["isError"]
                assert call(client, t, "get_queue", station=other_laser)["isError"]
                assert data(call(client, t, "list_files", pupil_id=client.get(f"{API}/auth/me", headers=(b if w is a else a)["pupil"]).json()["id"]))["files"] == []

    def test_a_pupil_or_station_of_any_school_gets_nothing(self, client, world):
        for s in ("alpha", "beta"):
            assert rpc(client, self.tok(world[s], "pupil"), "ping").status_code == 403
            assert rpc(client, world[s]["station_token"], "ping").status_code == 403

    def test_the_platform_owner_sees_inside_no_school(self, client, app):
        from kerf_server.security import issue_token

        assert rpc(client, issue_token(app.state.db, "platform", "root"), "ping").status_code == 403
