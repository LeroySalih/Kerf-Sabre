"""Class activities: what teachers set, how pupils work through them, and teacher feedback."""
from __future__ import annotations

import secrets
from datetime import datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from . import services_presets as sp
from .db import as_utc, iso, utcnow
from .errors import ApiError
from .models import Activity, ActivityWork, Feedback, Job, Pupil, SchoolClass

STATUSES = ("todo", "working", "submitted", "revise", "complete")
OUTCOMES = ("comment", "revise", "complete")


# ---------------------------------------------------------------- access

def owned_class(s: Session, who, code: str) -> SchoolClass:
    """The class, if this teacher looks after it (or it is a shared class). 404 otherwise, so other classes stay invisible."""
    c = s.get(SchoolClass, code.strip().upper())
    if c is None or c.school_id != who.school or (c.teacher_id is not None and c.teacher_id != who.id and not who.is_admin):
        raise ApiError(404, "not_found", "There is no such class.")
    return c


def class_activity(s: Session, code: str, activity_id: str) -> Activity:
    a = s.get(Activity, activity_id)
    if a is None or a.class_code != code.strip().upper() or a.archived:
        raise ApiError(404, "not_found", "There is no such activity in this class.")
    return a


def pupil_class(s: Session, pupil_id: str) -> str | None:
    p = s.get(Pupil, pupil_id)
    return p.class_code if p else None


def pupil_activity(s: Session, who, activity_id: str) -> Activity:
    """An activity this pupil may see: published, not archived, in their class."""
    a = s.get(Activity, activity_id)
    if a is None or a.archived or not a.published or a.class_code != pupil_class(s, who.id):
        raise ApiError(404, "not_found", "There is no such activity.")
    return a


# ---------------------------------------------------------------- documents

def activity_doc(a: Activity) -> dict[str, Any]:
    return {"id": a.id, "classCode": a.class_code, "title": a.title, "instructions": a.instructions, "position": a.position,
            "presetId": a.preset_id, "dueAt": iso(a.due_at), "published": a.published}


def feedback_doc(f: Feedback) -> dict[str, Any]:
    return {"id": f.id, "teacherId": f.teacher_id, "text": f.text, "outcome": f.outcome, "jobId": f.job_id, "createdAt": iso(f.created_at)}


def _feedback(s: Session, pupil_id: str, activity_id: str) -> list[Feedback]:
    return list(s.scalars(select(Feedback).where(Feedback.pupil_id == pupil_id, Feedback.activity_id == activity_id).order_by(Feedback.id)))


def work_doc(s: Session, pupil_id: str, a: Activity) -> dict[str, Any]:
    w = s.get(ActivityWork, (pupil_id, a.id))
    fb = _feedback(s, pupil_id, a.id)
    return {"activityId": a.id, "pupilId": pupil_id, "status": w.status if w else "todo", "jobId": w.job_id if w else None,
            "submittedAt": iso(w.submitted_at) if w else None, "feedback": [feedback_doc(f) for f in fb]}


# ---------------------------------------------------------------- teacher side

def _clean_title(title: Any) -> str:
    if not isinstance(title, str) or not title.strip():
        raise ApiError(422, "invalid", "An activity needs a title.")
    return title.strip()[:200]


def _parse_due(v: Any) -> datetime | None:
    if v in (None, ""):
        return None
    try:
        return as_utc(datetime.fromisoformat(str(v).replace("Z", "+00:00")))
    except ValueError as exc:
        raise ApiError(422, "invalid", "dueAt must be a date and time like 2026-11-05T15:00:00Z.") from exc


def _check_preset(s: Session, school: str | None, preset_id: Any) -> str | None:
    if preset_id in (None, ""):
        return None
    if sp.latest_preset(s, school, str(preset_id)) is None:
        raise ApiError(422, "unknown_preset", f"There is no material '{preset_id}'.")
    return str(preset_id)


def create_activity(s: Session, who, code: str, body: dict[str, Any]) -> Activity:
    cls = owned_class(s, who, code)
    nxt = (s.scalar(select(func.max(Activity.position)).where(Activity.class_code == cls.code)) or 0) + 1
    a = Activity(id="act-" + secrets.token_hex(4), class_code=cls.code, title=_clean_title(body.get("title")), instructions=str(body.get("instructions") or "")[:20000],
                 position=nxt, preset_id=_check_preset(s, cls.school_id, body.get("presetId")), due_at=_parse_due(body.get("dueAt")),
                 published=bool(body.get("published", False)), created_by=who.id)
    s.add(a)
    return a


def update_activity(s: Session, who, code: str, activity_id: str, body: dict[str, Any]) -> Activity:
    cls = owned_class(s, who, code)
    a = class_activity(s, code, activity_id)
    if "title" in body:
        a.title = _clean_title(body["title"])
    if "instructions" in body:
        a.instructions = str(body["instructions"] or "")[:20000]
    if "presetId" in body:
        a.preset_id = _check_preset(s, cls.school_id, body["presetId"])
    if "dueAt" in body:
        a.due_at = _parse_due(body["dueAt"])
    if "published" in body:
        a.published = bool(body["published"])
    return a


def copy_activities(s: Session, who, code: str, body: dict[str, Any]) -> list[Activity]:
    """Copy activities into `code` from another class this teacher looks after. Work and feedback stay behind."""
    target = owned_class(s, who, code)
    source = owned_class(s, who, str(body.get("fromClass") or ""))
    q = select(Activity).where(Activity.class_code == source.code, Activity.archived.is_(False)).order_by(Activity.position, Activity.created_at)
    pool = list(s.scalars(q))
    ids = body.get("activityIds")
    if ids is None:
        chosen = pool
    else:
        if not isinstance(ids, list):
            raise ApiError(422, "invalid", "activityIds must be a list.")
        by_id = {a.id: a for a in pool}
        missing = [i for i in ids if i not in by_id]
        if missing:
            raise ApiError(404, "not_found", f"Not an activity in {source.code}: {missing[0]}")
        chosen = [by_id[i] for i in dict.fromkeys(ids)]  # in the order asked for, once each
    if not chosen:
        raise ApiError(422, "invalid", f"There are no activities in {source.code} to copy.")
    pos = s.scalar(select(func.max(Activity.position)).where(Activity.class_code == target.code)) or 0
    keep, publish = bool(body.get("keepDueDates", False)), bool(body.get("published", False))
    out: list[Activity] = []
    for a in chosen:
        pos += 1
        title = f"{a.title} (copy)" if source.code == target.code else a.title
        copy = Activity(id="act-" + secrets.token_hex(4), class_code=target.code, title=title[:200], instructions=a.instructions, position=pos,
                        preset_id=a.preset_id, due_at=a.due_at if keep else None, published=publish, created_by=who.id)
        s.add(copy)
        out.append(copy)
    return out


def archive_activity(s: Session, who, code: str, activity_id: str) -> None:
    owned_class(s, who, code)
    class_activity(s, code, activity_id).archived = True


def reorder(s: Session, who, code: str, ids: list[str]) -> None:
    cls = owned_class(s, who, code)
    rows = {a.id: a for a in s.scalars(select(Activity).where(Activity.class_code == cls.code, Activity.archived.is_(False)))}
    if set(ids) != set(rows) or len(ids) != len(rows):
        raise ApiError(422, "invalid", "List every activity in the class exactly once.")
    for i, aid in enumerate(ids, 1):
        rows[aid].position = i


def list_activities(s: Session, who, code: str) -> list[dict[str, Any]]:
    cls = owned_class(s, who, code)
    acts = list(s.scalars(select(Activity).where(Activity.class_code == cls.code, Activity.archived.is_(False)).order_by(Activity.position, Activity.created_at)))
    counts: dict[tuple[str, str], int] = {}
    for aid, st, n in s.execute(select(ActivityWork.activity_id, ActivityWork.status, func.count()).group_by(ActivityWork.activity_id, ActivityWork.status)):
        counts[(aid, st)] = n
    return [{**activity_doc(a), "counts": {st: counts.get((a.id, st), 0) for st in STATUSES if st != "todo"}} for a in acts]


def progress(s: Session, who, code: str) -> dict[str, Any]:
    """Every pupil against every activity, for the teacher's overview."""
    cls = owned_class(s, who, code)
    acts = list(s.scalars(select(Activity).where(Activity.class_code == cls.code, Activity.archived.is_(False)).order_by(Activity.position, Activity.created_at)))
    pupils = list(s.scalars(select(Pupil.pupil_id).where(Pupil.class_code == cls.code).order_by(Pupil.pupil_id)))
    work = {(w.pupil_id, w.activity_id): w for w in s.scalars(select(ActivityWork).where(ActivityWork.activity_id.in_([a.id for a in acts]))) } if acts else {}
    fb: dict[tuple[str, str], int] = {}
    if acts:
        for pid, aid, n in s.execute(select(Feedback.pupil_id, Feedback.activity_id, func.count()).where(Feedback.activity_id.in_([a.id for a in acts])).group_by(Feedback.pupil_id, Feedback.activity_id)):
            fb[(pid, aid)] = n
    return {
        "activities": [{"id": a.id, "title": a.title, "published": a.published, "dueAt": iso(a.due_at)} for a in acts],
        "pupils": [{"pupilId": p, "work": {a.id: {"status": (work[(p, a.id)].status if (p, a.id) in work else "todo"), "jobId": work[(p, a.id)].job_id if (p, a.id) in work else None,
                                                  "submittedAt": iso(work[(p, a.id)].submitted_at) if (p, a.id) in work else None, "feedbackCount": fb.get((p, a.id), 0)} for a in acts}} for p in pupils],
    }


def pupil_work(s: Session, who, code: str, activity_id: str, pupil_id: str) -> dict[str, Any]:
    cls = owned_class(s, who, code)
    a = class_activity(s, cls.code, activity_id)
    if s.get(Pupil, pupil_id) is None or s.get(Pupil, pupil_id).class_code != cls.code:  # type: ignore[union-attr]
        raise ApiError(404, "not_found", "That pupil is not in this class.")
    jobs = list(s.scalars(select(Job).where(Job.pupil_id == pupil_id, Job.activity_id == a.id).order_by(Job.created_at.desc())))
    return {**work_doc(s, pupil_id, a), "files": [{"id": j.id, "status": j.status, "createdAt": iso(j.created_at), "presetId": j.preset_id} for j in jobs]}


def add_feedback(s: Session, who, code: str, activity_id: str, pupil_id: str, body: dict[str, Any]) -> Feedback:
    cls = owned_class(s, who, code)
    a = class_activity(s, cls.code, activity_id)
    p = s.get(Pupil, pupil_id)
    if p is None or p.class_code != cls.code:
        raise ApiError(404, "not_found", "That pupil is not in this class.")
    text = str(body.get("text") or "").strip()
    outcome = body.get("outcome", "comment")
    if outcome not in OUTCOMES:
        raise ApiError(422, "invalid", f"outcome must be one of {', '.join(OUTCOMES)}.")
    if not text and outcome == "comment":
        raise ApiError(422, "invalid", "Write some feedback.")
    w = s.get(ActivityWork, (pupil_id, a.id))
    f = Feedback(pupil_id=pupil_id, activity_id=a.id, teacher_id=who.id, text=text[:5000], outcome=outcome, job_id=w.job_id if w else None)
    s.add(f)
    if outcome in ("revise", "complete"):
        if w is None:
            w = ActivityWork(pupil_id=pupil_id, activity_id=a.id, status=outcome)
            s.add(w)
        else:
            w.status = outcome
        w.updated_at = utcnow()
    return f


def pupil_jobs(s: Session, who, code: str, pupil_id: str) -> list[Job]:
    cls = owned_class(s, who, code)
    p = s.get(Pupil, pupil_id)
    if p is None or p.class_code != cls.code:
        raise ApiError(404, "not_found", "That pupil is not in this class.")
    return list(s.scalars(select(Job).where(Job.pupil_id == pupil_id).order_by(Job.created_at.desc())))


# ---------------------------------------------------------------- pupil side

def my_activities(s: Session, who) -> list[dict[str, Any]]:
    code = pupil_class(s, who.id)
    if code is None:
        return []
    acts = list(s.scalars(select(Activity).where(Activity.class_code == code, Activity.published.is_(True), Activity.archived.is_(False)).order_by(Activity.position, Activity.created_at)))
    out = []
    for a in acts:
        w = work_doc(s, who.id, a)
        out.append({**activity_doc(a), "status": w["status"], "jobId": w["jobId"], "feedbackCount": len(w["feedback"])})
    return out


def my_activity(s: Session, who, activity_id: str) -> dict[str, Any]:
    a = pupil_activity(s, who, activity_id)
    return {**activity_doc(a), **{k: v for k, v in work_doc(s, who.id, a).items() if k in ("status", "jobId", "submittedAt", "feedback")}}


def link_job(s: Session, who, job: Job, activity_id: str | None) -> None:
    """A file made for an activity: the activity must be one this pupil can see. Starts their work on it."""
    if not activity_id:
        job.activity_id = None
        return
    a = pupil_activity(s, who, activity_id) if who.role == "pupil" else s.get(Activity, activity_id)
    if a is None:
        raise ApiError(422, "unknown_activity", "That activity doesn't exist, or isn't set for your class.")
    job.activity_id = a.id
    w = s.get(ActivityWork, (job.pupil_id, a.id))
    if w is None:
        s.add(ActivityWork(pupil_id=job.pupil_id, activity_id=a.id, status="working"))


def submit(s: Session, who, activity_id: str, job_id: str | None) -> dict[str, Any]:
    a = pupil_activity(s, who, activity_id)
    w = s.get(ActivityWork, (who.id, a.id))
    if w is not None and w.status == "complete":
        raise ApiError(409, "conflict", "This activity is already marked complete.")
    if job_id is None:  # the latest file made for this activity
        j = s.scalar(select(Job).where(Job.pupil_id == who.id, Job.activity_id == a.id, Job.status != "cancelled").order_by(Job.created_at.desc()))
    else:
        j = s.get(Job, job_id)
        if j is None or j.pupil_id != who.id or j.activity_id != a.id:
            raise ApiError(404, "not_found", "That file isn't one of yours for this activity.")
    if j is None:
        raise ApiError(409, "no_file", "Save a file for this activity first, then hand it in.")
    if w is None:
        w = ActivityWork(pupil_id=who.id, activity_id=a.id)
        s.add(w)
    w.status, w.job_id, w.submitted_at, w.updated_at = "submitted", j.id, utcnow(), utcnow()
    return work_doc(s, who.id, a)
