"""Job lifecycle: save, validate, generate G-code, approve, cancel. Every change is written to the audit trail."""
from __future__ import annotations

import hashlib
import secrets
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import services_classes as classes
from . import services_presets as sp
from .config import Settings
from .db import iso, utcnow
from .errors import ApiError
from .gcode import GcodeError, Result, generate, probe_head
from .models import ActivityWork, GcodeRow, Job, JobEvent

SCHEMA_VERSION = "0.2.21"
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
    if j.activity_id:
        doc["activityId"] = j.activity_id
    if j.dimensions:
        doc["dimensions"] = j.dimensions
    if j.status_reason:
        doc["statusReason"] = j.status_reason
    return doc


def receipt(j: Job, position: int | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {"id": j.id, "status": j.status, "warnings": j.warnings or [], "ticket": j.ticket, "position": position}
    if j.estimate:
        out["estimate"] = j.estimate
    replaced = getattr(j, "_replaced", None)
    if replaced:
        out["replaced"] = replaced
    return out


def get_visible(s: Session, job_id: str, who) -> Job:
    """404 (not 403) for someone else's job, so job IDs cannot be probed."""
    j = s.get(Job, job_id)
    if j is None or j.school_id != who.school or (not who.staff() and j.pupil_id != who.id):
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
    preset = sp.preset_version(s, j.school_id, j.preset_id, j.preset_version)
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
    if sp.preset_version(s, j.school_id, j.preset_id, j.preset_version) is None:
        raise ApiError(422, "unknown_preset", f"There is no preset '{j.preset_id}'.")
    warnings = check_cut_paths(j.objects, cfg)
    machines = sp.list_machines(s, j.school_id)
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
    p = sp.latest_preset(s, who.school, doc["preset"]["id"])
    if p is None:
        raise ApiError(422, "unknown_preset", f"There is no preset '{doc['preset']['id']}'.")
    j = Job(
        id=new_id(), pupil_id=pupil, school_id=who.school, status="draft", source=source, preset_id=p["id"], preset_version=p["version"],
        station=doc.get("station"), origin=doc["origin"], objects=doc["objects"], dimensions=doc.get("dimensions", []), warnings=[], report=report, units=units,
    )
    s.add(j)
    s.flush()
    from . import services_activities as activities

    activities.link_job(s, who, j, doc.get("activityId"))
    event(s, j.id, who.id, "created", {"source": source})
    if status == "submitted":
        submit(s, cfg, who, j)
    return j


def replace(s: Session, who, j: Job, doc: dict[str, Any]) -> Job:
    if j.status != "draft":
        raise ApiError(409, "conflict", "Only a draft can be changed. Save it as a new job instead.")
    p = sp.latest_preset(s, j.school_id, doc["preset"]["id"])
    if p is None:
        raise ApiError(422, "unknown_preset", f"There is no preset '{doc['preset']['id']}'.")
    j.objects, j.origin, j.station = doc["objects"], doc["origin"], doc.get("station")
    j.dimensions = doc.get("dimensions", [])
    if "activityId" in doc:
        from . import services_activities as activities

        activities.link_job(s, who, j, doc["activityId"])
    j.preset_id, j.preset_version = p["id"], p["version"]
    j.estimate, j.warnings = None, []
    event(s, j.id, who.id, "replaced")
    return j


def submit(s: Session, cfg: Settings, who, j: Job) -> Job:
    if j.status != "draft":
        raise ApiError(409, "conflict", f"This job is already {j.status}.")
    p = sp.latest_preset(s, j.school_id, j.preset_id)
    if p is not None:  # pick up preset edits made since the draft was saved
        j.preset_version = p["version"]
    validate_for_cutting(s, j, cfg)
    if cfg.replace_old_sends:
        j._replaced = replace_waiting(s, who, j)  # type: ignore[attr-defined]
    j.status = "submitted"
    event(s, j.id, who.id, "submitted")
    # Approval is skipped when switched off for the whole server, or for this pupil's class (e.g. Year 10 yes, Year 7 no).
    if not cfg.require_approval or not classes.needs_approval(s, j.pupil_id):
        j.status = "approved"
        j.approved_by = "auto"
        from . import services_queue as queue  # (the queue module imports this one)

        queue.enqueue(s, j)
        event(s, j.id, "server", "approved", {"auto": True})
    return j


def replace_waiting(s: Session, who, new: Job) -> list[dict[str, Any]]:
    """A new send replaces this pupil's earlier sends that are still waiting (submitted or approved). The new file goes to the back of the queue:
    the pupil does not keep the old place. A file already on a laser (assigned, running) is never touched, and neither are drafts. Returns what was
    replaced, for the receipt. Called only once the new file has passed validation, so a failed send never cancels anything."""
    old_jobs = list(s.scalars(select(Job).where(Job.pupil_id == new.pupil_id, Job.school_id == new.school_id, Job.id != new.id,
                                                Job.status.in_(("submitted", "approved")), Job.source != "calibration")))
    replaced = []
    for old in old_jobs:
        replaced.append({"id": old.id, "ticket": old.ticket})
        old.status, old.status_reason = "cancelled", f"Replaced by a newer file ({new.id})"
        old.framed_station = old.framed_at = old.framed_bounds = None
        event(s, old.id, who.id, "replaced", {"by": new.id})
        for w in s.scalars(select(ActivityWork).where(ActivityWork.job_id == old.id)):  # the hand-in follows the newest file
            w.job_id = new.id
    return replaced


def approve(s: Session, who, j: Job, station: str | None) -> Job:
    if j.status != "submitted":
        raise ApiError(409, "conflict", f"Only a submitted job can be approved; this one is {j.status}.")
    if station is not None:
        if sp.get_machine(s, j.school_id, station) is None:
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
    if who.role == "technician" and j.status != "approved":
        raise ApiError(409, "conflict", "A technician can only reject a file that is waiting in the queue to be cut.")
    note = reason.strip()[:480] or "Rejected"
    j.status, j.status_reason = "cancelled", (f"Rejected at the laser: {note}" if who.role == "technician" else note)
    event(s, j.id, who.id, "rejected", {"reason": j.status_reason})
    return j


def cancel(s: Session, who, j: Job) -> Job:
    if j.status not in OPEN_STATES:
        raise ApiError(409, "conflict", f"This job is {j.status}; it can't be cancelled here. A running job is stopped from the station.")
    j.status, j.status_reason = "cancelled", f"Cancelled by {who.id}"
    event(s, j.id, who.id, "cancelled")
    return j


# ---------------------------------------------------------------- camera calibration marks

def square_object(oid: str, x: float, y: float, size: float, layer: str) -> dict[str, Any]:
    """A closed square with its lower-left corner at (x, y) bed mm, drawn counter-clockwise from that corner."""
    pts = [(x + size, y), (x + size, y + size), (x, y + size), (x, y)]
    return {"id": oid, "layer": layer, "closed": True, "start": [x, y], "segments": [{"type": "line", "to": [px, py]} for px, py in pts], "matrix": [1, 0, 0, 1, 0, 0]}


def calibration_marks(s: Session, cfg: Settings, who, station_id: str, params: dict[str, Any]) -> tuple[Job, list[dict[str, Any]]]:
    """A job of known squares for a teacher to cut with a laser, so the camera can be calibrated from where they appear.
    It is pinned to that laser and approved (the teacher runs it from the Admin site). Returns the job and the squares' corners."""
    if sp.get_machine(s, who.school, station_id) is None:
        raise ApiError(404, "not_found", f"There is no laser '{station_id}'.")

    def num(key: str, lo: float, hi: float, default: float | None = None) -> float:
        v = params.get(key, default)
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not lo <= v <= hi:
            raise ApiError(422, "invalid", f"{key} must be a number from {lo:g} to {hi:g}.")
        return float(v)

    size, cx, cy = num("sizeMm", 10, 200, 40), num("centerX", 0, 5000), num("centerY", 0, 5000)
    count = params.get("count", 4)
    if count not in (1, 4):
        raise ApiError(422, "invalid", "count is 1 or 4 squares.")
    layer = params.get("layer", "score")
    if layer not in ("score", "cut"):
        raise ApiError(422, "invalid", "layer is score or cut.")
    spacing = num("spacingMm", size + 5, 2000, 120) if count == 4 else 0.0
    centres = [(cx, cy)] if count == 1 else [(cx + dx * spacing / 2, cy + dy * spacing / 2) for dy in (-1, 1) for dx in (-1, 1)]
    squares = [(x - size / 2, y - size / 2) for x, y in centres]
    objects = [square_object(f"mark{i + 1}", x, y, size, layer) for i, (x, y) in enumerate(squares)]
    doc = {"pupilId": who.id, "preset": {"id": str(params.get("presetId") or "")}, "station": station_id, "origin": {"mode": "absolute"}, "objects": objects}
    j = create(s, cfg, who, doc, source="calibration", status="draft")
    j.status = "submitted"
    event(s, j.id, who.id, "submitted")
    validate_for_cutting(s, j, cfg)  # 422 if the squares do not fit the bed
    approve(s, who, j, station_id)
    corners = [{"square": i + 1, "corners": [[x, y], [x + size, y], [x + size, y + size], [x, y + size]]} for i, (x, y) in enumerate(squares)]
    return j, corners
