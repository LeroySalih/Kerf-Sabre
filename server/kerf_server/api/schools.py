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
from ..security import Principal, require, require_site_admin

router = APIRouter(tags=["schools"])


@router.get("/schools")
def list_schools(_: Principal = Depends(require_site_admin), s: Session = Depends(get_session)):
    """The Platform site: every school, its code and plan. Kerf's site admins only."""
    return ss.list_schools(s)


@router.patch("/schools/{school_id}")
def update_school_platform(school_id: str, body: dict[str, Any] = Body(...), _: Principal = Depends(require_site_admin), s: Session = Depends(get_session), cfg: Settings = Depends(get_settings)):
    """The Platform site: set a school's plan (free or paid) or rename it. Kerf's site admins only."""
    row = s.get(School, school_id)
    if row is None:
        raise ApiError(404, "not_found", f"There is no school '{school_id}'.")
    if "plan" in body:
        ss.set_plan(s, school_id, str(body["plan"]))
    if "name" in body:
        row.name = ss.clean_school_name(body["name"])
    return ss.school_doc(row, cfg.auto_approve_default)


@router.get("/platform/terms")
def default_terms(_: Principal = Depends(require_site_admin), s: Session = Depends(get_session)):
    """Kerf's default terms: copied to each new free school when it registers (later changes leave existing schools alone)."""
    from .. import services_terms as terms

    return terms.get_default(s)


@router.put("/platform/terms")
def set_default_terms(body: dict[str, Any] = Body(...), _: Principal = Depends(require_site_admin), s: Session = Depends(get_session)):
    from .. import services_terms as terms

    return terms.set_default(s, body)


@router.get("/schools/{school_id}/terms")
def school_terms(school_id: str, _: Principal = Depends(require_site_admin), s: Session = Depends(get_session)):
    """One school's own terms and what they give it today."""
    from .. import services_terms as terms

    row = s.get(School, school_id)
    if row is None:
        raise ApiError(404, "not_found", f"There is no school '{school_id}'.")
    return terms.terms_doc(row)


@router.put("/schools/{school_id}/terms")
def set_school_terms(school_id: str, body: dict[str, Any] = Body(...), _: Principal = Depends(require_site_admin), s: Session = Depends(get_session)):
    from .. import services_terms as terms

    row = terms.set_school_terms(s, school_id, body)
    s.flush()
    return terms.terms_doc(row)


@router.post("/schools", status_code=201)
def create_school(request: Request, body: dict[str, Any] = Body(...), site_admin: Principal = Depends(require_site_admin), s: Session = Depends(get_session)):
    """Create a school. `adminEmail` (and `adminName`) emails its first admin an invite; `adminId` (development servers only)
    makes an admin token, shown once."""
    admin_id = body.get("adminId")
    if admin_id and request.app.state.settings.auth_mode == "planner":
        raise ApiError(422, "invalid", "School admins sign in with DINO, so no admin token is made. Create the school without adminId.")
    school = ss.create_school(s, str(body.get("id", "")), str(body.get("name", "")), str(body.get("plan") or "free"))
    out: dict[str, Any] = ss.school_doc(school)
    if body.get("adminEmail"):  # the first admin gets an emailed invite (works with DINO-only servers too)
        from .. import services_staffmail as sm

        out["adminInvite"] = sm.invite(s, request.app.state.mailer, request.app.state.settings, str(request.base_url), school.id, site_admin.id,
                                       {"email": body["adminEmail"], "role": "admin", "name": body.get("adminName")})
    if admin_id:
        s.flush()
        s.commit()  # the token is made through its own session, which must see the school
        out["admin"] = {"id": admin_id, "token": ss.add_staff(request.app.state.db, school.id, "admin", str(admin_id), "first admin")}
    return out


@router.get("/staff/people")
def staff_people(who: Principal = Depends(require("admin")), s: Session = Depends(get_session)):
    """School admins: the staff who sign in with an emailed link (invited or active)."""
    from .. import services_staffmail as sm

    return sm.list_accounts(s, who.school)


@router.post("/staff/invite", status_code=201)
def staff_invite(request: Request, body: dict[str, Any] = Body(...), who: Principal = Depends(require("admin")), s: Session = Depends(get_session), cfg: Settings = Depends(get_settings)):
    """School admins: invite a teacher, technician or admin by email (`{email, role, name?}`); sends an invite link (7 days)."""
    from .. import services_staffmail as sm

    return sm.invite(s, request.app.state.mailer, cfg, str(request.base_url), who.school, who.id, body)


@router.delete("/staff/people/{person_id}", status_code=204)
def staff_remove(person_id: str, who: Principal = Depends(require("admin")), s: Session = Depends(get_session)):
    """School admins: remove a member of staff's email account (their sessions end at once)."""
    from .. import services_staffmail as sm

    if person_id == who.id:
        raise ApiError(409, "conflict", "You cannot remove yourself. Ask another admin.")
    sm.remove(s, who.school, person_id)
    return Response(status_code=204)


@router.get("/school/terms")
def my_terms(who: Principal = Depends(require("admin", "teacher")), s: Session = Depends(get_session)):
    """What the school's plan gives it today (and until when), for its own staff."""
    from .. import services_terms as terms

    return terms.effective(s.get(School, who.school))


@router.get("/school")
def my_school(who: Principal = Depends(require("admin", "teacher")), s: Session = Depends(get_session), cfg: Settings = Depends(get_settings)):
    school = s.get(School, who.school)
    return ss.school_doc(school, cfg.auto_approve_default)


@router.patch("/school")
def update_school(body: dict[str, Any] = Body(...), who: Principal = Depends(require("admin", "teacher")), s: Session = Depends(get_session), cfg: Settings = Depends(get_settings)):
    """Change my school: `autoApprove` (teachers and admins; only files that arrive afterwards are affected) and/or `name`
    (school admins only; the display name only, the school ID and code stay). Everything is checked before anything changes."""
    school = s.get(School, who.school)
    if "name" not in body and "autoApprove" not in body:
        raise ApiError(422, "invalid", "Send autoApprove: true or false, or name.")
    name = None
    if "name" in body:
        if who.role != "admin":
            raise ApiError(403, "forbidden", "Only a school admin can rename the school.")
        name = ss.clean_school_name(body["name"])
    if "autoApprove" in body and not isinstance(body["autoApprove"], bool):
        raise ApiError(422, "invalid", "Send autoApprove: true or false.")
    if name is not None:
        school.name = name
    if "autoApprove" in body:
        school.auto_approve = body["autoApprove"]
    return ss.school_doc(school, cfg.auto_approve_default)


@router.get("/school/sign-in")
def sign_in_settings(who: Principal = Depends(require("admin", "teacher")), s: Session = Depends(get_session), cfg: Settings = Depends(get_settings)):
    """How people sign in to my school: which methods are on, and what each needs before it can be turned on."""
    from .. import services_signin as si

    return si.doc(s.get(School, who.school), cfg)


@router.patch("/school/sign-in")
def update_sign_in(body: dict[str, Any] = Body(...), who: Principal = Depends(require("admin")), s: Session = Depends(get_session), cfg: Settings = Depends(get_settings)):
    """School admins switch sign-in methods on or off (Google and Microsoft only once Kerf is registered with them)."""
    from .. import services_signin as si

    return si.doc(si.update(s, cfg, who.school, body), cfg)


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
