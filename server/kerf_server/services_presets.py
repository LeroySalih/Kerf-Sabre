"""Material presets (every version kept) and machine profiles."""
from __future__ import annotations

from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .errors import ApiError
from .models import MachineRow, PresetRow


def latest_preset(s: Session, preset_id: str) -> dict[str, Any] | None:
    row = s.scalar(select(PresetRow).where(PresetRow.id == preset_id).order_by(PresetRow.version.desc()).limit(1))
    return row.data if row else None


def preset_version(s: Session, preset_id: str, version: int) -> dict[str, Any] | None:
    row = s.get(PresetRow, (preset_id, version))
    return row.data if row else None


def list_latest_presets(s: Session) -> list[dict[str, Any]]:
    newest = select(PresetRow.id, func.max(PresetRow.version).label("v")).group_by(PresetRow.id).subquery()
    rows = s.scalars(select(PresetRow).join(newest, (PresetRow.id == newest.c.id) & (PresetRow.version == newest.c.v)).order_by(PresetRow.id))
    return [r.data for r in rows]


def create_preset(s: Session, doc: dict[str, Any], actor: str) -> dict[str, Any]:
    if latest_preset(s, doc["id"]) is not None:
        raise ApiError(409, "conflict", f"A preset called '{doc['id']}' already exists. Update it instead.")
    s.add(PresetRow(id=doc["id"], version=doc["version"], data=doc, updated_by=actor))
    return doc


def update_preset(s: Session, preset_id: str, doc: dict[str, Any], actor: str) -> dict[str, Any]:
    """The server owns version numbers: every edit becomes the next version, so jobs keep the version they used."""
    cur = latest_preset(s, preset_id)
    if cur is None:
        raise ApiError(404, "not_found", f"There is no preset '{preset_id}'.")
    if doc["id"] != preset_id:
        raise ApiError(422, "invalid", "The preset id in the body must match the URL.")
    new = {**doc, "version": cur["version"] + 1}
    s.add(PresetRow(id=preset_id, version=new["version"], data=new, updated_by=actor))
    return new


def list_machines(s: Session) -> list[dict[str, Any]]:
    return [m.data for m in s.scalars(select(MachineRow).order_by(MachineRow.id))]


def get_machine(s: Session, machine_id: str) -> dict[str, Any] | None:
    row = s.get(MachineRow, machine_id)
    return row.data if row else None


def put_machine(s: Session, machine_id: str, doc: dict[str, Any]) -> dict[str, Any]:
    if doc["id"] != machine_id:
        raise ApiError(422, "invalid", "The machine id in the body must match the URL.")
    row = s.get(MachineRow, machine_id)
    if row is None:
        s.add(MachineRow(id=machine_id, data=doc))
    else:
        row.data = doc
    return doc
