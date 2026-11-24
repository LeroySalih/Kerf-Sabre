"""Teacher-side class management: classes, pupil IDs and PINs."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import services_classes as sc
from ..deps import get_session
from ..errors import ApiError
from ..models import SchoolClass
from ..security import Principal, require

router = APIRouter(tags=["classes"])


def who_teacher(who: Principal) -> str | None:
    """The teacher ID that limits which classes are visible. An admin is not limited to their own classes (only to their school)."""
    return None if who.is_admin else who.id


@router.get("/classes")
def list_classes(who: Principal = Depends(require("teacher")), s: Session = Depends(get_session), archived: bool = False):
    """A teacher's own classes and any shared (unowned) ones in the school. An admin sees every class in the school.
    Archived groups are left out unless `?archived=true` (then only they are listed)."""
    counts = sc.member_counts(s)
    q = select(SchoolClass).where(SchoolClass.school_id == who.school).order_by(SchoolClass.code)
    q = q.where(SchoolClass.archived.is_(True)) if archived is True else q.where(SchoolClass.archived.is_not(True))
    if not who.is_admin:
        q = q.where((SchoolClass.teacher_id == who.id) | SchoolClass.teacher_id.is_(None))
    return [sc.class_info(s, c, counts.get(c.code, 0)) for c in s.scalars(q)]


def _opt_text(body: dict[str, Any], key: str) -> str | None:
    v = body.get(key)
    if v is not None and not isinstance(v, str):
        raise ApiError(422, "invalid", f"{key} is text.")
    return v


@router.post("/classes", status_code=201)
def create_class(body: dict[str, Any] = Body(...), who: Principal = Depends(require("teacher")), s: Session = Depends(get_session)):
    """`{code?, joinCode?, label?, requireApproval?}`. Leave `code` out and Kerf makes one; `joinCode` defaults to the code."""
    req = body.get("requireApproval", True)
    if not isinstance(req, bool):
        raise ApiError(422, "invalid", "requireApproval is true or false.")
    c = sc.create_class(s, _opt_text(body, "code"), _opt_text(body, "label"), who.id, req, school=who.school, join_code=_opt_text(body, "joinCode"))
    return sc.class_info(s, c, 0)


@router.put("/classes/{code}")
def update_class(code: str, body: dict[str, Any] = Body(...), who: Principal = Depends(require("teacher")), s: Session = Depends(get_session)):
    """Change a group's label (e.g. moving up a year), its join code, whether its files need a teacher's approval, or archive it
    (`archived: true`) / bring it back. Files already waiting are not affected."""
    req, archived = body.get("requireApproval"), body.get("archived")
    if (req is not None and not isinstance(req, bool)) or (archived is not None and not isinstance(archived, bool)):
        raise ApiError(422, "invalid", "requireApproval and archived are true or false.")
    laser = body.get("laser")
    if laser is not None and (not isinstance(laser, bool) or not who.is_admin):
        raise ApiError(422 if not isinstance(laser, bool) else 403, "invalid" if not isinstance(laser, bool) else "forbidden",
                       "laser is true or false." if not isinstance(laser, bool) else "Only a school admin picks the laser groups.")
    c = sc.update_class(s, code, who_teacher(who), _opt_text(body, "label"), req, who.school, join_code=_opt_text(body, "joinCode"), archived=archived)
    if laser is not None:
        sc.set_laser(s, c, laser)
    return sc.class_info(s, c, len(sc.member_ids(s, c.code)))


@router.get("/classes/{code}/pupils")
def pupils(code: str, who: Principal = Depends(require("teacher")), s: Session = Depends(get_session)):
    return sc.class_pupils(s, code, who_teacher(who), who.school)


@router.post("/classes/{code}/pupils", status_code=201)
def add_pupils(code: str, body: dict[str, Any] = Body(...), who: Principal = Depends(require("teacher")), s: Session = Depends(get_session)):
    ids = body.get("pupilIds")
    if not isinstance(ids, list) or not ids or len(ids) > 500:
        raise ApiError(422, "invalid", "Send pupilIds: a list of 1 to 500 pupil IDs.")
    return sc.add_pupils(s, code, ids, who_teacher(who), who.school)


@router.delete("/classes/{code}/pupils/{pupil_id}", status_code=204)
def remove_pupil(code: str, pupil_id: str, who: Principal = Depends(require("teacher")), s: Session = Depends(get_session)):
    sc.remove_pupil(s, code, pupil_id, who_teacher(who), who.school)
    return Response(status_code=204)


@router.post("/pupils/{pupil_id}/reset-pin")
def reset_pin(pupil_id: str, who: Principal = Depends(require("teacher")), s: Session = Depends(get_session)):
    return {"pupilId": pupil_id, "pin": sc.reset_pin(s, pupil_id, who_teacher(who), who.school)}
