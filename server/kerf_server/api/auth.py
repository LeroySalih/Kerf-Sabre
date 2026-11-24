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
from .. import services_people as ps
from ..security import SSO_ROLES, Principal, bearer, current_principal, hash_token

router = APIRouter(tags=["auth"])


@router.get("/auth/me")
def me(p: Principal = Depends(current_principal), s: Session = Depends(get_session)) -> dict[str, Any]:
    from ..services_schools import plan_of
    from ..models import School

    from .. import services_terms as terms

    row = s.get(School, p.school) if p.school else None
    now = terms.effective(row) if p.school else None
    return {"role": p.role, "id": p.id, "school": p.school, "siteAdmin": p.site_admin, "plan": plan_of(row) if p.school else None,
            "schoolName": row.name if row else None, "schoolCode": row.code if row else None,
            "features": now["features"] if now else None, "limits": now["limits"] if now else None}


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


@router.post("/auth/profile")
def profile(request: Request, p: Principal = Depends(current_principal), s: Session = Depends(get_session)) -> dict[str, str | None]:
    """Remember this DINO person's display name so staff see it instead of an ID. Asks DINO (userinfo, with the caller's own token); the
    name is stored for staff of their school only, never logged and never an email. A failure is not an error: the ID is shown instead."""
    sso = getattr(request.app.state, "sso", None)
    if sso is None or p.role not in SSO_ROLES:
        return {"name": None}
    from ..services_signin import remember as link

    if p.school:
        link(s, "dino", p.id, p.id, p.school)  # the DINO account is this person's DINO identity (their Kerf ID is the DINO ID)
    name = ps.remember(s, p.id, p.school, sso.userinfo_name(bearer(request) or ""))
    return {"name": name}


@router.post("/auth/logout", status_code=204)
def logout(request: Request, _: Principal = Depends(current_principal), s: Session = Depends(get_session)):
    row = s.scalar(select(Token).where(Token.token_hash == hash_token(bearer(request) or "")))
    if row is not None and row.expires_at is not None:  # only login sessions: an administrator's token is revoked with kerf-admin
        row.revoked = True
    return Response(status_code=204)


@router.post("/auth/email/start")
def email_start(request: Request, body: dict[str, Any] = Body(...), s: Session = Depends(get_session), cfg: Settings = Depends(get_settings)) -> dict[str, Any]:
    """Staff: email me a sign-in link (`{email, app: admin|editor}`). The same answer whether or not the address has an account."""
    from .. import services_staffmail as sm

    ip = request.client.host if request.client else "unknown"
    return sm.start(s, request.app.state.mailer, cfg, request.app.state.link_throttle, str(request.base_url), ip, body)


@router.post("/auth/email/finish")
def email_finish(body: dict[str, Any] = Body(...), s: Session = Depends(get_session), cfg: Settings = Depends(get_settings)) -> dict[str, Any]:
    """Trade a sign-in link's token for a session (`{token}` -> `{token, role, id, name, expiresAt}`). A link works once."""
    from .. import services_staffmail as sm

    return sm.finish(s, cfg, body)


@router.post("/auth/pupil")
def pupil_card_login(request: Request, body: dict[str, Any] = Body(...), s: Session = Depends(get_session), cfg: Settings = Depends(get_settings)) -> dict[str, Any]:
    """Pupils: sign in with the Pupil Card (`{schoolCode, groupCode, pupilId, password}`) -> `{token, role, id, classCode, expiresAt}`.
    Works on every server whose school has Group code sign-in on; wrong anything is the same 401."""
    for k in ("schoolCode", "groupCode", "pupilId", "password"):
        if not isinstance(body.get(k), str) or not body[k].strip():
            raise ApiError(422, "invalid", "Fill in your school code, group code, pupil ID and password.")
    ip = request.client.host if request.client else "unknown"
    return sc.group_login(s, cfg, request.app.state.throttle, ip, body["schoolCode"], body["groupCode"], body["pupilId"], body["password"])
