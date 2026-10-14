"""Activities (teachers set them, pupils work through them) and teacher feedback."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, Response
from sqlalchemy.orm import Session

from .. import services_activities as sa
from .. import services_jobs as sj
from ..deps import get_session
from ..errors import ApiError
from ..security import Principal, require

router = APIRouter(tags=["activities"])
T = Depends(require("teacher"))


# ---- teacher
@router.get("/classes/{code}/activities")
def list_activities(code: str, who: Principal = T, s: Session = Depends(get_session)):
    return sa.list_activities(s, who, code)


@router.post("/classes/{code}/activities", status_code=201)
def create_activity(code: str, body: dict[str, Any] = Body(...), who: Principal = T, s: Session = Depends(get_session)):
    return sa.activity_doc(sa.create_activity(s, who, code, body))


@router.post("/classes/{code}/activities-copy", status_code=201)
def copy_activities(code: str, body: dict[str, Any] = Body(...), who: Principal = T, s: Session = Depends(get_session)):
    return [sa.activity_doc(a) for a in sa.copy_activities(s, who, code, body)]


@router.put("/classes/{code}/activities/{activity_id}")
def update_activity(code: str, activity_id: str, body: dict[str, Any] = Body(...), who: Principal = T, s: Session = Depends(get_session)):
    return sa.activity_doc(sa.update_activity(s, who, code, activity_id, body))


@router.delete("/classes/{code}/activities/{activity_id}", status_code=204)
def archive_activity(code: str, activity_id: str, who: Principal = T, s: Session = Depends(get_session)):
    sa.archive_activity(s, who, code, activity_id)
    return Response(status_code=204)


@router.post("/classes/{code}/activities-order")
def reorder(code: str, body: dict[str, Any] = Body(...), who: Principal = T, s: Session = Depends(get_session)):
    ids = body.get("ids")
    if not isinstance(ids, list):
        raise ApiError(422, "invalid", "Send ids: the activity ids in the order you want.")
    sa.reorder(s, who, code, [str(i) for i in ids])
    s.flush()
    return sa.list_activities(s, who, code)


@router.get("/classes/{code}/progress")
def progress(code: str, who: Principal = T, s: Session = Depends(get_session)):
    return sa.progress(s, who, code)


@router.get("/classes/{code}/activities/{activity_id}/work/{pupil_id}")
def pupil_work(code: str, activity_id: str, pupil_id: str, who: Principal = T, s: Session = Depends(get_session)):
    return sa.pupil_work(s, who, code, activity_id, pupil_id)


@router.post("/classes/{code}/activities/{activity_id}/work/{pupil_id}/feedback", status_code=201)
def give_feedback(code: str, activity_id: str, pupil_id: str, body: dict[str, Any] = Body(...), who: Principal = T, s: Session = Depends(get_session)):
    f = sa.add_feedback(s, who, code, activity_id, pupil_id, body)
    s.flush()
    return sa.feedback_doc(f)


@router.get("/classes/{code}/pupils/{pupil_id}/jobs")
def pupil_files(code: str, pupil_id: str, who: Principal = T, s: Session = Depends(get_session)):
    """A pupil's files, for the teacher who looks after their class."""
    return [sj.to_doc(j) for j in sa.pupil_jobs(s, who, code, pupil_id)]


# ---- pupil
@router.get("/activities")
def my_activities(who: Principal = Depends(require("pupil")), s: Session = Depends(get_session)):
    return sa.my_activities(s, who)


@router.get("/activities/{activity_id}")
def my_activity(activity_id: str, who: Principal = Depends(require("pupil")), s: Session = Depends(get_session)):
    return sa.my_activity(s, who, activity_id)


@router.post("/activities/{activity_id}/submit")
def submit(activity_id: str, body: dict[str, Any] | None = Body(None), who: Principal = Depends(require("pupil")), s: Session = Depends(get_session)):
    job_id = (body or {}).get("jobId")
    return sa.submit(s, who, activity_id, str(job_id) if job_id else None)
