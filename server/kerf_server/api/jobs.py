"""Jobs: save/submit/approve/cancel, DXF upload as a job, G-code download."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, File, Form, Query, UploadFile
from fastapi.responses import PlainTextResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import services_jobs as sj
from .. import services_queue as queue
from .. import services_presets as sp
from ..config import Settings
from ..deps import get_session, get_settings
from ..errors import ApiError
from ..models import GcodeRow, Job, JobEvent
from ..schemas import validate
from ..security import Principal, require
from .dxf import check_options, read_upload, run_cleanup

router = APIRouter(tags=["jobs"])


def _receipt(s: Session, j: Job) -> dict[str, Any]:
    """The receipt, with the job's place in the queue while it is waiting there."""
    return sj.receipt(j, queue.position_of(s, j) if j.status == "approved" else None)


@router.get("/jobs")
def list_jobs(
    status: str | None = Query(None),
    station: str | None = Query(None),
    who: Principal = Depends(require("pupil", "station")),
    s: Session = Depends(get_session),
):
    q = select(Job).order_by(Job.created_at.desc())
    if not who.staff():
        q = q.where(Job.pupil_id == who.id)
    if status:
        q = q.where(Job.status.in_([x.strip() for x in status.split(",") if x.strip()]))
    if station:
        q = q.where((Job.station == station) | Job.station.is_(None))
    return [sj.to_doc(j) for j in s.scalars(q)]


@router.post("/jobs", status_code=201)
def create_job(
    doc: dict[str, Any] = Body(...),
    who: Principal = Depends(require("pupil")),
    s: Session = Depends(get_session),
    cfg: Settings = Depends(get_settings),
):
    validate(cfg.shared_dir, "job", doc)
    if doc["status"] not in ("draft", "submitted"):
        raise ApiError(422, "invalid", "A new job can only be saved as 'draft' or 'submitted'.")
    j = sj.create(s, cfg, who, doc, status=doc["status"])
    return _receipt(s, j)


@router.post("/jobs/from-dxf", status_code=201)
async def job_from_dxf(
    file: UploadFile = File(...),
    presetId: str = Form(...),
    pupilId: str | None = Form(None),
    toleranceMm: float = Form(0.01),
    unitsOverride: str | None = Form(None),
    submit: bool = Form(False),
    who: Principal = Depends(require("pupil")),
    s: Session = Depends(get_session),
    cfg: Settings = Depends(get_settings),
):
    check_options(toleranceMm, unitsOverride)
    if pupilId and pupilId != who.id and not who.is_teacher:
        raise ApiError(403, "forbidden", "You can only save files under your own pupil ID.")
    owner = (pupilId or who.id) if who.is_teacher else who.id
    out = await run_cleanup(await read_upload(file, cfg), toleranceMm, unitsOverride)
    doc = {"pupilId": owner, "preset": {"id": presetId}, "origin": {"mode": "current-position", "anchor": "bottom-left"}, "objects": out.objects}
    j = sj.create(s, cfg, who, doc, source="dxf", report=out.report, units=out.units, status="submitted" if submit else "draft")
    return {**_receipt(s, j), "report": out.report, "units": out.units}


@router.get("/jobs/{job_id}")
def get_job(job_id: str, who: Principal = Depends(require("pupil", "station")), s: Session = Depends(get_session)):
    return sj.to_doc(sj.get_visible(s, job_id, who))


@router.get("/jobs/{job_id}/events")
def job_events(job_id: str, who: Principal = Depends(require("pupil", "station")), s: Session = Depends(get_session)):
    sj.get_visible(s, job_id, who)
    rows = s.scalars(select(JobEvent).where(JobEvent.job_id == job_id).order_by(JobEvent.id))
    return [{"ts": e.ts.isoformat(), "actor": e.actor, "kind": e.kind, "detail": e.detail} for e in rows]


@router.put("/jobs/{job_id}")
def replace_job(
    job_id: str,
    doc: dict[str, Any] = Body(...),
    who: Principal = Depends(require("pupil")),
    s: Session = Depends(get_session),
    cfg: Settings = Depends(get_settings),
):
    validate(cfg.shared_dir, "job", doc)
    j = sj.get_owned(s, job_id, who)
    return sj.receipt(sj.replace(s, who, j, doc))


@router.post("/jobs/{job_id}/submit")
def submit_job(job_id: str, who: Principal = Depends(require("pupil")), s: Session = Depends(get_session), cfg: Settings = Depends(get_settings)):
    j = sj.submit(s, cfg, who, sj.get_owned(s, job_id, who))
    s.flush()
    return _receipt(s, j)


@router.post("/jobs/{job_id}/approve")
def approve_job(job_id: str, body: dict[str, Any] | None = Body(None), who: Principal = Depends(require("teacher")), s: Session = Depends(get_session)):
    j = sj.get_visible(s, job_id, who)
    sj.approve(s, who, j, (body or {}).get("station"))
    s.flush()
    return _receipt(s, j)


@router.post("/jobs/{job_id}/reject")
def reject_job(job_id: str, body: dict[str, Any] = Body(...), who: Principal = Depends(require("teacher")), s: Session = Depends(get_session)):
    reason = body.get("reason")
    if not isinstance(reason, str) or not reason.strip():
        raise ApiError(422, "invalid", "Give a reason so the pupil knows what to fix.")
    return sj.receipt(sj.reject(s, who, sj.get_visible(s, job_id, who), reason))


@router.post("/jobs/{job_id}/defer")
def defer_job(job_id: str, who: Principal = Depends(require("pupil", "station")), s: Session = Depends(get_session)):
    j = sj.get_visible(s, job_id, who)  # a pupil can only defer their own
    queue.defer(s, who, j)
    return _receipt(s, j)


@router.get("/queue")
def get_queue(station: str | None = Query(None), who: Principal = Depends(require("pupil", "station")), s: Session = Depends(get_session), cfg: Settings = Depends(get_settings)):
    return queue.entries(s, who, cfg, station)


@router.post("/queue/{job_id}/move")
def move_in_queue(job_id: str, body: dict[str, Any] = Body(...), who: Principal = Depends(require("teacher")), s: Session = Depends(get_session), cfg: Settings = Depends(get_settings)):
    j = sj.get_visible(s, job_id, who)
    pos = body.get("position")
    if pos is not None and (not isinstance(pos, int) or isinstance(pos, bool) or pos < 1):
        raise ApiError(422, "invalid", "'position' must be a whole number from 1.")
    queue.move(s, who, j, body.get("to"), pos)
    s.flush()
    return queue.entries(s, who, cfg)


@router.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: str, who: Principal = Depends(require("pupil")), s: Session = Depends(get_session)):
    return sj.receipt(sj.cancel(s, who, sj.get_owned(s, job_id, who)))


@router.get("/jobs/{job_id}/gcode", response_class=PlainTextResponse)
def job_gcode(job_id: str, station: str | None = Query(None), who: Principal = Depends(require("pupil", "station")), s: Session = Depends(get_session)):
    j = sj.get_visible(s, job_id, who)
    row = s.scalar(select(GcodeRow).where(GcodeRow.job_id == j.id, GcodeRow.station == (station or "")))
    if row is None:
        raise ApiError(404, "not_found", "No G-code has been made for that yet.")
    return PlainTextResponse(row.text, headers={"X-Gcode-Sha256": row.sha256})
