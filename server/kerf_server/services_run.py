"""Putting a job on a laser: frame (laser off, to line up the material), assign (start), and what the Cutter reports back."""
from __future__ import annotations

import asyncio
from datetime import timedelta
from typing import Any

from sqlalchemy.orm import Session

from . import services_jobs as sj
from . import services_presets as sp
from . import services_queue as queue
from .config import Settings
from .db import as_utc, utcnow
from .errors import ApiError
from .models import GcodeRow, Job
from .stations import Hub, Live

IDLE_GRACE_S = 15  # a running job may not look idle for longer than this without a result
HEAD_TOLERANCE_MM = 1.0


def bounds_doc(b: tuple[float, float, float, float]) -> dict[str, float]:
    return {"minX": round(b[0], 3), "minY": round(b[1], 3), "maxX": round(b[2], 3), "maxY": round(b[3], 3)}


def _same(a: dict[str, float], b: dict[str, float]) -> bool:
    return all(abs(a[k] - b[k]) <= HEAD_TOLERANCE_MM for k in ("minX", "minY", "maxX", "maxY"))


def prepare(s: Session, hub: Hub, cfg: Settings, j: Job, station_id: str, skip_queue: bool = False) -> tuple[Live, dict[str, Any]]:
    """Checks common to frame and assign. Returns the live station and its machine profile."""
    machine = sp.get_machine(s, j.school_id, station_id)
    if machine is None:
        raise ApiError(404, "not_found", f"There is no laser '{station_id}'.")
    if j.status not in ("approved", "queued"):
        raise ApiError(409, "not_approved", f"This job is {j.status}; only an approved job can be put on a laser.")
    if j.station and j.station != station_id:
        raise ApiError(409, "wrong_station", f"A teacher chose {j.station} for this job.")
    if not skip_queue:
        queue.check_turn(s, cfg, j, station_id)
    live = hub.online(station_id)
    if live.state not in ("Idle", None) or live.current_job:
        raise ApiError(409, "station_busy", f"{station_id} is busy ({live.current_job or live.state}).")
    if live.laser_mode is False:
        raise ApiError(409, "laser_mode_off", f"{station_id} reports GRBL laser mode ($32) is off. A teacher must fix it before cutting.")
    if live.s30 is not None and abs(live.s30 - float(machine["grbl"]["s30Max"])) > 0.5:
        raise ApiError(409, "s30_mismatch", f"{station_id} reports $30={live.s30:g} but its machine profile says {machine['grbl']['s30Max']}. A teacher must correct one of them.")
    return live, machine


def head_of(live: Live):
    return (live.mpos[0], live.mpos[1]) if live.mpos else None


def frame(s: Session, hub: Hub, cfg: Settings, who, j: Job, station_id: str, skip_queue: bool = False) -> dict[str, Any]:
    live, machine = prepare(s, hub, cfg, j, station_id, skip_queue and who.can_override_queue)
    head = head_of(live)
    if j.origin["mode"] == "current-position" and head is None:
        raise ApiError(409, "position_unknown", "The laser has not reported where its head is yet. Wait a moment and try again.")
    r = sj.make_gcode(s, j, machine, head)  # raises 422 if it does not fit this bed
    b = bounds_doc(r.bounds)
    j.framed_station, j.framed_at, j.framed_bounds = station_id, utcnow(), b
    sj.event(s, j.id, who.id, "framed", {"station": station_id, "bounds": b})
    return b


def take_over(s: Session, who, j: Job, station_id: str) -> Job:
    """A technician (or teacher) makes this laser the one that cuts a waiting file that was meant for another laser (or was being set up on one).
    The file keeps its place in the queue; its frame on the other laser is forgotten, so it must be framed here."""
    if sp.get_machine(s, j.school_id, station_id) is None:
        raise ApiError(404, "not_found", f"There is no laser '{station_id}'.")
    if j.status != "approved":
        raise ApiError(409, "not_approved", f"This job is {j.status}; only a waiting file can be taken over.")
    was = j.station
    if j.station != station_id or (j.framed_station and j.framed_station != station_id):
        if j.framed_station != station_id:
            j.framed_station = j.framed_at = j.framed_bounds = None
        j.station = station_id
        sj.event(s, j.id, who.id, "taken_over", {"from": was, "to": station_id})
    return j


def place(s: Session, cfg: Settings, who, j: Job, station_id: str, matrix: Any, skip_queue: bool = False) -> dict[str, Any]:
    """The pupil lined the design up on the camera picture: move it (a rigid transform, no stretching) and fix it to exact bed
    positions. The job becomes absolute and must still fit the bed. Only the job whose turn it is can be placed."""
    machine = sp.get_machine(s, j.school_id, station_id)
    if machine is None:
        raise ApiError(404, "not_found", f"There is no laser '{station_id}'.")
    if j.status != "approved":
        raise ApiError(409, "not_approved", f"This job is {j.status}; only an approved job can be placed on a laser.")
    if j.station and j.station != station_id:
        raise ApiError(409, "wrong_station", f"A teacher chose {j.station} for this job.")
    if not skip_queue:
        queue.check_turn(s, cfg, j, station_id)
    if not (isinstance(matrix, list) and len(matrix) == 6 and all(isinstance(v, (int, float)) and not isinstance(v, bool) and abs(v) < 1e6 for v in matrix)):
        raise ApiError(422, "invalid", "matrix is 6 numbers [a, b, c, d, e, f].")
    a, b, c, d, e, f = (float(v) for v in matrix)
    if abs(a - d) > 1e-4 or abs(b + c) > 1e-4 or abs(a * a + b * b - 1) > 1e-4:
        raise ApiError(422, "invalid", "Placing a design can only move and turn it, not stretch or flip it.")
    objects = []
    for o in j.objects:
        m = [float(v) for v in o["matrix"]]
        objects.append({**o, "matrix": [a * m[0] + c * m[1], b * m[0] + d * m[1], a * m[2] + c * m[3], b * m[2] + d * m[3], a * m[4] + c * m[5] + e, b * m[4] + d * m[5] + f]})
    old = (j.objects, j.origin)
    j.objects, j.origin = objects, {"mode": "absolute"}
    try:
        r = sj.make_gcode(s, j, machine, None)  # raises 422 if it no longer fits the bed
    except ApiError:
        j.objects, j.origin = old
        raise
    j.framed_station = j.framed_at = j.framed_bounds = None  # the old frame no longer matches
    b_ = bounds_doc(r.bounds)
    sj.event(s, j.id, who.id, "placed", {"station": station_id, "matrix": [round(v, 6) for v in (a, b, c, d, e, f)], "bounds": b_})
    return b_


def assign_checks(s: Session, hub: Hub, cfg: Settings, who, j: Job, station_id: str, material_confirmed: bool, allow_untested: bool, skip_queue: bool = False):
    """Everything that must hold before the Cutter is told to cut. Returns (live, machine, result, gcode row)."""
    if not material_confirmed:
        raise ApiError(422, "material_not_confirmed", "Confirm the right material is loaded before cutting.")
    live, machine = prepare(s, hub, cfg, j, station_id, skip_queue and who.can_override_queue)
    head = head_of(live)
    if j.origin["mode"] == "current-position" and head is None:
        raise ApiError(409, "position_unknown", "The laser has not reported where its head is yet.")
    r = sj.make_gcode(s, j, machine, head)
    b = bounds_doc(r.bounds)
    if cfg.require_frame:
        fresh = j.framed_at is not None and utcnow() - as_utc(j.framed_at) <= timedelta(minutes=cfg.frame_valid_minutes)
        if j.framed_station != station_id or not fresh:
            raise ApiError(409, "not_framed", "Check the position first: run Frame so the laser traces the outline with the laser off.")
        if not j.framed_bounds or not _same(j.framed_bounds, b):
            raise ApiError(409, "moved_since_frame", "The laser head has moved since you checked the position. Frame again.")
    if r.untested and not sj.is_material_test(j):
        if not (allow_untested and who.is_teacher):
            raise ApiError(422, "untested_material", "This material has not been test-gridded on this laser. Run a material test first (a teacher can override).")
    return live, machine, r, b


async def start(db, hub: Hub, cfg: Settings, who, job_id: str, station_id: str, material_confirmed: bool, allow_untested: bool, skip_queue: bool = False) -> dict[str, Any]:
    """Assign + run_job. The database is released while we wait for the Cutter's answer."""
    with db.session() as s:
        j = sj.get_visible(s, job_id, who)
        live, machine, r, b = assign_checks(s, hub, cfg, who, j, station_id, material_confirmed, allow_untested, skip_queue)
        row: GcodeRow = sj.store_gcode(s, j, station_id, r)
        preset = sp.preset_version(s, j.school_id, j.preset_id, j.preset_version) or {}
        j.status, j.station = "assigned", station_id
        sj.event(s, j.id, who.id, "assigned", {"station": station_id})
        s.flush()
        msg = {
            "type": "run_job", "jobId": j.id, "gcodeUrl": f"/api/v1/jobs/{j.id}/gcode?station={station_id}", "gcodeSha256": row.sha256,
            "totalLines": row.total_lines, "estimatedS": row.estimated_s, "bounds": b, "presetVersion": j.preset_version, "material": preset.get("material", ""),
        }
    live.current_job, live.progress = job_id, None
    fut = hub.expect_ack(station_id, job_id)
    try:
        await hub.send(station_id, msg)
        ack = await asyncio.wait_for(fut, cfg.ack_timeout_s)
    except (ApiError, asyncio.TimeoutError) as exc:
        reason = exc.message if isinstance(exc, ApiError) else f"{station_id} did not answer in {cfg.ack_timeout_s:g} s."
        _revert(db, hub, live, job_id, who.id, reason)
        raise ApiError(409, "not_started", reason) from exc
    finally:
        live.acks.pop(job_id, None)
    if not ack.get("accepted", False):
        reason = f"{station_id} refused the job: {ack.get('reason') or 'no reason given'}"
        _revert(db, hub, live, job_id, who.id, reason)
        raise ApiError(409, "refused", reason)
    with db.session() as s:
        j = s.get(Job, job_id)
        j.status, j.running_since = "running", utcnow()
        sj.event(s, job_id, station_id, "started")
        out = sj.receipt(j)
    hub.server_log(station_id, "INFO", "job started", job_id)
    return out


def _revert(db, hub: Hub, live: Live, job_id: str, actor: str, reason: str) -> None:
    live.current_job = None
    with db.session() as s:
        j = s.get(Job, job_id)
        if j and j.status == "assigned":
            j.status = "approved"
            sj.event(s, job_id, actor, "start_failed", {"reason": reason})
    hub.server_log(live.id, "WARNING", f"job not started: {reason}", job_id)


def finish(db, hub: Hub, station_id: str, job_id: str, outcome: str, message: str | None, actual_s: float | None) -> None:
    live = hub.get(station_id)
    with db.session() as s:
        j = s.get(Job, job_id)
        if j is None or j.station != station_id or j.status not in ("assigned", "running"):
            hub.server_log(station_id, "WARNING", f"ignored result for {job_id}", job_id)
        else:
            j.status = outcome
            j.status_reason = (message or "")[:500] or None
            sj.event(s, job_id, station_id, outcome, {"actualS": actual_s, "message": message})
    if live.current_job == job_id:
        live.current_job, live.progress = None, None
    hub.server_log(station_id, "INFO" if outcome == "done" else "WARNING", f"job {outcome}", job_id)


def watchdog(db, hub: Hub, station_id: str) -> None:
    """A Cutter that says Idle for a while with no result for its job has lost it (restart, crash): fail the job so the pupil is not left waiting."""
    live = hub.get(station_id)
    if live.state != "Idle" or not live.current_job:
        return
    with db.session() as s:
        j = s.get(Job, live.current_job)
        if j is None or j.status != "running" or j.running_since is None:
            return
        if (utcnow() - as_utc(j.running_since)).total_seconds() < IDLE_GRACE_S:
            return
        job_id = j.id
    finish(db, hub, station_id, job_id, "failed", "The laser stopped without reporting a result. Check the material before trying again.", None)
