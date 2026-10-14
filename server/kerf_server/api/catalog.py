"""Presets and machine profiles."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends
from sqlalchemy.orm import Session

from .. import services_presets as sp
from ..config import Settings
from ..deps import get_session, get_settings
from ..errors import ApiError
from ..schemas import validate
from ..security import Principal, require

router = APIRouter(tags=["catalog"])


@router.get("/presets")
def list_presets(_: Principal = Depends(require("pupil", "station")), s: Session = Depends(get_session)):
    return sp.list_latest_presets(s)


@router.post("/presets", status_code=201)
def create_preset(doc: dict[str, Any] = Body(...), p: Principal = Depends(require("teacher")), s: Session = Depends(get_session), cfg: Settings = Depends(get_settings)):
    validate(cfg.shared_dir, "preset", doc)
    return sp.create_preset(s, doc, p.id)


@router.get("/presets/{preset_id}")
def get_preset(preset_id: str, _: Principal = Depends(require("pupil", "station")), s: Session = Depends(get_session)):
    doc = sp.latest_preset(s, preset_id)
    if doc is None:
        raise ApiError(404, "not_found", f"There is no preset '{preset_id}'.")
    return doc


@router.put("/presets/{preset_id}")
def update_preset(preset_id: str, doc: dict[str, Any] = Body(...), p: Principal = Depends(require("teacher")), s: Session = Depends(get_session), cfg: Settings = Depends(get_settings)):
    validate(cfg.shared_dir, "preset", doc)
    return sp.update_preset(s, preset_id, doc, p.id)


@router.get("/machines")
def list_machines(_: Principal = Depends(require("pupil", "station")), s: Session = Depends(get_session)):
    return sp.list_machines(s)


@router.get("/machines/{machine_id}")
def get_machine(machine_id: str, _: Principal = Depends(require("pupil", "station")), s: Session = Depends(get_session)):
    doc = sp.get_machine(s, machine_id)
    if doc is None:
        raise ApiError(404, "not_found", f"There is no machine '{machine_id}'.")
    return doc


@router.put("/machines/{machine_id}")
def put_machine(machine_id: str, doc: dict[str, Any] = Body(...), _: Principal = Depends(require("teacher")), s: Session = Depends(get_session), cfg: Settings = Depends(get_settings)):
    validate(cfg.shared_dir, "machine", doc)
    return sp.put_machine(s, machine_id, doc)
