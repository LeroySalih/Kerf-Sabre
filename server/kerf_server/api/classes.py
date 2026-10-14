"""Teacher-side class management: classes, pupil IDs and PINs."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import services_classes as sc
from ..deps import get_session
from ..errors import ApiError
from ..models import Pupil, SchoolClass
from ..security import Principal, require

router = APIRouter(tags=["classes"])


def who_teacher(who: Principal) -> str | None:
    """The teacher ID that limits which classes are visible. An admin is not limited to their own classes (only to their school)."""
    return None if who.is_admin else who.id


@router.get("/classes")
def list_classes(who: Principal = Depends(require("teacher")), s: Session = Depends(get_session)):
    """A teacher's own classes and any shared (unowned) ones in the school. An admin sees every class in the school."""
    counts = dict(s.execute(select(Pupil.class_code, func.count()).group_by(Pupil.class_code)).all())
    q = select(SchoolClass).where(SchoolClass.school_id == who.school).order_by(SchoolClass.code)
    if not who.is_admin:
        q = q.where((SchoolClass.teacher_id == who.id) | SchoolClass.teacher_id.is_(None))
    return [sc.class_info(s, c, counts.get(c.code, 0)) for c in s.scalars(q)]


@router.post("/classes", status_code=201)
def create_class(body: dict[str, Any] = Body(...), who: Principal = Depends(require("teacher")), s: Session = Depends(get_session)):
    req = body.get("requireApproval", True)
    if not isinstance(req, bool):
        raise ApiError(422, "invalid", "requireApproval is true or false.")
    c = sc.create_class(s, str(body.get("code", "")), body.get("label") if isinstance(body.get("label"), str) else None, who.id, req, school=who.school)
    return sc.class_info(s, c, 0)


@router.put("/classes/{code}")
def update_class(code: str, body: dict[str, Any] = Body(...), who: Principal = Depends(require("teacher")), s: Session = Depends(get_session)):
    """Change a class's label and/or whether its files need a teacher's approval. Files already waiting are not affected."""
    req, label = body.get("requireApproval"), body.get("label")
    if (req is not None and not isinstance(req, bool)) or (label is not None and not isinstance(label, str)):
        raise ApiError(422, "invalid", "Send label (text) and/or requireApproval (true or false).")
    c = sc.update_class(s, code, who_teacher(who), label, req, who.school)
    return sc.class_info(s, c, s.scalar(select(func.count()).select_from(Pupil).where(Pupil.class_code == c.code)) or 0)


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
