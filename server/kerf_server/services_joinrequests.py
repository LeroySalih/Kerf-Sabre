"""Pupils ask to join a group; a teacher approves (docs/ACCOUNTS.md: "Signing in without an import: the pupil is asked to join
and waits; a teacher approves them from the group's page"). Pupils never make their own accounts: asking only puts a request
on the group's page, and nothing changes until a teacher who may manage that group approves it.

A pupil finds the group by its **join code**, in their own school only. Approving adds them to the group (`GroupMember`),
making their `Pupil` row if they have none yet (a DINO pupil: an unusable password, they keep signing in with DINO) and bringing
an archived pupil back. IDs only: a display name is shown to staff of the same school when Kerf has one, never logged.
"""
from __future__ import annotations

import logging
import secrets
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from . import services_classes as sc
from . import services_people as people
from .db import iso, utcnow
from .errors import ApiError
from .models import GroupMember, JoinRequest, Pupil, SchoolClass

log = logging.getLogger("kerf.audit")
MAX_PENDING = 10  # requests one pupil may have waiting at once


def _doc(r: JoinRequest, c: SchoolClass | None) -> dict[str, Any]:
    return {"id": r.id, "groupCode": sc.join_code_of(c) if c else r.class_code, "groupLabel": c.label if c else None, "status": r.status,
            "createdAt": iso(r.created_at), "decidedAt": iso(r.decided_at)}


def find_group(s: Session, school: str | None, group_code: str) -> SchoolClass:
    """The pupil's own school's (not archived) group with this join code, else 404 with a plain message."""
    jc = sc.norm_code(str(group_code or ""))
    if not jc or not sc.CODE_RE.match(jc):
        raise ApiError(422, "invalid", "Type the group code your teacher gave you.")
    for c in s.scalars(select(SchoolClass).where(SchoolClass.school_id == school, SchoolClass.archived.is_not(True))):
        if sc.join_code_of(c) == jc:
            return c
    raise ApiError(404, "not_found", f"There is no group with the code {jc} in your school. Check the code with your teacher.")


def ask(s: Session, who, group_code: str) -> tuple[dict[str, Any], bool]:
    """A pupil asks to join a group. Returns (request, made now). An existing waiting request is returned, not made again."""
    if who.role != "pupil":
        raise ApiError(403, "forbidden", "Only pupils ask to join a group. Staff add pupils from the group's page.")
    c = find_group(s, who.school, group_code)
    if sc.in_group(s, c.code, who.id):
        raise ApiError(409, "already_member", f"You are already in {sc.join_code_of(c)}.")
    row = s.scalar(select(JoinRequest).where(JoinRequest.class_code == c.code, JoinRequest.pupil_id == who.id, JoinRequest.status == "pending"))
    if row is not None:
        return _doc(row, c), False
    waiting = s.scalar(select(func.count()).select_from(JoinRequest).where(JoinRequest.pupil_id == who.id, JoinRequest.school_id == who.school, JoinRequest.status == "pending")) or 0
    if waiting >= MAX_PENDING:
        raise ApiError(409, "too_many_requests", "You already have lots of requests waiting. Ask your teacher to look at them first.")
    row = JoinRequest(school_id=who.school, class_code=c.code, pupil_id=who.id, status="pending")
    s.add(row)
    s.flush()
    return _doc(row, c), True


def mine(s: Session, who) -> list[dict[str, Any]]:
    """The caller's own requests in their school, newest first."""
    q = (select(JoinRequest).where(JoinRequest.pupil_id == who.id, JoinRequest.school_id == who.school)
         .order_by(JoinRequest.created_at.desc(), JoinRequest.id.desc()).limit(50))
    return [_doc(r, s.get(SchoolClass, r.class_code)) for r in s.scalars(q)]


def pending_counts(s: Session, school: str | None) -> dict[str, int]:
    """Waiting requests per group of the school (for the `joinRequests` badge on `GET /classes`)."""
    q = (select(JoinRequest.class_code, func.count()).where(JoinRequest.school_id == school, JoinRequest.status == "pending")
         .group_by(JoinRequest.class_code))
    return dict(s.execute(q).all())


def pending_count(s: Session, c: SchoolClass) -> int:
    return s.scalar(select(func.count()).select_from(JoinRequest).where(JoinRequest.class_code == c.code, JoinRequest.school_id == c.school_id, JoinRequest.status == "pending")) or 0


def for_group(s: Session, code: str, teacher_id: str | None, school: str | None) -> list[dict[str, Any]]:
    """A group's waiting requests, for a teacher who may manage it (others: 404), with the pupil's display name if Kerf has one."""
    c = sc.get_class(s, code, teacher_id, school)
    rows = list(s.scalars(select(JoinRequest).where(JoinRequest.class_code == c.code, JoinRequest.school_id == c.school_id, JoinRequest.status == "pending")
                          .order_by(JoinRequest.created_at, JoinRequest.id)))
    named = people.names(s, c.school_id, (r.pupil_id for r in rows))
    return [{"id": r.id, "pupilId": r.pupil_id, "createdAt": iso(r.created_at), "status": r.status,
             "archived": sc.is_archived(s, r.pupil_id), **({"displayName": named[r.pupil_id]} if r.pupil_id in named else {})} for r in rows]


def decide(s: Session, who, code: str, request_id: int, approve: bool, teacher_id: str | None) -> dict[str, Any]:
    """Approve (add the pupil to the group) or decline a waiting request. Only for a teacher who may manage the group."""
    from .services_schools import check_limit

    c = sc.get_class(s, code, teacher_id, who.school)
    r = s.get(JoinRequest, request_id)
    if r is None or r.class_code != c.code or r.school_id != c.school_id:
        raise ApiError(404, "not_found", "There is no such request for this group.")
    if r.status != "pending":
        raise ApiError(409, "already_decided", "Someone has already dealt with this request.")
    if approve and not sc.in_group(s, c.code, r.pupil_id):
        row = s.get(Pupil, r.pupil_id)
        if row is not None and sc.pupil_school(s, row) != c.school_id:
            raise ApiError(409, "conflict", "That pupil ID is used in another school, so they cannot be added here.")
        check_limit(s, c.school_id, "pupilsPerGroup", len(sc.member_ids(s, c.code)))
        if row is None:  # e.g. a DINO pupil Kerf has not met before: nobody knows this password, they keep signing in with DINO
            s.add(Pupil(pupil_id=r.pupil_id, class_code=c.code, pin_hash=sc.hash_pin(secrets.token_urlsafe(32))))
            s.flush()
        elif row.archived_at is not None:  # an archived pupil comes back with their files
            row.archived_at, row.class_code = None, c.code
        s.add(GroupMember(class_code=c.code, pupil_id=r.pupil_id))
    r.status = "approved" if approve else "declined"
    r.decided_by, r.decided_at = who.id, utcnow()
    s.flush()
    log.info("join_request_%s school=%s group=%s pupil=%s by=%s", r.status, c.school_id, c.code, r.pupil_id, who.id)
    return {"id": r.id, "pupilId": r.pupil_id, "status": r.status, "decidedAt": iso(r.decided_at)}
