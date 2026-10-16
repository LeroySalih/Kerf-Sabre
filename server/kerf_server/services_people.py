"""Display names for staff to read. Taken from DINO's userinfo at sign-in; never logged, never sent to pupils, never an email."""
from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from .db import utcnow
from .models import Person


def clean_name(raw: object) -> str | None:
    """A readable name, or None: no control characters, no '@' (an email is not a name), at most 128 characters."""
    if not isinstance(raw, str):
        return None
    name = " ".join("".join(c for c in raw if c.isprintable()).split())[:128]
    return name if name and "@" not in name else None


def remember(s: Session, person_id: str, school: str | None, raw_name: object) -> str | None:
    name = clean_name(raw_name)
    if name is None:
        return None
    row = s.get(Person, person_id)
    if row is None:
        s.add(Person(person_id=person_id, school_id=school, display_name=name))
    else:
        row.school_id, row.display_name, row.updated_at = school, name, utcnow()
    return name


def names(s: Session, school: str | None, ids: Iterable[str]) -> dict[str, str]:
    """Names for these IDs, only those of this school."""
    ids = list({i for i in ids if i})
    if not ids:
        return {}
    return {p.person_id: p.display_name for p in s.scalars(select(Person).where(Person.person_id.in_(ids), Person.school_id == school))}


def forget(s: Session, person_id: str) -> None:
    s.execute(delete(Person).where(Person.person_id == person_id))
