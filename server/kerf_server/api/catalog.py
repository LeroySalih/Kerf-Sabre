"""Presets and machine profiles."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, Request, Response
from sqlalchemy.orm import Session

from .. import services_presets as sp
from ..config import Settings
from ..deps import get_session, get_settings
from ..errors import ApiError
from ..schemas import validate
from ..security import Principal, require

router = APIRouter(tags=["catalog"])


@router.get("/presets")
def list_presets(who: Principal = Depends(require("pupil", "station")), s: Session = Depends(get_session)):
    return sp.list_latest_presets(s, who.school)


@router.post("/presets", status_code=201)
def create_preset(doc: dict[str, Any] = Body(...), p: Principal = Depends(require("teacher")), s: Session = Depends(get_session), cfg: Settings = Depends(get_settings)):
    validate(cfg.shared_dir, "preset", doc)
    return sp.create_preset(s, p.school, doc, p.id)


@router.get("/presets/{preset_id}")
def get_preset(preset_id: str, who: Principal = Depends(require("pupil", "station")), s: Session = Depends(get_session)):
    doc = sp.latest_preset(s, who.school, preset_id)
    if doc is None:
        raise ApiError(404, "not_found", f"There is no preset '{preset_id}'.")
    return doc


@router.put("/presets/{preset_id}")
def update_preset(preset_id: str, doc: dict[str, Any] = Body(...), p: Principal = Depends(require("teacher")), s: Session = Depends(get_session), cfg: Settings = Depends(get_settings)):
    validate(cfg.shared_dir, "preset", doc)
    return sp.update_preset(s, p.school, preset_id, doc, p.id)


@router.post("/presets/{preset_id}/tested")
def mark_tested(preset_id: str, body: dict[str, Any] = Body(...), p: Principal = Depends(require("teacher", "technician")), s: Session = Depends(get_session)):
    """After a material test grid was cut on a laser and the settings look right: mark the material tested there (or untested again).
    Makes a new preset version, like any preset edit."""
    station, tested = body.get("station"), body.get("tested", True)
    if not isinstance(station, str) or not isinstance(tested, bool):
        raise ApiError(422, "invalid", "Send station and, optionally, tested: true or false.")
    if sp.get_machine(s, p.school, station) is None:
        raise ApiError(404, "not_found", f"There is no laser '{station}'.")
    cur = sp.latest_preset(s, p.school, preset_id)
    if cur is None:
        raise ApiError(404, "not_found", f"There is no preset '{preset_id}'.")
    on = set(cur.get("testedOn") or [])
    want = on | {station} if tested else on - {station}
    if want == on:
        return cur
    return sp.update_preset(s, p.school, preset_id, {**cur, "testedOn": sorted(want)}, p.id)


@router.get("/machines")
def list_machines(who: Principal = Depends(require("pupil", "station")), s: Session = Depends(get_session)):
    return sp.list_machines(s, who.school)


@router.get("/machines/{machine_id}")
def get_machine(machine_id: str, who: Principal = Depends(require("pupil", "station")), s: Session = Depends(get_session)):
    doc = sp.get_machine(s, who.school, machine_id)
    if doc is None:
        raise ApiError(404, "not_found", f"There is no machine '{machine_id}'.")
    return doc


@router.put("/machines/{machine_id}")
def put_machine(machine_id: str, doc: dict[str, Any] = Body(...), who: Principal = Depends(require("teacher")), s: Session = Depends(get_session), cfg: Settings = Depends(get_settings)):
    validate(cfg.shared_dir, "machine", doc)
    return sp.put_machine(s, who.school, machine_id, doc)


@router.delete("/machines/{machine_id}", status_code=204)
def delete_machine(machine_id: str, request: Request, who: Principal = Depends(require("admin")), s: Session = Depends(get_session)):
    """School admins remove a laser. Refused (409) while its Cutter is connected or files are waiting for it."""
    live = request.app.state.hub.stations.get(machine_id)
    if live is not None and live.online and sp.get_machine(s, who.school, machine_id) is not None:
        raise ApiError(409, "station_online", f"The Cutter on {machine_id} is still connected. Stop it on that PC first.")
    n = sp.delete_machine(s, who.school, machine_id)
    request.app.state.hub.server_log(machine_id, "INFO", f"station removed by {who.id}; {n} token(s) revoked")
    request.app.state.hub.stations.pop(machine_id, None)
    return Response(status_code=204)
