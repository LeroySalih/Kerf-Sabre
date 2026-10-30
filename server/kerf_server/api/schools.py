"""Schools (platform) and a school's staff (its admins)."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, Request, Response
from sqlalchemy.orm import Session

from .. import services_schools as ss
from ..config import Settings
from ..deps import get_session, get_settings
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
    if admin_id and request.app.state.settings.auth_mode == "planner":
        raise ApiError(422, "invalid", "School admins sign in with DINO, so no admin token is made. Create the school without adminId.")
    school = ss.create_school(s, str(body.get("id", "")), str(body.get("name", "")))
    out: dict[str, Any] = ss.school_doc(school)
    if admin_id:
        s.flush()
        s.commit()  # the token is made through its own session, which must see the school
        out["admin"] = {"id": admin_id, "token": ss.add_staff(request.app.state.db, school.id, "admin", str(admin_id), "first admin")}
    return out


@router.get("/school")
def my_school(who: Principal = Depends(require("admin", "teacher")), s: Session = Depends(get_session), cfg: Settings = Depends(get_settings)):
    school = s.get(School, who.school)
    return ss.school_doc(school, cfg.auto_approve_default)


@router.patch("/school")
def update_school(body: dict[str, Any] = Body(...), who: Principal = Depends(require("admin", "teacher")), s: Session = Depends(get_session), cfg: Settings = Depends(get_settings)):
    """Switch auto-approve on or off for my school. Only files that arrive afterwards are affected."""
    school = s.get(School, who.school)
    if not isinstance(body.get("autoApprove"), bool):
        raise ApiError(422, "invalid", "Send autoApprove: true or false.")
    school.auto_approve = body["autoApprove"]
    return ss.school_doc(school, cfg.auto_approve_default)


@router.get("/staff")
def list_staff(who: Principal = Depends(require("admin")), s: Session = Depends(get_session)):
    return ss.staff(s, who.school)


@router.post("/staff", status_code=201)
def add_staff(request: Request, body: dict[str, Any] = Body(...), who: Principal = Depends(require("admin"))):
    role, sid = body.get("role"), body.get("id")
    if not isinstance(role, str) or not isinstance(sid, str):
        raise ApiError(422, "invalid", "Send role (admin, teacher or station) and id.")
    if request.app.state.settings.auth_mode == "planner" and role != "station":
        raise ApiError(422, "invalid", "People sign in with DINO. Only a station token (for a Cutter) can be made here.")
    token = ss.add_staff(request.app.state.db, who.school, role, sid, body.get("label") if isinstance(body.get("label"), str) else None)
    return {"role": role, "id": sid, "token": token}


@router.delete("/staff/{subject_id}", status_code=204)
def revoke_staff(subject_id: str, who: Principal = Depends(require("admin")), s: Session = Depends(get_session)):
    if subject_id == who.id:
        raise ApiError(409, "conflict", "You cannot remove your own access.")
    ss.revoke_staff(s, who.school, subject_id)
    return Response(status_code=204)
