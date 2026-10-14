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


@router.get("/classes")
def list_classes(_: Principal = Depends(require("teacher")), s: Session = Depends(get_session)):
    counts = dict(s.execute(select(Pupil.class_code, func.count()).group_by(Pupil.class_code)).all())
    return [{"code": c.code, "label": c.label, "pupilCount": counts.get(c.code, 0)} for c in s.scalars(select(SchoolClass).order_by(SchoolClass.code))]


@router.post("/classes", status_code=201)
def create_class(body: dict[str, Any] = Body(...), _: Principal = Depends(require("teacher")), s: Session = Depends(get_session)):
    c = sc.create_class(s, str(body.get("code", "")), body.get("label") if isinstance(body.get("label"), str) else None)
    return {"code": c.code, "label": c.label, "pupilCount": 0}


@router.get("/classes/{code}/pupils")
def pupils(code: str, _: Principal = Depends(require("teacher")), s: Session = Depends(get_session)):
    return sc.class_pupils(s, code)


@router.post("/classes/{code}/pupils", status_code=201)
def add_pupils(code: str, body: dict[str, Any] = Body(...), _: Principal = Depends(require("teacher")), s: Session = Depends(get_session)):
    ids = body.get("pupilIds")
    if not isinstance(ids, list) or not ids or len(ids) > 500:
        raise ApiError(422, "invalid", "Send pupilIds: a list of 1 to 500 pupil IDs.")
    return sc.add_pupils(s, code, ids)


@router.delete("/classes/{code}/pupils/{pupil_id}", status_code=204)
def remove_pupil(code: str, pupil_id: str, _: Principal = Depends(require("teacher")), s: Session = Depends(get_session)):
    sc.remove_pupil(s, code, pupil_id)
    return Response(status_code=204)


@router.post("/pupils/{pupil_id}/reset-pin")
def reset_pin(pupil_id: str, _: Principal = Depends(require("teacher")), s: Session = Depends(get_session)):
    return {"pupilId": pupil_id, "pin": sc.reset_pin(s, pupil_id)}
