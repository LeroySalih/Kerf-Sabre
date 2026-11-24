"""The public website, the Editor at /editor/ and the forwarding of old Editor addresses (kerf_server/webpages.py)."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from kerf_server.app import create_app
from kerf_server.config import Settings
from kerf_server.webpages import editor_forward

API = "/api/v1"


@pytest.fixture()
def site(tmp_path):
    dist = tmp_path / "dist"
    (dist / "site").mkdir(parents=True)
    (dist / "admin").mkdir()
    (dist / "assets").mkdir()
    (dist / "index.html").write_text("<!doctype html><html><head><title>Kerf Editor</title></head><body>EDITOR</body></html>")
    (dist / "admin" / "index.html").write_text("<!doctype html><html><head><title>Kerf Admin</title></head><body>ADMIN</body></html>")
    (dist / "site" / "index.html").write_text("<html><head></head><body>LANDING</body></html>")
    (dist / "site" / "pricing.html").write_text("<html><head></head><body>PRICING</body></html>")
    (dist / "site" / "sign-in.html").write_text("<html><head></head><body>SIGN-IN</body></html>")
    (dist / "assets" / "app.js").write_text("console.log(1)")
    (dist / "sw.js").write_text("// sw")
    app = create_app(Settings.from_env(data_dir=tmp_path / "d", editor_dist=dist, resend_api_key=""))
    with TestClient(app) as c:
        yield c


class TestPages:
    def test_each_address_shows_its_page(self, site):
        assert "LANDING" in site.get("/").text
        assert "PRICING" in site.get("/pricing").text
        assert "SIGN-IN" in site.get("/sign-in").text
        r = site.get("/editor/")
        assert r.status_code == 200 and "EDITOR" in r.text and r.headers["content-type"].startswith("text/html")
        assert "ADMIN" in site.get("/admin/").text

    def test_the_editor_and_admin_are_told_where_to_sign_in_but_the_site_pages_are_not(self, site):
        meta = '<meta name="kerf-sign-in" content="/sign-in">'
        assert meta in site.get("/editor/").text and meta in site.get("/admin/").text
        assert site.get("/editor/").text.index(meta) < site.get("/editor/").text.index("<title>")
        assert meta not in site.get("/").text and meta not in site.get("/sign-in").text

    def test_editor_without_the_slash_keeps_its_query(self, site):
        r = site.get("/editor?station=station-1", follow_redirects=False)
        assert r.status_code == 301 and r.headers["location"] == "/editor/?station=station-1"

    def test_files_and_the_api_are_untouched(self, site):
        assert site.get("/assets/app.js").text == "console.log(1)"
        assert site.get("/sw.js").status_code == 200
        assert site.get("/health").json()["status"] == "ok"
        assert site.get(f"{API}/auth/me").status_code == 401
        assert site.get(f"{API}/auth/config").status_code == 200
        assert site.head("/").status_code == 200


class TestOldEditorAddresses:
    @pytest.mark.parametrize("query", [
        "station=station-1",
        "code=abc&state=xyz",  # DINO coming back to its registered redirect URI, <origin>/
        "error=access_denied&error_description=no&state=xyz",
        "signin=" + "t" * 30,  # an emailed link from before the sign-in page
        "offline=1",
    ])
    def test_are_forwarded_to_the_editor_with_the_same_query(self, site, query):
        r = site.get(f"/?{query}", follow_redirects=False)
        assert r.status_code == 302 and r.headers["location"] == f"/editor/?{query}"

    def test_other_queries_show_the_landing_page(self, site):
        assert "LANDING" in site.get("/?utm_source=leaflet").text
        assert editor_forward("") is None and editor_forward("ref=1") is None
        assert editor_forward("a=1&code=2") == "/editor/?a=1&code=2"

    def test_admin_dino_returns_are_not_touched(self, site):
        assert "ADMIN" in site.get("/admin/?code=abc&state=xyz", follow_redirects=False).text


def test_an_older_build_without_the_website_still_shows_the_editor_at_the_root(tmp_path):
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text("<title>Kerf</title>EDITOR")
    with TestClient(create_app(Settings.from_env(data_dir=tmp_path / "d", editor_dist=dist))) as c:
        assert "EDITOR" in c.get("/").text
        assert c.get("/pricing").status_code == 404
