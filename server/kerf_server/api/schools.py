"""Schools (platform) and a school's staff (its admins)."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, Request, Response
from sqlalchemy.orm import Session

from .. import services_schools as ss
from ..deps import get_session
from ..errors import ApiError
from ..models import School
from ..security import Principal, require

router = APIRouter(tags=["schools"])


@router.get("/schools")
def list_schools(_: Principal = Depends(require("platform")), s: Session = Depends(get_session)):
    return ss.list_schools(s)


@router.post("/schools", status_code=201)
def create_school(request: Request, body: dict[str, Any] = Body(...), _: Principal = Depends(require("platform")), s: Session = Depends(get_session)):
    """Create a school and its first admin. The admin's token is in the answer once and is never shown again."""
    admin_id = body.get("adminId")
    school = ss.create_school(s, str(body.get("id", "")), str(body.get("name", "")))
    out: dict[str, Any] = ss.school_doc(school)
    if admin_id:
        s.flush()
        s.commit()  # the token is made through its own session, which must see the school
        out["admin"] = {"id": admin_id, "token": ss.add_staff(request.app.state.db, school.id, "admin", str(admin_id), "first admin")}
    return out


@router.get("/school")
def my_school(who: Principal = Depends(require("admin", "teacher")), s: Session = Depends(get_session)):
    school = s.get(School, who.school)
    return ss.school_doc(school)


@router.get("/staff")
def list_staff(who: Principal = Depends(require("admin")), s: Session = Depends(get_session)):
    return ss.staff(s, who.school)


@router.post("/staff", status_code=201)
def add_staff(request: Request, body: dict[str, Any] = Body(...), who: Principal = Depends(require("admin"))):
    role, sid = body.get("role"), body.get("id")
    if not isinstance(role, str) or not isinstance(sid, str):
        raise ApiError(422, "invalid", "Send role (admin, teacher or station) and id.")
    token = ss.add_staff(request.app.state.db, who.school, role, sid, body.get("label") if isinstance(body.get("label"), str) else None)
    return {"role": role, "id": sid, "token": token}


@router.delete("/staff/{subject_id}", status_code=204)
def revoke_staff(subject_id: str, who: Principal = Depends(require("admin")), s: Session = Depends(get_session)):
    if subject_id == who.id:
        raise ApiError(409, "conflict", "You cannot remove your own access.")
    ss.revoke_staff(s, who.school, subject_id)
    return Response(status_code=204)
