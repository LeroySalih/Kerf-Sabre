"""Material presets (every version kept) and machine profiles."""
from __future__ import annotations

import math
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


# ---------------------------------------------------------------- camera calibration

def _num(v: Any) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        raise ApiError(422, "invalid", "Calibration numbers must be finite numbers.")
    return float(v)


def project(h: list[float], x: float, y: float) -> tuple[float, float]:
    w = h[6] * x + h[7] * y + h[8]
    if abs(w) < 1e-12:
        raise ApiError(422, "invalid", "That calibration is degenerate (a point maps to infinity).")
    return (h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w


def check_calibration(doc: Any) -> dict[str, Any]:
    """A calibration the server will keep: image size, 4 to 64 camera points with the bed points they mark, and the camera -> bed
    homography (row-major 3x3). The server re-projects the points through the matrix, so a wrong matrix is refused."""
    if not isinstance(doc, dict):
        raise ApiError(422, "invalid", "Send the calibration as an object.")
    w, hh = doc.get("imageWidth"), doc.get("imageHeight")
    if not all(isinstance(v, int) and not isinstance(v, bool) and 16 <= v <= 20000 for v in (w, hh)):
        raise ApiError(422, "invalid", "imageWidth and imageHeight are the camera picture's size in pixels.")
    pts, h = doc.get("points"), doc.get("homography")
    if not isinstance(pts, list) or not 4 <= len(pts) <= 64:
        raise ApiError(422, "invalid", "Give 4 to 64 points: where known bed positions (corners, or the corners of squares the laser cut) are in the camera picture.")
    if not isinstance(h, list) or len(h) != 9:
        raise ApiError(422, "invalid", "homography is 9 numbers (a 3x3 matrix, row by row).")
    hm = [_num(v) for v in h]
    out_pts = []
    for p in pts:
        cam, bed = (p or {}).get("camera") if isinstance(p, dict) else None, (p or {}).get("bed") if isinstance(p, dict) else None
        if not (isinstance(cam, list) and len(cam) == 2 and isinstance(bed, list) and len(bed) == 2):
            raise ApiError(422, "invalid", "Each point needs camera [x, y] (pixels) and bed [x, y] (mm).")
        c, b = [_num(v) for v in cam], [_num(v) for v in bed]
        if not (0 <= c[0] <= w and 0 <= c[1] <= hh):
            raise ApiError(422, "invalid", "A camera point is outside the picture.")
        px, py = project(hm, c[0], c[1])
        # four points are fitted exactly; more are fitted by least squares, so some scatter is normal (this only catches nonsense)
        if math.hypot(px - b[0], py - b[1]) > (1.0 if len(pts) == 4 else 10.0):
            raise ApiError(422, "invalid", "The matrix does not map the points to their bed positions. Calibrate again.")
        out_pts.append({"camera": c, "bed": b})
    return {"imageWidth": w, "imageHeight": hh, "points": out_pts, "homography": hm}


def calibrated_ids(s: Session, school: str) -> set[str]:
    return {m.id for m in s.scalars(select(MachineRow).where(MachineRow.school_id == school)) if m.camera_calibration is not None}


def get_calibration(s: Session, school: str, machine_id: str) -> dict[str, Any] | None:
    row = s.get(MachineRow, machine_id)
    if row is None or row.school_id != school:
        raise ApiError(404, "not_found", f"There is no laser '{machine_id}'.")
    return row.camera_calibration


def put_calibration(s: Session, school: str, machine_id: str, doc: Any, actor: str) -> dict[str, Any]:
    get_calibration(s, school, machine_id)  # 404 for another school's laser
    from .db import iso, utcnow

    cal = {**check_calibration(doc), "calibratedBy": actor, "calibratedAt": iso(utcnow())}
    s.get(MachineRow, machine_id).camera_calibration = cal  # type: ignore[union-attr]
    return cal


def clear_calibration(s: Session, school: str, machine_id: str) -> None:
    get_calibration(s, school, machine_id)
    s.get(MachineRow, machine_id).camera_calibration = None  # type: ignore[union-attr]
