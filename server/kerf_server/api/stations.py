"""Stations: live state, frame/assign (start a cut), stop/pause/resume, camera, logs, diagnostics."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, File, Request, Response, UploadFile
from sqlalchemy.orm import Session

from .. import services_jobs as sj
from .. import services_presets as sp
from .. import services_run as run
from ..config import Settings
from ..db import utcnow
from ..deps import get_session, get_settings
from ..errors import ApiError
from ..security import Principal, require
from .dxf import read_upload

router = APIRouter(tags=["stations"])
LEVELS = ("DEBUG", "INFO", "WARNING", "ERROR")


def station_ids(s: Session, school: str) -> list[str]:
    return [m["id"] for m in sp.list_machines(s, school)]


def known(s: Session, who: Principal, station_id: str) -> None:
    """The laser must belong to the caller's school; another school's laser looks like it does not exist."""
    if sp.get_machine(s, who.school, station_id) is None:
        raise ApiError(404, "not_found", f"There is no laser '{station_id}'.")


def own_station(request: Request, who: Principal, station_id: str) -> None:
    with request.app.state.db.session() as s:
        known(s, who, station_id)


@router.get("/stations")
def list_stations(request: Request, who: Principal = Depends(require("pupil", "station")), s: Session = Depends(get_session)):
    hub = request.app.state.hub
    done = sp.calibrated_ids(s, who.school)
    return [{**hub.get(i).doc(), "calibrated": i in done} for i in station_ids(s, who.school)]


@router.get("/stations/{station_id}")
def get_station(station_id: str, request: Request, who: Principal = Depends(require("pupil", "station")), s: Session = Depends(get_session)):
    known(s, who, station_id)
    return {**request.app.state.hub.get(station_id).doc(), "calibrated": station_id in sp.calibrated_ids(s, who.school)}


@router.get("/stations/{station_id}/camera-calibration")
def get_camera_calibration(station_id: str, who: Principal = Depends(require("station", "teacher")), s: Session = Depends(get_session)):
    """Where the camera picture sits on the bed, or 404 not_calibrated. Any laser PC or teacher of the school may read it."""
    cal = sp.get_calibration(s, who.school, station_id)
    if cal is None:
        raise ApiError(404, "not_calibrated", f"The camera on {station_id} has not been calibrated yet. A teacher can do this on the Admin site's Lasers page.")
    return cal


@router.put("/stations/{station_id}/camera-calibration")
def put_camera_calibration(station_id: str, body: dict[str, Any] = Body(...), who: Principal = Depends(require("teacher")), s: Session = Depends(get_session)):
    return sp.put_calibration(s, who.school, station_id, body, who.id)


@router.delete("/stations/{station_id}/camera-calibration", status_code=204)
def delete_camera_calibration(station_id: str, who: Principal = Depends(require("teacher")), s: Session = Depends(get_session)):
    sp.clear_calibration(s, who.school, station_id)
    return Response(status_code=204)


@router.post("/jobs/{job_id}/frame", status_code=202)
async def frame_job(job_id: str, request: Request, body: dict[str, Any] = Body(...), who: Principal = Depends(require("station", "teacher")), cfg: Settings = Depends(get_settings)):
    station = body.get("station")
    if not isinstance(station, str):
        raise ApiError(422, "invalid", "Say which station to frame on.")
    own_station(request, who, station)
    app = request.app
    hub = app.state.hub
    with app.state.db.session() as s:
        b = run.frame(s, hub, cfg, who, sj.get_visible(s, job_id, who), station, body.get("skipQueue") is True)
    await hub.send(station, {"type": "control", "command": "frame", "jobId": job_id, "bounds": b})
    hub.server_log(station, "INFO", "frame sent", job_id)
    return {"bounds": b}


@router.post("/jobs/{job_id}/placement")
def place_job(job_id: str, body: dict[str, Any] = Body(...), who: Principal = Depends(require("station", "teacher")), s: Session = Depends(get_session), cfg: Settings = Depends(get_settings)):
    """Fix the design's position on the bed after the pupil lined it up on the camera picture (`matrix`: move and turn only)."""
    station = body.get("station")
    if not isinstance(station, str):
        raise ApiError(422, "invalid", "Say which station the design is placed on.")
    known(s, who, station)
    return {"bounds": run.place(s, cfg, who, sj.get_visible(s, job_id, who), station, body.get("matrix"), body.get("skipQueue") is True)}


@router.post("/jobs/{job_id}/assign")
async def assign_job(job_id: str, request: Request, body: dict[str, Any] = Body(...), who: Principal = Depends(require("station", "teacher")), cfg: Settings = Depends(get_settings)):
    station = body.get("station")
    if not isinstance(station, str):
        raise ApiError(422, "invalid", "Say which station to cut on.")
    own_station(request, who, station)
    app = request.app
    return await run.start(app.state.db, app.state.hub, cfg, who, job_id, station, body.get("materialConfirmed") is True, body.get("allowUntested") is True, body.get("skipQueue") is True)


@router.post("/stations/{station_id}/control", status_code=202)
async def control(station_id: str, request: Request, body: dict[str, Any] = Body(...), who: Principal = Depends(require("station", "teacher"))):
    own_station(request, who, station_id)
    cmd = body.get("command")
    if cmd not in ("stop", "pause", "resume"):
        raise ApiError(422, "invalid", "command must be stop, pause or resume.")
    hub = request.app.state.hub
    await hub.send(station_id, {"type": "control", "command": cmd})
    hub.server_log(station_id, "WARNING" if cmd == "stop" else "INFO", f"{cmd} sent", hub.get(station_id).current_job)
    return {"sent": cmd}


@router.get("/stations/{station_id}/camera")
def camera(station_id: str, request: Request, who: Principal = Depends(require("station", "teacher"))):
    own_station(request, who, station_id)
    jpeg = request.app.state.hub.get(station_id).camera
    if jpeg is None:
        raise ApiError(404, "not_found", "No camera picture is available from that station.")
    return Response(jpeg, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@router.get("/stations/{station_id}/logs")
def logs(station_id: str, request: Request, limit: int = 200, level: str | None = None, who: Principal = Depends(require("teacher"))):
    own_station(request, who, station_id)
    if level is not None and level not in LEVELS:
        raise ApiError(422, "invalid", f"level must be one of {', '.join(LEVELS)}.")
    return request.app.state.hub.recent_logs(station_id, max(1, min(limit, 5000)), level)


@router.put("/stations/{station_id}/log-level", status_code=204)
async def set_log_level(station_id: str, request: Request, body: dict[str, Any] = Body(...), who: Principal = Depends(require("teacher"))):
    own_station(request, who, station_id)
    level = body.get("level")
    if level not in LEVELS:
        raise ApiError(422, "invalid", f"level must be one of {', '.join(LEVELS)}.")
    hub = request.app.state.hub
    await hub.send(station_id, {"type": "control", "command": "set_log_level", "level": level})
    hub.server_log(station_id, "INFO", f"log level set to {level} by {who.id}")
    return Response(status_code=204)


@router.post("/stations/{station_id}/diagnostics", status_code=202)
async def request_diagnostics(station_id: str, request: Request, who: Principal = Depends(require("teacher"))):
    own_station(request, who, station_id)
    hub = request.app.state.hub
    await hub.send(station_id, {"type": "control", "command": "diagnostic_bundle"})
    hub.server_log(station_id, "INFO", f"diagnostic bundle requested by {who.id}")
    return {"requested": True}


@router.post("/stations/{station_id}/diagnostics/upload", status_code=201)
async def upload_diagnostics(station_id: str, request: Request, file: UploadFile = File(...), who: Principal = Depends(require("station")), cfg: Settings = Depends(get_settings)):
    if who.id != station_id:
        raise ApiError(403, "forbidden", "A station can only upload its own diagnostics.")
    data = await read_upload(file, cfg)
    if not data.startswith(b"PK"):
        raise ApiError(422, "invalid", "Diagnostics must be a zip file.")
    folder = cfg.data_dir / "diagnostics" / station_id
    folder.mkdir(parents=True, exist_ok=True)
    name = utcnow().strftime("%Y%m%dT%H%M%SZ") + ".zip"  # never the uploaded file's own name
    (folder / name).write_bytes(data)
    request.app.state.hub.server_log(station_id, "INFO", f"diagnostic bundle stored as {name} ({len(data)} bytes)")
    return {"stored": name}
