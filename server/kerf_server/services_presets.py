"""Material presets (every version kept) and machine profiles."""
from __future__ import annotations

from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .errors import ApiError
from .models import MachineRow, PresetRow


def latest_preset(s: Session, school: str, preset_id: str) -> dict[str, Any] | None:
    row = s.scalar(select(PresetRow).where(PresetRow.school_id == school, PresetRow.id == preset_id).order_by(PresetRow.version.desc()).limit(1))
    return row.data if row else None


def preset_version(s: Session, school: str, preset_id: str, version: int) -> dict[str, Any] | None:
    row = s.get(PresetRow, (school, preset_id, version))
    return row.data if row else None


def list_latest_presets(s: Session, school: str) -> list[dict[str, Any]]:
    newest = select(PresetRow.id, func.max(PresetRow.version).label("v")).where(PresetRow.school_id == school).group_by(PresetRow.id).subquery()
    rows = s.scalars(select(PresetRow).join(newest, (PresetRow.id == newest.c.id) & (PresetRow.version == newest.c.v)).where(PresetRow.school_id == school).order_by(PresetRow.id))
    return [r.data for r in rows]


def create_preset(s: Session, school: str, doc: dict[str, Any], actor: str) -> dict[str, Any]:
    if latest_preset(s, school, doc["id"]) is not None:
        raise ApiError(409, "conflict", f"A preset called '{doc['id']}' already exists. Update it instead.")
    s.add(PresetRow(school_id=school, id=doc["id"], version=doc["version"], data=doc, updated_by=actor))
    return doc


def update_preset(s: Session, school: str, preset_id: str, doc: dict[str, Any], actor: str) -> dict[str, Any]:
    """The server owns version numbers: every edit becomes the next version, so jobs keep the version they used."""
    cur = latest_preset(s, school, preset_id)
    if cur is None:
        raise ApiError(404, "not_found", f"There is no preset '{preset_id}'.")
    if doc["id"] != preset_id:
        raise ApiError(422, "invalid", "The preset id in the body must match the URL.")
    new = {**doc, "version": cur["version"] + 1}
    s.add(PresetRow(school_id=school, id=preset_id, version=new["version"], data=new, updated_by=actor))
    return new


def list_machines(s: Session, school: str) -> list[dict[str, Any]]:
    return [m.data for m in s.scalars(select(MachineRow).where(MachineRow.school_id == school).order_by(MachineRow.id))]


def get_machine(s: Session, school: str, machine_id: str) -> dict[str, Any] | None:
    """A school's laser. Another school's laser looks like it does not exist."""
    row = s.get(MachineRow, machine_id)
    return row.data if row is not None and row.school_id == school else None


def put_machine(s: Session, school: str, machine_id: str, doc: dict[str, Any]) -> dict[str, Any]:
    if doc["id"] != machine_id:
        raise ApiError(422, "invalid", "The machine id in the body must match the URL.")
    row = s.get(MachineRow, machine_id)
    if row is None:
        s.add(MachineRow(id=machine_id, school_id=school, data=doc))
    elif row.school_id != school:
        raise ApiError(409, "conflict", f"The laser ID '{machine_id}' is already in use. Choose a different ID.")
    else:
        row.data = doc
    return doc
