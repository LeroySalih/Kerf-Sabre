"""The files a person has open in the Editor (their tabs), kept on the server so another browser shows the same tabs after sign-in.

Only the list lives here: each tab is a job the person owns (autosave keeps its content on the server), so nothing but ids, tab names and
which tab was showing is stored. Whatever is not the caller's own, still existing file is dropped on the way in and on the way out."""
from __future__ import annotations

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import iso
from .errors import ApiError
from .models import Job, Workspace
from .services_jobs import clean_name

MAX_TABS = 30


def _own_jobs(s: Session, who, ids: list[str]) -> set[str]:
    if not ids:
        return set()
    return set(s.scalars(select(Job.id).where(Job.id.in_(ids), Job.pupil_id == who.id, Job.school_id == who.school)))


def _clean(s: Session, who, data: dict[str, Any]) -> dict[str, Any]:
    raw = data.get("tabs") if isinstance(data.get("tabs"), list) else []
    items = [t for t in raw if isinstance(t, dict) and isinstance(t.get("jobId"), str)]
    mine = _own_jobs(s, who, [t["jobId"] for t in items])
    seen: set[str] = set()
    tabs: list[dict[str, Any]] = []
    for t in items:
        jid = t["jobId"]
        if jid not in mine or jid in seen:
            continue
        seen.add(jid)
        tabs.append({"jobId": jid, "name": clean_name(t.get("name")), "renamed": t.get("renamed") is True})
    active = data.get("active")
    return {"tabs": tabs, "active": active if isinstance(active, str) and active in seen else None}


def load(s: Session, who) -> dict[str, Any]:
    row = s.get(Workspace, (who.id, who.school or ""))
    out = _clean(s, who, row.data if row else {})
    out["updatedAt"] = iso(row.updated_at) if row else None
    return out


def save(s: Session, who, body: dict[str, Any]) -> dict[str, Any]:
    tabs = body.get("tabs")
    if not isinstance(tabs, list):
        raise ApiError(422, "invalid", "tabs is a list of {jobId, name}.")
    if len(tabs) > MAX_TABS:
        raise ApiError(422, "invalid", f"At most {MAX_TABS} tabs.")
    data = _clean(s, who, body)
    row = s.get(Workspace, (who.id, who.school or ""))
    if row is None:
        row = Workspace(user_id=who.id, school_id=who.school or "", data=data)
        s.add(row)
    else:
        row.data = data
    s.flush()
    s.refresh(row)
    return {**data, "updatedAt": iso(row.updated_at)}
