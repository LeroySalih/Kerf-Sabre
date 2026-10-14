"""Schools, and the staff (admins, teachers, station tokens) who belong to them.

A school is the wall between organisations: classes, pupils, activities, files, lasers, the queue and materials all
belong to one school, and nobody in it can see or change another school's. The platform role (the person running the
server) creates schools and their first admin, and sees nothing inside a school.
"""
from __future__ import annotations

import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import Database, iso
from .errors import ApiError
from .models import School, Token
from .security import ROLES, issue_token
from .services_seed import seed_presets

SCHOOL_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
STAFF_ROLES = ("admin", "teacher", "station")


def school_doc(s: School) -> dict:
    return {"id": s.id, "name": s.name, "createdAt": iso(s.created_at)}


def list_schools(s: Session) -> list[dict]:
    return [school_doc(x) for x in s.scalars(select(School).order_by(School.id))]


def create_school(s: Session, school_id: str, name: str) -> School:
    school_id = (school_id or "").strip().lower()
    if not SCHOOL_ID_RE.match(school_id):
        raise ApiError(422, "invalid", "A school ID is lower-case letters, digits and - (up to 32), e.g. bisak.")
    if not (name or "").strip():
        raise ApiError(422, "invalid", "Give the school a name.")
    if s.get(School, school_id) is not None:
        raise ApiError(409, "conflict", f"There is already a school '{school_id}'.")
    school = School(id=school_id, name=name.strip()[:128])
    s.add(school)
    s.flush()
    seed_presets(s, school_id)
    return school


def staff(s: Session, school: str) -> list[dict]:
    q = select(Token).where(Token.school_id == school, Token.role.in_(STAFF_ROLES), Token.revoked.is_(False)).order_by(Token.role, Token.subject_id)
    return [{"role": t.role, "id": t.subject_id, "label": t.label, "createdAt": iso(t.created_at)} for t in s.scalars(q)]


def add_staff(db: Database, school: str, role: str, subject_id: str, label: str | None) -> str:
    """A new teacher, admin or station token for the school. Returned once: only its hash is stored."""
    if role not in STAFF_ROLES:
        raise ApiError(422, "invalid", f"role must be one of {', '.join(STAFF_ROLES)}.")
    try:
        return issue_token(db, role, subject_id, label, school)
    except ValueError as exc:
        raise ApiError(422, "invalid", str(exc)) from exc


def revoke_staff(s: Session, school: str, subject_id: str) -> int:
    n = 0
    for t in s.scalars(select(Token).where(Token.school_id == school, Token.subject_id == subject_id, Token.role.in_(STAFF_ROLES), Token.revoked.is_(False))):
        t.revoked = True
        n += 1
    if n == 0:
        raise ApiError(404, "not_found", f"There is no teacher, admin or station '{subject_id}' in this school.")
    return n
