"""Bearer-token authentication. Roles: pupil (own jobs), teacher (their school's classes), admin (their whole school),
station (a school's laser PC and Cutter) and platform (creates schools; sees inside none of them). Everyone but the
platform belongs to exactly one school and can never see another school's data."""
from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass

from fastapi import Depends, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import Database, as_utc, utcnow
from .errors import ApiError
from .models import DEFAULT_SCHOOL, Token

ROLES = ("pupil", "teacher", "admin", "station", "platform")
#: Roles a DINO sign-in can give. `technician` runs the laser stations and nothing else; it is never a stored token.
SSO_ROLES = ("pupil", "teacher", "admin", "technician")
#: Roles that, when DINO is the only way in, may only be held by a DINO sign-in (never by a long-lived token).
PERSON_ROLES = ("pupil", "teacher", "admin", "technician")
_PREFIX = {"pupil": "kp", "teacher": "kt", "admin": "ka", "station": "ks", "platform": "kx"}


@dataclass(frozen=True)
class Principal:
    role: str
    id: str
    school: str | None = None  # None only for the platform role

    @property
    def is_teacher(self) -> bool:
        """Teachers and school admins (an admin can do everything a teacher can, for every class in the school)."""
        return self.role in ("teacher", "admin")

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"

    @property
    def is_station(self) -> bool:
        return self.role == "station"

    @property
    def is_technician(self) -> bool:
        return self.role == "technician"

    @property
    def can_override_queue(self) -> bool:
        """Teachers, admins and technicians (who run the lasers) may skip the queue, which a camera calibration needs."""
        return self.role in ("teacher", "admin", "technician")

    def staff(self) -> bool:
        """Teachers, admins, technicians and stations see every job in their school; pupils only their own."""
        return self.role in ("teacher", "admin", "technician", "station")


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def new_token(role: str) -> str:
    return f"{_PREFIX[role]}_{secrets.token_urlsafe(24)}"


def issue_token(db: Database, role: str, subject_id: str, label: str | None = None, school: str | None = None) -> str:
    """Everyone except the platform belongs to a school: the default school unless another is named."""
    school = None if role == "platform" else (school or DEFAULT_SCHOOL)
    if role not in ROLES:
        raise ValueError(f"role must be one of {ROLES}")
    if not subject_id or len(subject_id) > 64 or not all(c.isalnum() or c in "_-" for c in subject_id):
        raise ValueError("id may only contain letters, digits, '_' and '-' (it is an ID, never a name)")
    token = new_token(role)
    with db.session() as s:
        s.add(Token(token_hash=hash_token(token), role=role, subject_id=subject_id, label=label, school_id=school))
    return token


def lookup(session: Session, token: str, people_tokens: bool = True) -> Principal | None:
    """`people_tokens` False (DINO is the only way in): only stations and the platform owner may hold a stored token."""
    row = session.scalar(select(Token).where(Token.token_hash == hash_token(token), Token.revoked.is_(False)))
    if row is not None and not people_tokens and row.role in PERSON_ROLES:
        return None
    if row is None or (row.expires_at is not None and as_utc(row.expires_at) <= utcnow()):
        return None  # unknown, revoked or expired
    return Principal(row.role, row.subject_id, None if row.role == "platform" else (row.school_id or DEFAULT_SCHOOL))


def bearer(request: Request) -> str | None:
    h = request.headers.get("authorization", "")
    if h.lower().startswith("bearer "):
        return h[7:].strip() or None
    return None


def current_principal(request: Request) -> Principal:
    token = bearer(request)
    if not token:
        raise ApiError(401, "unauthorized", "Send your token as 'Authorization: Bearer <token>'.")
    from .sso import looks_like_jwt

    if looks_like_jwt(token):  # a planner-004 (DINO) sign-in; never a station or the platform
        sso = getattr(request.app.state, "sso", None)
        if sso is None:
            raise ApiError(401, "unauthorized", "Sign-in with DINO is not turned on for this server.")
        return sso.principal(token)
    db: Database = request.app.state.db
    with db.session() as s:
        p = lookup(s, token, request.app.state.settings.auth_mode != "planner")
    if p is None:
        raise ApiError(401, "unauthorized", "That token is not recognised or has been revoked.")
    return p


def require(*roles: str):
    """Dependency: the caller must hold one of these roles. Teachers pass for pupil endpoints, and admins wherever teachers do."""
    allowed = set(roles) | ({"teacher"} if "pupil" in roles else set())
    allowed |= {"admin"} if "teacher" in allowed else set()
    allowed |= {"technician"} if "station" in allowed else set()  # a technician runs the laser stations from the browser

    def dep(p: Principal = Depends(current_principal)) -> Principal:
        if p.role not in allowed:
            raise ApiError(403, "forbidden", f"This needs one of: {', '.join(sorted(allowed))}.")
        return p

    return dep
