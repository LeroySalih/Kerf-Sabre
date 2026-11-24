"""Import a teacher's DINO classes as Kerf groups, and re-sync them later (docs/ACCOUNTS.md: "Importing links the group to the
provider's group so it can be refreshed"; "Re-sync from a source removes a pupil from the group only (account and files kept)
and shows the changes for the teacher to confirm first").

The class list comes from DINO with the teacher's own DINO sign-in (`Verifier.groups`), so a teacher only ever sees and imports
their own classes. A group made this way has `source="dino"` and `source_id` = DINO's class id. Pupil IDs are DINO IDs; DINO gives
no names (a pupil's name appears once they have signed in to Kerf).
"""
from __future__ import annotations

from typing import Any

from fastapi import Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import services_classes as sc
from .errors import ApiError
from .models import SchoolClass
from .security import Principal, bearer


def dino_classes(request: Request, who: Principal) -> list[dict[str, Any]]:
    """The teacher's DINO classes (`[{id, name, subject, yearGroup, pupils}]`). Needs a DINO sign-in."""
    from .sso import looks_like_jwt

    sso = getattr(request.app.state, "sso", None)
    token = bearer(request) or ""
    if sso is None or not looks_like_jwt(token):
        raise ApiError(409, "dino_needed", "Sign in with DINO to import your DINO classes.")
    try:
        return sso.groups(token)
    except Exception as e:  # DINO down, the `groups` scope missing (an older sign-in), a bad answer
        raise ApiError(502, "groups_unavailable", "Could not get your classes from DINO. Sign out and in again, then retry.") from e


def _linked(s: Session, school: str | None, dino_id: str) -> SchoolClass | None:
    return s.scalar(select(SchoolClass).where(SchoolClass.school_id == school, SchoolClass.source == "dino", SchoolClass.source_id == dino_id))


def listing(s: Session, who: Principal, groups: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """For the import dialog: each DINO class, how many pupils, and the Kerf group it is already imported as (if any)."""
    out = []
    for g in groups:
        c = _linked(s, who.school, g["id"])
        out.append({"id": g["id"], "name": g["name"], "subject": g.get("subject"), "yearGroup": g.get("yearGroup"), "pupilCount": len(g["pupils"]),
                    "importedAs": c.code if c else None, "archived": bool(c.archived) if c else False})
    return out


def import_classes(s: Session, who: Principal, groups: list[dict[str, Any]], ids: list[str]) -> list[dict[str, Any]]:
    """Make a Kerf group for each chosen DINO class (named after it, owned by this teacher, a code made by Kerf) with its pupils.
    A class already imported is left alone (re-sync it instead)."""
    by_id = {g["id"]: g for g in groups}
    out = []
    for gid in ids:
        g = by_id.get(gid)
        if g is None:
            raise ApiError(404, "not_found", "That is not one of your DINO classes.")
        old = _linked(s, who.school, gid)
        if old is not None:
            out.append({"dinoId": gid, "code": old.code, "name": g["name"], "already": True})
            continue
        label = g["name"] if not g.get("subject") or g["subject"] in g["name"] else f'{g["name"]} · {g["subject"]}'
        label = label[:128]
        c = sc.create_class(s, None, label, teacher_id=who.id, school=who.school, source="dino", source_id=gid)
        r = sc.add_pupils(s, c.code, g["pupils"], school=who.school) if g["pupils"] else {"created": [], "added": [], "restored": [], "existing": [], "conflicts": []}
        out.append({"dinoId": gid, "code": c.code, "name": g["name"], "already": False,
                    "pupils": len(r["created"]) + len(r["added"]) + len(r["restored"]), "conflicts": r["conflicts"]})
    return out


def sync(s: Session, who: Principal, groups: list[dict[str, Any]], code: str, apply: bool) -> dict[str, Any]:
    """Compare a DINO-linked group with its DINO class: who would be added and who removed. With `apply`, make the changes: new
    pupils are added; pupils no longer in the class leave this group only (out of their last group they are archived, files kept)."""
    c = sc.get_class(s, code, None if who.is_admin else who.id, who.school)
    if c.source != "dino" or not c.source_id:
        raise ApiError(409, "not_linked", "This group was not imported from DINO.")
    g = next((x for x in groups if x["id"] == c.source_id), None)
    if g is None:
        raise ApiError(404, "not_found", "DINO does not list this class for you any more (it may have been removed, or you no longer teach it).")
    now = set(sc.member_ids(s, c.code))
    want = set(g["pupils"])
    add, remove = sorted(want - now), sorted(now - want)
    out: dict[str, Any] = {"code": c.code, "name": g["name"], "add": add, "remove": remove, "applied": False}
    if apply:
        if add:
            r = sc.add_pupils(s, c.code, add, school=who.school)
            out["conflicts"] = r["conflicts"]
        for pid in remove:
            sc.remove_pupil(s, c.code, pid, school=who.school)
        out["applied"] = True
    return out
