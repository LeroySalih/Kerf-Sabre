"""The read-only tools. Each one reuses the REST services with the caller's Principal, so a school only ever sees its own data."""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import services_jobs as sj
from .. import services_people as people
from .. import services_presets as sp
from .. import services_queue as queue
from ..config import Settings
from ..db import iso
from ..models import GcodeRow, Job, JobEvent
from ..security import Principal
from ..stations import LEVELS, Hub
from .protocol import ToolError, Tool

STATUSES = ["draft", "submitted", "approved", "assigned", "running", "done", "failed", "cancelled", "rejected"]
DESIGN_MAX_BYTES = 100_000


@dataclass
class ToolContext:
    who: Principal
    s: Session
    cfg: Settings
    hub: Hub


def _layers(j: Job) -> dict[str, int]:
    out: dict[str, int] = {}
    for o in j.objects or []:
        out[o.get("layer", "?")] = out.get(o.get("layer", "?"), 0) + 1
    return out


def summary(j: Job, name: str | None = None) -> dict[str, Any]:
    est = j.estimate or {}
    out: dict[str, Any] = {
        "id": j.id, "name": j.name, "pupilId": j.pupil_id, "status": j.status, "statusReason": j.status_reason,
        "presetId": j.preset_id, "presetVersion": j.preset_version, "station": j.station, "ticket": j.ticket, "source": j.source,
        "activityId": j.activity_id, "createdAt": iso(j.created_at), "updatedAt": iso(j.updated_at), "approvedAt": iso(j.approved_at),
        "shapesByLayer": _layers(j), "warnings": list(j.warnings or [])[:10], "estimatedDurationS": est.get("durationS"), "extentMm": est.get("extentMm"),
    }
    if name:
        out["pupilName"] = name  # staff of the same school only (shared 0.2.22); never an email
    return out


def _job(c: ToolContext, job_id: str) -> Job:
    try:
        return sj.get_visible(c.s, job_id, c.who)  # 404 for another school's file
    except Exception as e:
        raise ToolError("There is no such file in your school.") from e


def _station(c: ToolContext, station_id: str) -> dict[str, Any]:
    m = sp.get_machine(c.s, c.who.school, station_id)
    if m is None:
        raise ToolError(f"There is no laser '{station_id}' in your school.")
    return m


# ------------------------------------------------------------------ files
def list_files(c: ToolContext, a: dict[str, Any]) -> dict[str, Any]:
    q = select(Job).where(Job.school_id == c.who.school).order_by(Job.created_at.desc(), Job.id)
    if a.get("status"):
        q = q.where(Job.status.in_(a["status"]))
    if a.get("station"):
        q = q.where((Job.station == a["station"]) | Job.station.is_(None))
    if a.get("pupil_id"):
        q = q.where(Job.pupil_id == a["pupil_id"])
    if a.get("activity_id"):
        q = q.where(Job.activity_id == a["activity_id"])
    limit, offset = a.get("limit", 50), a.get("offset", 0)
    rows = list(c.s.scalars(q.limit(limit).offset(offset)))
    names = people.names(c.s, c.who.school, (j.pupil_id for j in rows))
    return {"offset": offset, "returned": len(rows), "files": [summary(j, names.get(j.pupil_id)) for j in rows]}


def get_file(c: ToolContext, a: dict[str, Any]) -> dict[str, Any]:
    j = _job(c, a["id"])
    names = people.names(c.s, c.who.school, [j.pupil_id])
    out = summary(j, names.get(j.pupil_id))
    out.update({"origin": j.origin, "dimensions": j.dimensions or [], "warnings": list(j.warnings or []), "frame": {"station": j.framed_station, "at": iso(j.framed_at)} if j.framed_station else None})
    if a.get("include_events", True):
        ev = list(c.s.scalars(select(JobEvent).where(JobEvent.job_id == j.id).order_by(JobEvent.id.desc()).limit(50)))
        out["events"] = [{"ts": iso(e.ts), "actor": e.actor, "kind": e.kind, "detail": e.detail} for e in reversed(ev)]
    if a.get("include_design"):
        objs, used = [], 0
        for o in j.objects or []:
            used += len(json.dumps(o, separators=(",", ":")))
            if used > DESIGN_MAX_BYTES:
                break
            objs.append(o)
        out["design"] = {"objects": objs, "objectsTotal": len(j.objects or []), "truncated": len(objs) < len(j.objects or []), "cleanupReport": j.report, "units": j.units}
    return out


def get_gcode(c: ToolContext, a: dict[str, Any]) -> dict[str, Any]:
    j = _job(c, a["id"])
    rows = list(c.s.scalars(select(GcodeRow).where(GcodeRow.job_id == j.id).order_by(GcodeRow.station)))
    want = a.get("station") or ""
    row = next((r for r in rows if r.station == want), None) or (rows[0] if rows and not a.get("station") else None)
    if row is None:
        raise ToolError("No G-code has been made for that yet." if not rows else f"No G-code for station '{a.get('station')}'. Made for: {[r.station or '(general)' for r in rows]}.")
    lines = row.text.splitlines()
    n = a.get("max_lines", 200)
    return {"jobId": j.id, "station": row.station or None, "sha256": row.sha256, "totalLines": len(lines), "returnedLines": min(n, len(lines)),
            "truncated": len(lines) > n, "estimatedS": row.estimated_s, "gcode": "\n".join(lines[:n])}


# ------------------------------------------------------------------ queue
def get_queue(c: ToolContext, a: dict[str, Any]) -> dict[str, Any]:
    if a.get("station"):
        _station(c, a["station"])
    entries = queue.entries(c.s, c.who, c.cfg, a.get("station"))
    return {"onALaser": sum(1 for e in entries if e["position"] is None), "waiting": sum(1 for e in entries if e["position"] is not None), "entries": entries}


# ------------------------------------------------------------------ stations
def _live(c: ToolContext, m: dict[str, Any], calibrated: set[str]) -> dict[str, Any]:
    sid = m["id"]
    live = c.hub.get(sid).doc()
    nxt = queue.head(c.s, c.who.school, sid, c.cfg)
    out = {**live, "name": m.get("name"), "model": m.get("model"), "bed": m.get("bed"), "airAssist": m.get("airAssist"), "calibrated": sid in calibrated,
           "waitingForThisLaser": len(queue.eligible(c.s, c.who.school, sid, c.cfg)),
           "nextTicket": {"ticket": nxt.ticket, "jobId": nxt.id, "pupilId": nxt.pupil_id} if nxt else None}
    cur = live.get("currentJobId")
    if cur:
        j = c.s.get(Job, cur)
        out["currentJob"] = summary(j) if j is not None and j.school_id == c.who.school else None
    return out


def list_stations(c: ToolContext, a: dict[str, Any]) -> dict[str, Any]:
    done = sp.calibrated_ids(c.s, c.who.school)
    return {"stations": [_live(c, m, done) for m in sp.list_machines(c.s, c.who.school)]}


def get_station(c: ToolContext, a: dict[str, Any]) -> dict[str, Any]:
    m = _station(c, a["id"])
    out = _live(c, m, sp.calibrated_ids(c.s, c.who.school))
    n = a.get("log_lines", 0)
    if n:
        out["recentLogs"] = c.hub.recent_logs(a["id"], n, a.get("log_level"))
    return out


# ------------------------------------------------------------------ registry
def _obj(props: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return {"type": "object", "properties": props, "required": required or [], "additionalProperties": False}


TOOLS: dict[str, Tool] = {t.name: t for t in [
    Tool("list_files", "List submitted files",
         "List the files pupils have saved or sent to the laser cutter, newest first, with status, pupil ID, material, station, queue ticket, shape counts and the time estimate. Filter by status, station, pupil or activity.",
         _obj({"status": {"type": "array", "items": {"enum": STATUSES}, "description": "Only these statuses (e.g. [\"approved\"] for the queue)."},
               "station": {"type": "string", "description": "Files for this laser (including files not pinned to one)."},
               "pupil_id": {"type": "string"}, "activity_id": {"type": "string"},
               "limit": {"type": "integer", "minimum": 1, "maximum": 200, "default": 50}, "offset": {"type": "integer", "minimum": 0, "default": 0}}),
         list_files),
    Tool("get_file", "Get one file",
         "One file in full: status and reason, material, estimate, warnings, where it was framed, and its history (who did what, when). Set include_design to also get the shapes themselves (capped in size).",
         _obj({"id": {"type": "string"}, "include_events": {"type": "boolean", "default": True}, "include_design": {"type": "boolean", "default": False}}, ["id"]),
         get_file),
    Tool("get_gcode", "Get a file's G-code",
         "The G-code Kerf made for a file (absolute, G21/G90, no G92). Returns the first max_lines lines and the total, with its SHA-256.",
         _obj({"id": {"type": "string"}, "station": {"type": "string", "description": "The laser it was made for; leave out for the general version."},
               "max_lines": {"type": "integer", "minimum": 1, "maximum": 2000, "default": 200}}, ["id"]),
         get_gcode),
    Tool("get_queue", "Get the queue",
         "The laser queue: files cutting now, then waiting files in order with position, ticket, pupil, material, estimated time and time ahead. Give a station to see which file is next for that laser.",
         _obj({"station": {"type": "string"}}), get_queue),
    Tool("list_stations", "List laser stations",
         "Every laser station in the school: online or offline, machine state, head position, the file it is cutting and its progress, last contact, camera calibration, the next ticket for it and how many files wait for it.",
         _obj({}), list_stations),
    Tool("get_station", "Get one station",
         "One laser station's live status. Set log_lines (up to 100) to include the newest log lines from the Cutter and the Server for that station.",
         _obj({"id": {"type": "string"}, "log_lines": {"type": "integer", "minimum": 0, "maximum": 100, "default": 0},
               "log_level": {"enum": list(LEVELS), "description": "Lowest level to include."}}, ["id"]),
         get_station),
]}
