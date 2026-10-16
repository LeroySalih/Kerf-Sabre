"""Settings, read from KERF_* environment variables so the same code runs on a laptop, in Docker and on the VPS."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _bool(value: str | None, default: bool) -> bool:
    if value is None or value == "":
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _find_shared() -> Path:
    """The folder holding the JSON schemas: KERF_SHARED_DIR, else ../shared next to this repo, else ./shared."""
    env = os.environ.get("KERF_SHARED_DIR")
    if env:
        return Path(env)
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "shared" / "job.schema.json").exists():
            return parent / "shared"
    return Path("shared")


@dataclass(frozen=True)
class Settings:
    data_dir: Path = Path("data")
    database_url: str = ""
    shared_dir: Path = field(default_factory=_find_shared)
    #: Directory with the built Editor (editor/dist). When it exists the server also serves the Editor at "/".
    editor_dist: Path | None = None
    #: The portable Cutter zip made by cutter/build_cutter.py. None: use cutter/build/kerf-cutter.zip next to the repo's shared/ folder if it exists.
    cutter_zip: Path | None = None
    #: A pupil's new send replaces their earlier files that are still waiting (they go to the back of the queue). Turn off to let a pupil have several waiting at once.
    replace_old_sends: bool = True
    #: Submitted jobs wait for a teacher. Turn off to send them straight to the station queue.
    require_approval: bool = True
    #: A job must have been framed on a station (laser off) shortly before it can run there.
    require_frame: bool = True
    frame_valid_minutes: int = 30
    #: "block": an open path on the Cut layer rejects the job. "warn": it is cut as drawn, with a warning.
    open_cut_paths: str = "block"
    max_upload_mb: int = 20
    #: Seconds a run_job may wait for the Cutter's answer before the job returns to the queue.
    ack_timeout_s: float = 20.0
    cors_origins: tuple[str, ...] = ()
    #: How long a class-login session lasts.
    session_hours: float = 10.0
    #: Wrong PINs in a row before a pupil is locked out, and for how long.
    login_max_failures: int = 5
    login_lockout_minutes: float = 5.0
    #: Failed logins allowed from one address in `login_ip_window_s` before it is slowed down.
    login_ip_failures: int = 30
    login_ip_window_s: float = 300.0
    #: How people sign in. "pins": class code + PIN only (default). "planner": planner-004 (DINO) sign-in only. "both": either.
    auth_mode: str = "pins"
    #: planner-004's public origin (the JWT `iss`), e.g. https://dino.mr-salih.org. Required unless auth_mode is "pins".
    sso_issuer: str = ""
    sso_audience: str = "kerf-sabre"
    #: Where the signing keys are published. Empty: <issuer>/oauth/jwks.
    sso_jwks_url: str = ""
    sso_client_editor: str = "kerf-editor"
    sso_client_admin: str = "kerf-admin"
    #: planner-004 `technician` counts as a Kerf teacher.
    sso_technician_is_teacher: bool = True
    log_max_bytes: int = 5_000_000
    log_backups: int = 5

    @property
    def sso_enabled(self) -> bool:
        return self.auth_mode in ("planner", "both")

    @property
    def db_url(self) -> str:
        return self.database_url or f"sqlite:///{(self.data_dir / 'kerf.db').resolve()}"

    @staticmethod
    def from_env(**overrides) -> "Settings":
        e = os.environ
        dist = e.get("KERF_EDITOR_DIST")
        base = Settings(
            data_dir=Path(e.get("KERF_DATA_DIR", "data")),
            database_url=e.get("KERF_DATABASE_URL", ""),
            editor_dist=Path(dist) if dist else None,
            cutter_zip=Path(e["KERF_CUTTER_ZIP"]) if e.get("KERF_CUTTER_ZIP") else None,
            replace_old_sends=_bool(e.get("KERF_REPLACE_OLD_SENDS"), True),
            require_approval=_bool(e.get("KERF_REQUIRE_APPROVAL"), True),
            require_frame=_bool(e.get("KERF_REQUIRE_FRAME"), True),
            frame_valid_minutes=int(e.get("KERF_FRAME_VALID_MINUTES", "30")),
            open_cut_paths=e.get("KERF_OPEN_CUT_PATHS", "block"),
            max_upload_mb=int(e.get("KERF_MAX_UPLOAD_MB", "20")),
            ack_timeout_s=float(e.get("KERF_ACK_TIMEOUT_S", "20")),
            session_hours=float(e.get("KERF_SESSION_HOURS", "10")),
            login_max_failures=int(e.get("KERF_LOGIN_MAX_FAILURES", "5")),
            login_lockout_minutes=float(e.get("KERF_LOGIN_LOCKOUT_MINUTES", "5")),
            auth_mode=e.get("KERF_AUTH_MODE", "pins").strip().lower(),
            sso_issuer=e.get("KERF_SSO_ISSUER", "").strip().rstrip("/"),
            sso_audience=e.get("KERF_SSO_AUDIENCE", "kerf-sabre"),
            sso_jwks_url=e.get("KERF_SSO_JWKS_URL", "").strip(),
            sso_client_editor=e.get("KERF_SSO_CLIENT_EDITOR", "kerf-editor"),
            sso_client_admin=e.get("KERF_SSO_CLIENT_ADMIN", "kerf-admin"),
            sso_technician_is_teacher=_bool(e.get("KERF_SSO_TECHNICIAN_IS_TEACHER"), True),
            cors_origins=tuple(o.strip() for o in e.get("KERF_CORS_ORIGINS", "").split(",") if o.strip()),
        )
        return replace_settings(base, **overrides) if overrides else base


def replace_settings(s: Settings, **overrides) -> Settings:
    from dataclasses import replace

    return replace(s, **overrides)
