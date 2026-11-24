"""Per-school sign-in methods (docs/ACCOUNTS.md) and the identities linked to each person.

A school's admins switch methods on and off. Google and Microsoft stay off until Kerf has been registered with them (the site
admin's job: KERF_GOOGLE_CLIENT_ID / KERF_MICROSOFT_CLIENT_ID) and a school admin turns them on. DINO sign-ins belong to the one
school this server links DINO to (KERF_SSO_SCHOOL). A school cannot switch off every way its staff sign in.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from .config import Settings
from .db import utcnow
from .errors import ApiError
from .models import Identity, School

METHODS = ("dino", "google", "microsoft", "groupCode", "email")
STAFF_METHODS = ("dino", "google", "microsoft", "email")
#: A new school: pupils by group code, staff by email link, everything else off until an admin turns it on.
NEW_SCHOOL = {"dino": False, "google": False, "microsoft": False, "groupCode": True, "email": True}
#: A school from before per-school sign-in: it used DINO only.
LEGACY = {"dino": True, "google": False, "microsoft": False, "groupCode": False, "email": False}
#: Methods whose sign-in screens exist yet. The others can be set ahead but say "coming".
AVAILABLE = {"dino"}


def methods(row: School | None) -> dict[str, Any]:
    stored = (row.sign_in if row is not None else None) or {}
    base = dict(LEGACY if row is None or row.sign_in is None else NEW_SCHOOL)
    base.update({k: bool(v) for k, v in stored.items() if k in METHODS})
    return {**base, "googleDomain": stored.get("googleDomain") or None, "microsoftTenant": stored.get("microsoftTenant") or None}


def doc(row: School, cfg: Settings) -> dict[str, Any]:
    """The school's sign-in settings, with what each method needs before it can be turned on."""
    m = methods(row)
    ready = {"dino": cfg.sso_enabled and row.id == cfg.sso_school, "google": bool(cfg.google_client_id), "microsoft": bool(cfg.microsoft_client_id),
             "groupCode": True, "email": True}
    return {"methods": {k: m[k] for k in METHODS}, "googleDomain": m["googleDomain"], "microsoftTenant": m["microsoftTenant"],
            "canEnable": ready, "available": {k: k in AVAILABLE for k in METHODS}}


def update(s: Session, cfg: Settings, school_id: str, body: dict[str, Any]) -> School:
    row = s.get(School, school_id)
    if row is None:
        raise ApiError(404, "not_found", "There is no such school.")
    m = methods(row)
    ready = doc(row, cfg)["canEnable"]
    for k, v in (body.get("methods") or {}).items():
        if k not in METHODS or not isinstance(v, bool):
            raise ApiError(422, "invalid", f"methods are {', '.join(METHODS)}, each true or false.")
        if v and not m[k] and not ready[k]:
            why = {"dino": "DINO sign-in is linked to another school on this server.",
                   "google": "Kerf has not been registered with Google yet.", "microsoft": "Kerf has not been registered with Microsoft yet."}.get(k, "")
            raise ApiError(409, "not_set_up", f"{k} cannot be turned on yet. {why}")
        m[k] = v
    for k in ("googleDomain", "microsoftTenant"):
        if k in body:
            v = body[k]
            if v is not None and (not isinstance(v, str) or len(v) > 120 or " " in v.strip()):
                raise ApiError(422, "invalid", f"{k} is a domain or tenant ID, or null.")
            m[k] = (v or "").strip().lower() or None
    if not any(m[k] for k in STAFF_METHODS):
        raise ApiError(409, "would_lock_out", "Keep at least one way for staff to sign in on (DINO, Google, Microsoft or an email link).")
    row.sign_in = {k: m[k] for k in (*METHODS, "googleDomain", "microsoftTenant")}
    return row


def allowed(s: Session, school_id: str | None, method: str) -> bool:
    return bool(methods(s.get(School, school_id) if school_id else None).get(method))


def remember(s: Session, provider: str, subject: str, person_id: str, school_id: str) -> Identity:
    """Link a sign-in to a person (first time), or note that it was used again."""
    row = s.get(Identity, (provider, subject))
    if row is None:
        row = Identity(provider=provider, subject=subject, person_id=person_id, school_id=school_id)
        s.add(row)
    row.last_seen = utcnow()
    return row
