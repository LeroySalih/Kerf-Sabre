"""Application factory."""
from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from . import __version__, errors
from .api import activities, auth, catalog, classes, cutter, cutter_ws, dxf, jobs, schools, stations, workspace
from .config import Settings
from .db import Database
from .services_seed import seed
from .services_classes import IpThrottle
from .sso import Verifier
from .stations import Hub

API = "/api/v1"


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    if settings.auth_mode not in ("pins", "planner", "both"):
        raise ValueError(f"KERF_AUTH_MODE must be pins, planner or both, not {settings.auth_mode!r}")
    if settings.sso_enabled and not settings.sso_issuer.startswith(("https://", "http://")):
        raise ValueError("KERF_SSO_ISSUER (planner-004's public origin) is required when KERF_AUTH_MODE is planner or both")
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    db = Database(settings.db_url)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        db.create_all()
        seed(db, settings)
        yield
        app.state.hub.close()

    app = FastAPI(title="BISAK Kerf Server", version=__version__, lifespan=lifespan, docs_url=f"{API}/docs", openapi_url=f"{API}/openapi.json")
    app.state.settings = settings
    app.state.db = db
    app.state.throttle = IpThrottle()
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
    api.include_router(activities.router)
    api.include_router(dxf.router)
    api.include_router(jobs.router)
    api.include_router(workspace.router)
    api.include_router(stations.router)
    api.include_router(cutter.router)
    api.include_router(cutter_ws.router)  # /api/v1/ws/cutter
    app.include_router(api)

    @app.get("/health", include_in_schema=False)
    def health() -> dict[str, str]:
        return {"status": "ok", "version": __version__}

    dist = settings.editor_dist
    if dist and Path(dist).exists():
        app.mount("/", StaticFiles(directory=str(dist), html=True), name="editor")
    return app
