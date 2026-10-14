"""Bearer-token authentication. Three roles: pupil (own jobs), teacher (everything), station (laser PCs and Cutters)."""
from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass

from fastapi import Depends, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import Database, as_utc, utcnow
from .errors import ApiError
from .models import Token

ROLES = ("pupil", "teacher", "station")
_PREFIX = {"pupil": "kp", "teacher": "kt", "station": "ks"}


@dataclass(frozen=True)
class Principal:
    role: str
    id: str

    @property
    def is_teacher(self) -> bool:
        return self.role == "teacher"

    @property
    def is_station(self) -> bool:
        return self.role == "station"

    def staff(self) -> bool:
        """Teachers and stations see every job; pupils only their own."""
        return self.role in ("teacher", "station")


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def new_token(role: str) -> str:
    return f"{_PREFIX[role]}_{secrets.token_urlsafe(24)}"


def issue_token(db: Database, role: str, subject_id: str, label: str | None = None) -> str:
    if role not in ROLES:
        raise ValueError(f"role must be one of {ROLES}")
    if not subject_id or len(subject_id) > 64 or not all(c.isalnum() or c in "_-" for c in subject_id):
        raise ValueError("id may only contain letters, digits, '_' and '-' (it is an ID, never a name)")
    token = new_token(role)
    with db.session() as s:
        s.add(Token(token_hash=hash_token(token), role=role, subject_id=subject_id, label=label))
    return token


def lookup(session: Session, token: str) -> Principal | None:
    row = session.scalar(select(Token).where(Token.token_hash == hash_token(token), Token.revoked.is_(False)))
    if row is None or (row.expires_at is not None and as_utc(row.expires_at) <= utcnow()):
        return None  # unknown, revoked or expired
    return Principal(row.role, row.subject_id)


def bearer(request: Request) -> str | None:
    h = request.headers.get("authorization", "")
    if h.lower().startswith("bearer "):
        return h[7:].strip() or None
    return None


def current_principal(request: Request) -> Principal:
    token = bearer(request)
    if not token:
        raise ApiError(401, "unauthorized", "Send your token as 'Authorization: Bearer <token>'.")
    db: Database = request.app.state.db
    with db.session() as s:
        p = lookup(s, token)
    if p is None:
        raise ApiError(401, "unauthorized", "That token is not recognised or has been revoked.")
    return p


def require(*roles: str):
    """Dependency: the caller must hold one of these roles. Teachers always pass for pupil endpoints."""
    allowed = set(roles) | ({"teacher"} if "pupil" in roles else set())

    def dep(p: Principal = Depends(current_principal)) -> Principal:
        if p.role not in allowed:
            raise ApiError(403, "forbidden", f"This needs one of: {', '.join(sorted(allowed))}.")
        return p

    return dep
