"""Schools, and the staff (admins, teachers, station tokens) who belong to them.

A school is the wall between organisations: classes, pupils, activities, files, lasers, the queue and materials all
belong to one school, and nobody in it can see or change another school's. The platform role (the person running the
server) creates schools and their first admin, and sees nothing inside a school.
"""
from __future__ import annotations

import re
import secrets

from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import Database, iso
from .errors import ApiError
from .models import School, Token
from .security import ROLES, issue_token
from .services_seed import seed_presets

SCHOOL_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,31}$")
PLANS = ("free", "paid")
#: Letters and digits that cannot be mistaken for one another when read off a card or a board (no 0/O, 1/I/L, 5/S, 2/Z, 8/B).
CODE_ALPHABET = "ACDEFGHJKMNPQRTUVWXY34679"
CODE_LENGTH = 5
STAFF_ROLES = ("admin", "teacher", "station")


def auto_approve_on(s: Session, school_id: str | None, default: bool) -> bool:
    row = s.get(School, school_id) if school_id else None
    return default if row is None or row.auto_approve is None else bool(row.auto_approve)


def plan_of(row: School | None) -> str:
    """A school made before plans existed (NULL) counts as paid."""
    return "paid" if row is None or row.plan is None else row.plan


def is_paid(s: Session, school_id: str | None) -> bool:
    """May this school send files to the laser (paid, or free terms that include it)?"""
    from . import services_terms as terms

    return terms.has(s, school_id, "laser")


def require_paid(s: Session, school_id: str | None, feature: str = "laser") -> None:
    from . import services_terms as terms

    terms.require(s, school_id, feature)


def check_limit(s: Session, school_id: str | None, limit: str, current: int, adding: int = 1) -> None:
    """409 `limit_reached` past one of the school's limits (`services_terms`)."""
    from . import services_terms as terms

    terms.check_limit(s, school_id, limit, current, adding)


def new_school_code(s: Session) -> str:
    """A short school code, unique across Kerf: what a pupil types with their group code, pupil ID and password."""
    for _ in range(100):
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
        if s.scalar(select(School).where(School.code == code)) is None:
            return code
    raise ApiError(500, "error", "Could not make a school code. Try again.")


def ensure_codes(s: Session) -> None:
    """Every school has a school code (schools made before codes existed get one)."""
    for row in s.scalars(select(School).where(School.code.is_(None))):
        row.code = new_school_code(s)
        s.flush()


def school_doc(s: School, default_auto_approve: bool = True) -> dict:
    return {"id": s.id, "name": s.name, "code": s.code, "plan": plan_of(s), "createdAt": iso(s.created_at),
            "autoApprove": default_auto_approve if s.auto_approve is None else bool(s.auto_approve)}


def set_plan(s: Session, school_id: str, plan: str) -> School:
    if plan not in PLANS:
        raise ApiError(422, "invalid", "plan is free or paid.")
    row = s.get(School, school_id)
    if row is None:
        raise ApiError(404, "not_found", f"There is no school '{school_id}'.")
    row.plan = plan
    if plan == "free" and row.terms is None:
        from . import services_terms as terms

        row.terms = terms.snapshot(terms.get_default(s))
    return row


def list_schools(s: Session) -> list[dict]:
    return [school_doc(x) for x in s.scalars(select(School).order_by(School.id))]


NAME_MAX = 128


def clean_school_name(raw: object) -> str:
    """A school's display name: trimmed, 1 to 128 characters, no control characters (else 422 invalid). The school ID and code never change with it."""
    if raw is not None and not isinstance(raw, str):
        raise ApiError(422, "invalid", "The school's name is text.")
    name = (raw or "").strip()
    if not name:
        raise ApiError(422, "invalid", "Give the school a name.")
    if not name.isprintable():
        raise ApiError(422, "invalid", "The school's name cannot have line breaks or other control characters.")
    if len(name) > NAME_MAX:
        raise ApiError(422, "invalid", f"The school's name can be up to {NAME_MAX} characters.")
    return name


def create_school(s: Session, school_id: str, name: str, plan: str = "free") -> School:
    school_id = (school_id or "").strip().lower()
    if not SCHOOL_ID_RE.match(school_id):
        raise ApiError(422, "invalid", "A school ID is lower-case letters, digits and - (up to 32), e.g. westfield-high.")
    if not (name or "").strip():
        raise ApiError(422, "invalid", "Give the school a name.")
    if s.get(School, school_id) is not None:
        raise ApiError(409, "conflict", f"There is already a school '{school_id}'.")
    if plan not in PLANS:
        raise ApiError(422, "invalid", "plan is free or paid.")
    from .services_signin import NEW_SCHOOL

    from . import services_terms as terms

    school = School(id=school_id, name=name.strip()[:128], plan=plan, code=new_school_code(s), sign_in=dict(NEW_SCHOOL),
                    terms=terms.snapshot(terms.get_default(s)) if plan == "free" else None)  # a copy: later default changes leave it alone
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
