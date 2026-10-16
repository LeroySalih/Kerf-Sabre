"""Who am I, class login/logout."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import services_classes as sc
from ..config import Settings
from ..deps import get_session, get_settings
from ..errors import ApiError
from ..models import Token
from ..sso import auth_config
from ..security import Principal, bearer, current_principal, hash_token

router = APIRouter(tags=["auth"])


@router.get("/auth/me")
def me(p: Principal = Depends(current_principal)) -> dict[str, str | None]:
    return {"role": p.role, "id": p.id, "school": p.school}


@router.get("/auth/config")
def config(cfg: Settings = Depends(get_settings)) -> dict[str, Any]:
    return auth_config(cfg)


@router.post("/auth/login")
def login(request: Request, body: dict[str, Any] = Body(...), s: Session = Depends(get_session), cfg: Settings = Depends(get_settings)):
    if cfg.auth_mode == "planner":
        raise ApiError(404, "sso_only", "This server uses DINO sign-in. Use 'Sign in with DINO'.")
    for k in ("classCode", "pupilId", "pin"):
        if not isinstance(body.get(k), str) or not body[k].strip():
            raise ApiError(422, "invalid", "Enter your class code, pupil ID and PIN.")
    ip = request.client.host if request.client else "unknown"
    return sc.login(s, cfg, request.app.state.throttle, ip, body["classCode"], body["pupilId"], body["pin"])


@router.post("/auth/logout", status_code=204)
def logout(request: Request, _: Principal = Depends(current_principal), s: Session = Depends(get_session)):
    row = s.scalar(select(Token).where(Token.token_hash == hash_token(bearer(request) or "")))
    if row is not None and row.expires_at is not None:  # only login sessions: an administrator's token is revoked with kerf-admin
        row.revoked = True
    return Response(status_code=204)
