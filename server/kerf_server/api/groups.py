"""The teacher's classes with their pupils, for picking whose files to work with. From DINO when sign-in is DINO, else Kerf's own classes."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from ..deps import get_session
from ..errors import ApiError
from ..models import Pupil
from ..security import SSO_ROLES, Principal, bearer, require
from .classes import list_classes

router = APIRouter(tags=["classes"])


@router.get("/groups")
def groups(request: Request, who: Principal = Depends(require("teacher")), s: Session = Depends(get_session)) -> list[dict[str, Any]]:
    """`[{id, name, subject, yearGroup, pupils: [pupil ID]}]`. IDs only: never a pupil's name. With DINO sign-in these are the teacher's DINO classes
    (asked of DINO with their own token, so a teacher only ever sees their own); otherwise Kerf's classes."""
    sso = getattr(request.app.state, "sso", None)
    if sso is not None and who.role in SSO_ROLES:
        try:
            return sso.groups(bearer(request) or "")
        except Exception as e:  # DINO down, `groups` scope missing (the token pre-dates it: sign in again), bad answer
            raise ApiError(502, "groups_unavailable", "Could not get your classes from DINO. Sign out and in again, then retry.") from e
    from sqlalchemy import select

    out = []
    for c in list_classes(who, s):
        ids = list(s.scalars(select(Pupil.pupil_id).where(Pupil.class_code == c["code"]).order_by(Pupil.pupil_id)))
        out.append({"id": c["code"], "name": c.get("label") or c["code"], "subject": None, "yearGroup": None, "pupils": ids})
    return out
