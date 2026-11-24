"""Application factory."""
from __future__ import annotations

import logging
import re
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from . import __version__, errors
from .api import activities, auth, catalog, classes, cutter, cutter_ws, dxf, groups, jobs, schools, stations, workspace
from .config import Settings
from .db import Database
from .mcp_layer import routes as mcp_routes
from .services_seed import seed
from .services_classes import IpThrottle
from .sso import Verifier
from .stations import Hub

API = "/api/v1"
_LINK_IN_QUERY = re.compile(r"((?:signin|register)=)[^&\s]+")


class HideLinks(logging.Filter):
    """The web server's access log would print an emailed sign-in or registration link's token (`/sign-in?signin=…`,
    `?register=…`). Links are never logged, so the token is replaced with `…`."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple):
            record.args = tuple(_LINK_IN_QUERY.sub(r"\1…", a) if isinstance(a, str) else a for a in record.args)
        elif isinstance(record.msg, str):
            record.msg = _LINK_IN_QUERY.sub(r"\1…", record.msg)
        return True


def _hide_links_in_access_log() -> None:
    access = logging.getLogger("uvicorn.access")
    if not any(isinstance(f, HideLinks) for f in access.filters):
        access.addFilter(HideLinks())


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    _hide_links_in_access_log()
    if settings.auth_mode not in ("pins", "planner", "both"):
        raise ValueError(f"KERF_AUTH_MODE must be pins, planner or both, not {settings.auth_mode!r}")
    if settings.sso_enabled and not settings.sso_issuer.startswith(("https://", "http://")):
        raise ValueError("KERF_SSO_ISSUER (planner-004's public origin) is required when KERF_AUTH_MODE is planner or both")
    if settings.mcp_enabled and settings.sso_enabled and not settings.mcp_aud:
        raise ValueError("KERF_PUBLIC_URL (this server's public origin) or KERF_MCP_AUDIENCE is required to turn on KERF_MCP with DINO sign-in")
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    db = Database(settings.db_url)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        db.create_all()
        seed(db, settings)
        yield
        app.state.hub.close()

    app = FastAPI(title="Kerf Server", version=__version__, lifespan=lifespan, docs_url=f"{API}/docs", openapi_url=f"{API}/openapi.json")
    app.state.settings = settings
    app.state.db = db
    app.state.throttle = IpThrottle()
    from .services_email import Mailer
    from .services_staffmail import LinkThrottle

    app.state.mailer = Mailer.from_settings(settings)  # sign-in links and invites (Resend; kept in memory without RESEND_API)
    app.state.link_throttle = LinkThrottle()
    app.state.sso = Verifier(settings) if settings.sso_enabled else None
    app.state.download_links = {}  # Cutter download links: random link -> expiry (in memory: a restart just means making a new one)
    app.state.hub = Hub(settings.data_dir / "logs", settings.log_max_bytes, settings.log_backups)
    errors.install(app)

    if settings.cors_origins:
        app.add_middleware(CORSMiddleware, allow_origins=list(settings.cors_origins), allow_credentials=False, allow_methods=["*"], allow_headers=["*"])

    api = APIRouter(prefix=API)
    api.include_router(auth.router)
    api.include_router(catalog.router)
    api.include_router(schools.router)
    api.include_router(classes.router)
    api.include_router(groups.router)
    api.include_router(activities.router)
    api.include_router(dxf.router)
    api.include_router(jobs.router)
    api.include_router(workspace.router)
    api.include_router(stations.router)
    api.include_router(cutter.router)
    api.include_router(cutter_ws.router)  # /api/v1/ws/cutter
    app.include_router(api)

    if settings.mcp_enabled:  # before the Editor mount, which would otherwise answer "/mcp"
        app.include_router(mcp_routes.router)
        mcp_log = logging.getLogger("kerf.mcp")  # who read what (IDs and tool names only) must reach the console even when nothing else configures logging
        if not mcp_log.handlers:
            h = logging.StreamHandler()
            h.setFormatter(logging.Formatter("%(asctime)s %(name)s %(message)s"))
            mcp_log.addHandler(h)
            mcp_log.setLevel(logging.INFO)

    @app.get("/health", include_in_schema=False)
    def health() -> dict[str, str]:
        return {"status": "ok", "version": __version__}

    dist = settings.editor_dist
    if dist and Path(dist).exists():
        from .webpages import add_site_routes

        add_site_routes(app, Path(dist))  # /, /pricing, /sign-in, /editor/, /admin/ (see webpages.py); then the files themselves
        app.mount("/", StaticFiles(directory=str(dist), html=True), name="editor")
    return app
