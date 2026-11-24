"""The public website and the Editor's address, next to the built Editor (``Settings.editor_dist``).

``editor/src/site/routes.ts`` is the same table for ``npm run dev``:

- ``/``          the landing page (``site/index.html``), or, for the queries that used to open the Editor at ``/``
                 (a Station link, DINO coming back, an emailed link, "work without signing in"), a redirect to ``/editor/`` with the same
                 query. DINO's registered redirect URIs stay ``<origin>/`` and ``<origin>/admin/``.
- ``/pricing``   the pricing page; ``/sign-in`` the one sign-in page for everyone; ``/register`` a free school registers itself.
- ``/editor/``   the Kerf Editor (``index.html``); ``/admin/`` the Admin site. Both are served with
                 ``<meta name="kerf-sign-in" content="/sign-in">``, which tells them to send a signed-out person to ``/sign-in``.

Everything else (``/assets/``, ``/sw.js``, ``/admin/...``) is the static mount added after these routes.
"""
from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import parse_qsl

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, HTMLResponse, RedirectResponse, Response

#: Queries that used to open the Editor at "/" (editor/src/site/routes.ts EDITOR_QUERY_KEYS).
EDITOR_QUERY_KEYS = ("station", "code", "state", "error", "signin", "offline")
SIGN_IN_META = '<meta name="kerf-sign-in" content="/sign-in">'
NO_CACHE = {"Cache-Control": "no-cache"}


def editor_forward(query: str) -> str | None:
    """Where ``/`` with this query goes instead of the landing page, or None."""
    if not query:
        return None
    keys = {k for k, _ in parse_qsl(query, keep_blank_values=True)}
    return f"/editor/?{query}" if keys & set(EDITOR_QUERY_KEYS) else None


def _with_sign_in_meta(html: str) -> str:
    return re.sub(r"(<head[^>]*>)", lambda m: m.group(1) + SIGN_IN_META, html, count=1)


def add_site_routes(app: FastAPI, dist: Path) -> None:
    def page(rel: str) -> Response:
        f = dist / rel
        if not f.is_file():
            return Response("Not found", status_code=404)
        return FileResponse(f, media_type="text/html", headers=NO_CACHE)

    def app_page(rel: str) -> Response:
        f = dist / rel
        if not f.is_file():
            return Response("Not found", status_code=404)
        return HTMLResponse(_with_sign_in_meta(f.read_text(encoding="utf-8")), headers=NO_CACHE)

    @app.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
    def landing(request: Request) -> Response:
        to = editor_forward(request.url.query)
        if to:
            return RedirectResponse(to, status_code=302)
        # an older build without the website: the Editor, as before
        return page("site/index.html") if (dist / "site/index.html").is_file() else page("index.html")

    @app.api_route("/pricing", methods=["GET", "HEAD"], include_in_schema=False)
    def pricing() -> Response:
        return page("site/pricing.html")

    @app.api_route("/register", methods=["GET", "HEAD"], include_in_schema=False)
    def register() -> Response:
        return page("site/register.html")

    @app.api_route("/sign-in", methods=["GET", "HEAD"], include_in_schema=False)
    def sign_in() -> Response:
        return page("site/sign-in.html")

    @app.api_route("/editor", methods=["GET", "HEAD"], include_in_schema=False)
    def editor_no_slash(request: Request) -> Response:
        q = request.url.query
        return RedirectResponse(f"/editor/{'?' + q if q else ''}", status_code=301)

    @app.api_route("/editor/", methods=["GET", "HEAD"], include_in_schema=False)
    def editor() -> Response:
        return app_page("index.html")

    @app.api_route("/admin/", methods=["GET", "HEAD"], include_in_schema=False)
    def admin() -> Response:
        return app_page("admin/index.html")
