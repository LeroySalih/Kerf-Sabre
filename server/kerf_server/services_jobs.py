"""Job lifecycle: save, validate, generate G-code, approve, cancel. Every change is written to the audit trail."""
from __future__ import annotations

import hashlib
import secrets
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import services_presets as sp
from .config import Settings
from .db import iso, utcnow
from .errors import ApiError
from .gcode import GcodeError, Result, generate, probe_head
from .models import GcodeRow, Job, JobEvent

SCHEMA_VERSION = "0.2.4"
OPEN_STATES = ("draft", "submitted", "approved", "queued")  # states a job can be cancelled from


def new_id() -> str:
    return "job-" + secrets.token_hex(4)


def event(s: Session, job_id: str, actor: str, kind: str, detail: dict[str, Any] | None = None) -> None:
    s.add(JobEvent(job_id=job_id, actor=actor, kind=kind, detail=detail))


def to_doc(j: Job) -> dict[str, Any]:
    """The job as the shared job schema describes it."""
    doc: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "id": j.id,
        "pupilId": j.pupil_id,
        "createdAt": iso(j.created_at),
        "status": j.status,
        "preset": {"id": j.preset_id, "version": j.preset_version},
        "station": j.station,
        "origin": j.origin,
        "objects": j.objects,
        "source": j.source,
        "warnings": j.warnings or [],
    }
    if j.estimate:
        doc["estimate"] = j.estimate
    if j.ticket is not None:
        doc["ticket"] = j.ticket
    if j.dimensions:
        doc["dimensions"] = j.dimensions
    if j.status_reason:
        doc["statusReason"] = j.status_reason
    return doc


def receipt(j: Job, position: int | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {"id": j.id, "status": j.status, "warnings": j.warnings or [], "ticket": j.ticket, "position": position}
    if j.estimate:
        out["estimate"] = j.estimate
    return out


def get_visible(s: Session, job_id: str, who) -> Job:
    """404 (not 403) for someone else's job, so job IDs cannot be probed."""
    j = s.get(Job, job_id)
    if j is None or (not who.staff() and j.pupil_id != who.id):
        raise ApiError(404, "not_found", "There is no such job.")
    return j


def get_owned(s: Session, job_id: str, who) -> Job:
    j = get_visible(s, job_id, who)
    if who.role == "station":
        raise ApiError(403, "forbidden", "Stations cannot change a job's design.")
    return j


# ---------------------------------------------------------------- validation + G-code

def check_cut_paths(objects: list[dict[str, Any]], cfg: Settings) -> list[str]:
    open_cut = [o["id"] for o in objects if o["layer"] == "cut" and not o["closed"]]
    if not open_cut:
        return []
    if cfg.open_cut_paths == "block":
        raise ApiError(422, "open_cut_path", f"{len(open_cut)} shape(s) on the Cut layer are not closed, so they would not cut out a part. Close them or move them to Score.", [{"path": i, "message": "open Cut path"} for i in open_cut[:20]])
    return [f"{len(open_cut)} open path(s) on the Cut layer will be cut as drawn."]


def make_gcode(s: Session, j: Job, machine: dict[str, Any], head=None) -> Result:
    preset = sp.preset_version(s, j.preset_id, j.preset_version)
    if preset is None:
        raise ApiError(422, "unknown_preset", f"There is no preset '{j.preset_id}' version {j.preset_version}.")
    doc = to_doc(j)
    try:
        return generate(doc, preset, machine, head=head)
    except GcodeError as exc:
        raise ApiError(422, "gcode_failed", str(exc)) from exc


def store_gcode(s: Session, j: Job, station: str, r: Result) -> GcodeRow:
    text_hash = hashlib.sha256(r.text.encode()).hexdigest()
    row = s.scalar(select(GcodeRow).where(GcodeRow.job_id == j.id, GcodeRow.station == station))
    b = {"minX": r.bounds[0], "minY": r.bounds[1], "maxX": r.bounds[2], "maxY": r.bounds[3]}
    fields = dict(preset_version=j.preset_version, text=r.text, sha256=text_hash, total_lines=r.text.count("\n"), estimated_s=r.estimate["durationS"], bounds=b, created_at=utcnow())
    if row is None:
        row = GcodeRow(job_id=j.id, station=station, **fields)
        s.add(row)
    else:
        for k, v in fields.items():
            setattr(row, k, v)
    return row


def validate_for_cutting(s: Session, j: Job, cfg: Settings) -> None:
    """Everything that can be checked before a station is chosen. Sets estimate and warnings; stores a general G-code version."""
    if sp.preset_version(s, j.preset_id, j.preset_version) is None:
        raise ApiError(422, "unknown_preset", f"There is no preset '{j.preset_id}'.")
    warnings = check_cut_paths(j.objects, cfg)
    machines = sp.list_machines(s)
    if not machines:
        raise ApiError(422, "no_machines", "No laser is set up on this server yet.")
    wanted = [m for m in machines if j.station in (None, m["id"])]
    if not wanted:
        raise ApiError(422, "unknown_station", f"There is no laser '{j.station}'.")
    probe = probe_head(to_doc(j))
    first: tuple[dict[str, Any], Result] | None = None
    untested_on: list[str] = []
    errors: list[str] = []
    for m in wanted:
        try:
            r = make_gcode(s, j, m, probe)
        except ApiError as exc:
            errors.append(exc.message)
            warnings_for = f"This design does not fit or cannot be cut on {m['id']}: {exc.message}" if len(wanted) > 1 else None
            if warnings_for:
                warnings.append(warnings_for)
            continue
        if first is None:
            first = (m, r)
        if r.untested:
            untested_on.append(m["id"])
    if first is None:
        raise ApiError(422, "gcode_failed", errors[0])
    m, r = first
    if is_material_test(j):
        warnings.append("This is a material test, so settings that have not been tested yet are allowed.")
    if untested_on and not is_material_test(j):
        warnings.append(f"This material has not been test-gridded yet on: {', '.join(untested_on)}. Run a material test before cutting there.")
    warnings += [w for w in r.warnings if w not in warnings and "test" not in w.lower()]
    j.estimate = r.estimate
    j.warnings = warnings
    store_gcode(s, j, "", r)


def is_material_test(j: Job) -> bool:
    return any(o.get("settings") for o in j.objects)


# ---------------------------------------------------------------- lifecycle

def create(s: Session, cfg: Settings, who, doc: dict[str, Any], *, source: str = "editor", report=None, units=None, status: str = "draft") -> Job:
    pupil = doc["pupilId"]
    if not who.is_teacher and pupil != who.id:
        raise ApiError(403, "forbidden", "You can only save jobs under your own pupil ID.")
    p = sp.latest_preset(s, doc["preset"]["id"])
    if p is None:
        raise ApiError(422, "unknown_preset", f"There is no preset '{doc['preset']['id']}'.")
    j = Job(
        id=new_id(), pupil_id=pupil, status="draft", source=source, preset_id=p["id"], preset_version=p["version"],
        station=doc.get("station"), origin=doc["origin"], objects=doc["objects"], dimensions=doc.get("dimensions", []), warnings=[], report=report, units=units,
    )
    s.add(j)
    s.flush()
    event(s, j.id, who.id, "created", {"source": source})
    if status == "submitted":
        submit(s, cfg, who, j)
    return j


def replace(s: Session, who, j: Job, doc: dict[str, Any]) -> Job:
    if j.status != "draft":
        raise ApiError(409, "conflict", "Only a draft can be changed. Save it as a new job instead.")
    p = sp.latest_preset(s, doc["preset"]["id"])
    if p is None:
        raise ApiError(422, "unknown_preset", f"There is no preset '{doc['preset']['id']}'.")
    j.objects, j.origin, j.station = doc["objects"], doc["origin"], doc.get("station")
    j.dimensions = doc.get("dimensions", [])
    j.preset_id, j.preset_version = p["id"], p["version"]
    j.estimate, j.warnings = None, []
    event(s, j.id, who.id, "replaced")
    return j


def submit(s: Session, cfg: Settings, who, j: Job) -> Job:
    if j.status != "draft":
        raise ApiError(409, "conflict", f"This job is already {j.status}.")
    p = sp.latest_preset(s, j.preset_id)
    if p is not None:  # pick up preset edits made since the draft was saved
        j.preset_version = p["version"]
    validate_for_cutting(s, j, cfg)
    j.status = "submitted"
    event(s, j.id, who.id, "submitted")
    if not cfg.require_approval:
        j.status = "approved"
        j.approved_by = "auto"
        from . import services_queue as queue  # (the queue module imports this one)

        queue.enqueue(s, j)
        event(s, j.id, "server", "approved", {"auto": True})
    return j


def approve(s: Session, who, j: Job, station: str | None) -> Job:
    if j.status != "submitted":
        raise ApiError(409, "conflict", f"Only a submitted job can be approved; this one is {j.status}.")
    if station is not None:
        if sp.get_machine(s, station) is None:
            raise ApiError(422, "unknown_station", f"There is no laser '{station}'.")
        j.station = station
    j.status, j.approved_by = "approved", who.id
    from . import services_queue as queue

    queue.enqueue(s, j)
    event(s, j.id, who.id, "approved", {"station": station})
    return j


def reject(s: Session, who, j: Job, reason: str) -> Job:
    if j.status not in ("submitted", "approved"):
        raise ApiError(409, "conflict", f"Only a waiting job can be rejected; this one is {j.status}.")
    j.status, j.status_reason = "cancelled", reason.strip()[:500] or "Rejected"
    event(s, j.id, who.id, "rejected", {"reason": j.status_reason})
    return j


def cancel(s: Session, who, j: Job) -> Job:
    if j.status not in OPEN_STATES:
        raise ApiError(409, "conflict", f"This job is {j.status}; it can't be cancelled here. A running job is stopped from the station.")
    j.status, j.status_reason = "cancelled", f"Cancelled by {who.id}"
    event(s, j.id, who.id, "cancelled")
    return j
