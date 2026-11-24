"""Teacher-side class management: classes, pupil IDs and PINs."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, Request, Response
from fastapi.responses import JSONResponse
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
    from .. import services_joinrequests as jr

    counts, waiting = sc.member_counts(s), jr.pending_counts(s, who.school)
    q = select(SchoolClass).where(SchoolClass.school_id == who.school).order_by(SchoolClass.code)
    q = q.where(SchoolClass.archived.is_(True)) if archived is True else q.where(SchoolClass.archived.is_not(True))
    if not who.is_admin:
        q = q.where((SchoolClass.teacher_id == who.id) | SchoolClass.teacher_id.is_(None))
    return [sc.class_info(s, c, counts.get(c.code, 0), waiting.get(c.code, 0)) for c in s.scalars(q)]


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
    """`{pupilIds: [ID]}` and/or `{pupils: [{id?, name?}]}` and/or `{generate: N}` (Kerf makes the IDs). New pupils' two-word
    passwords are in the answer, once."""
    ids, entries, generate = body.get("pupilIds"), body.get("pupils"), body.get("generate", 0)
    if ids is not None and (not isinstance(ids, list) or len(ids) > 500):
        raise ApiError(422, "invalid", "pupilIds is a list of up to 500 pupil IDs.")
    if entries is not None and (not isinstance(entries, list) or len(entries) > 500):
        raise ApiError(422, "invalid", "pupils is a list of up to 500 {id?, name?}.")
    if not isinstance(generate, int) or isinstance(generate, bool):
        raise ApiError(422, "invalid", "generate is a whole number.")
    if not ids and not entries and not generate:
        raise ApiError(422, "invalid", "Send pupilIds, pupils or generate.")
    return sc.add_pupils(s, code, ids or [], who_teacher(who), who.school, entries=entries or [], generate=generate)


@router.post("/classes/{code}/passwords")
def new_passwords(code: str, body: dict[str, Any] = Body(default={}), who: Principal = Depends(require("teacher")), s: Session = Depends(get_session)):
    """New two-word passwords for the group's pupils (all, or `{pupilIds}`), for printing Pupil Cards. Old passwords stop working."""
    ids = body.get("pupilIds") if isinstance(body, dict) else None
    if ids is not None and not isinstance(ids, list):
        raise ApiError(422, "invalid", "pupilIds is a list.")
    return sc.new_group_passwords(s, code, who_teacher(who), who.school, ids)


@router.put("/classes/{code}/pupils/{pupil_id}")
def set_pupil_name(code: str, pupil_id: str, body: dict[str, Any] = Body(...), who: Principal = Depends(require("teacher")), s: Session = Depends(get_session)):
    """A pupil's display name (`{displayName}`; empty clears it): staff and the pupil's own card only, never logged."""
    return {"pupilId": pupil_id, "displayName": sc.set_display_name(s, code, pupil_id, body.get("displayName"), who_teacher(who), who.school)}


@router.delete("/classes/{code}/pupils/{pupil_id}", status_code=204)
def remove_pupil(code: str, pupil_id: str, who: Principal = Depends(require("teacher")), s: Session = Depends(get_session)):
    sc.remove_pupil(s, code, pupil_id, who_teacher(who), who.school)
    return Response(status_code=204)


@router.get("/pupils/archived")
def archived(who: Principal = Depends(require("teacher")), s: Session = Depends(get_session)):
    """The school's archived pupils (out of every group). Add one to a group to bring them back."""
    return sc.archived_pupils(s, who.school)


@router.delete("/pupils/{pupil_id}")
def delete_forever(pupil_id: str, who: Principal = Depends(require("admin")), s: Session = Depends(get_session)):
    """School admins: delete an archived pupil and everything of theirs for good. Logged."""
    return sc.delete_pupil_forever(s, who, pupil_id)


@router.get("/dino/classes")
def dino_classes(request: Request, who: Principal = Depends(require("teacher")), s: Session = Depends(get_session)):
    """The teacher's own DINO classes and the Kerf group each is already imported as. Needs a DINO sign-in (409 dino_needed)."""
    from .. import services_dinoimport as di

    return di.listing(s, who, di.dino_classes(request, who))


@router.post("/dino/classes/import", status_code=201)
def import_dino(request: Request, body: dict[str, Any] = Body(...), who: Principal = Depends(require("teacher")), s: Session = Depends(get_session)):
    """`{ids: [DINO class id]}`: a Kerf group for each (named after it, with its pupils' DINO IDs), linked so it can be re-synced."""
    from .. import services_dinoimport as di

    ids = body.get("ids")
    if not isinstance(ids, list) or not ids or len(ids) > 50 or not all(isinstance(i, str) for i in ids):
        raise ApiError(422, "invalid", "Send ids: a list of 1 to 50 DINO class ids.")
    return di.import_classes(s, who, di.dino_classes(request, who), ids)


@router.post("/classes/{code}/dino-sync")
def dino_sync(code: str, request: Request, body: dict[str, Any] = Body(default={}), who: Principal = Depends(require("teacher")), s: Session = Depends(get_session)):
    """Compare a DINO-imported group with its DINO class (`{apply: false}`: just the changes) or make the changes (`{apply: true}`)."""
    from .. import services_dinoimport as di

    return di.sync(s, who, di.dino_classes(request, who), code, bool(isinstance(body, dict) and body.get("apply") is True))


@router.post("/pupils/{pupil_id}/reset-pin")
def reset_pin(pupil_id: str, who: Principal = Depends(require("teacher")), s: Session = Depends(get_session)):
    password = sc.reset_pin(s, pupil_id, who_teacher(who), who.school)
    return {"pupilId": pupil_id, "password": password, "pin": password}


# ---------------------------------------------------------------- pupils ask to join a group (shared 0.2.42)

@router.post("/groups/join")
def ask_to_join(body: dict[str, Any] = Body(...), who: Principal = Depends(require("pupil")), s: Session = Depends(get_session)):
    """Pupils: ask to join a group of my school by its join code (`{groupCode}`). 201 a new request, 200 the one already waiting;
    404 no such group in my school; 409 `already_member`. A teacher who manages the group approves or declines it."""
    from .. import services_joinrequests as jr

    doc, made = jr.ask(s, who, str(body.get("groupCode") or ""))
    return JSONResponse(doc, status_code=201 if made else 200)


@router.get("/me/join-requests")
def my_join_requests(who: Principal = Depends(require("pupil")), s: Session = Depends(get_session)):
    """Pupils: my requests to join groups (newest first), with the group's code and label and whether I am waiting, in or declined."""
    from .. import services_joinrequests as jr

    return jr.mine(s, who)


@router.get("/classes/{code}/join-requests")
def join_requests(code: str, who: Principal = Depends(require("teacher")), s: Session = Depends(get_session)):
    """Teachers who manage the group (admins: every group of the school): pupils waiting to join it."""
    from .. import services_joinrequests as jr

    return jr.for_group(s, code, who_teacher(who), who.school)


@router.post("/classes/{code}/join-requests/{request_id}/approve")
def approve_join(code: str, request_id: int, who: Principal = Depends(require("teacher")), s: Session = Depends(get_session)):
    """Add the pupil to the group (their account is made if Kerf has none; an archived pupil comes back). 409 `limit_reached` when full."""
    from .. import services_joinrequests as jr

    return jr.decide(s, who, code, request_id, True, who_teacher(who))


@router.post("/classes/{code}/join-requests/{request_id}/decline")
def decline_join(code: str, request_id: int, who: Principal = Depends(require("teacher")), s: Session = Depends(get_session)):
    from .. import services_joinrequests as jr

    return jr.decide(s, who, code, request_id, False, who_teacher(who))
