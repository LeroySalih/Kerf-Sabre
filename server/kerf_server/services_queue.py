"""The ticket queue: approved jobs are served first in, first out.

A job gets a ticket number when it is approved (numbers only go up and are never reused). Its place in the queue is its
`rank`, which starts equal to the ticket and only changes when a teacher moves it or it is deferred. A station may only
frame or start the job that is next for it.
"""
from __future__ import annotations

from datetime import timedelta
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from .config import Settings
from .db import as_utc, iso, utcnow
from .errors import ApiError
from .models import Counter, Job
from . import services_jobs as sj

ACTIVE = ("assigned", "running")


def next_ticket(s: Session) -> int:
    """Atomically take the next ticket number."""
    if s.get(Counter, "ticket") is None:
        s.add(Counter(name="ticket", value=0))
        s.flush()
    return int(s.execute(update(Counter).where(Counter.name == "ticket").values(value=Counter.value + 1).returning(Counter.value)).scalar_one())


def _back_rank(s: Session, school: str) -> float:
    return float(s.scalar(select(func.max(Job.rank)).where(Job.status == "approved", Job.school_id == school)) or 0) + 1


def enqueue(s: Session, j: Job) -> None:
    """Called when a job becomes approved. A job that already has a ticket keeps it."""
    if j.ticket is None:
        j.ticket = next_ticket(s)
    j.rank = max(float(j.ticket), _back_rank(s, j.school_id))  # new jobs always join the back
    j.approved_at = utcnow()


def waiting(s: Session, school: str) -> list[Job]:
    """A school's approved jobs in queue order (each school has its own queue). Any approved job without a ticket (data from before the queue existed) is given one."""
    rows = list(s.scalars(select(Job).where(Job.status == "approved", Job.school_id == school).order_by(Job.rank.is_(None), Job.rank, Job.id)))
    changed = False
    for j in rows:
        if j.ticket is None or j.rank is None:
            enqueue(s, j)
            changed = True
    return sorted(rows, key=lambda j: (j.rank, j.ticket)) if changed else rows


def _reserved_elsewhere(j: Job, station_id: str, cfg: Settings) -> bool:
    if not j.framed_station or j.framed_station == station_id or j.framed_at is None:
        return False
    return utcnow() - as_utc(j.framed_at) <= timedelta(minutes=cfg.frame_valid_minutes)


def eligible(s: Session, school: str, station_id: str, cfg: Settings) -> list[Job]:
    """The waiting jobs `station_id` may take, in the order it must take them."""
    mine = [j for j in waiting(s, school) if j.station in (None, station_id) and not _reserved_elsewhere(j, station_id, cfg)]
    # a job already framed on this station (someone is lining material up) keeps its turn
    return sorted(mine, key=lambda j: (j.framed_station != station_id or not _framed_fresh(j, cfg), j.rank))


def _framed_fresh(j: Job, cfg: Settings) -> bool:
    return j.framed_at is not None and utcnow() - as_utc(j.framed_at) <= timedelta(minutes=cfg.frame_valid_minutes)


def head(s: Session, school: str, station_id: str, cfg: Settings) -> Job | None:
    e = eligible(s, school, station_id, cfg)
    return e[0] if e else None


def ordinal(n: int) -> str:
    return f"{n}{'th' if 10 <= n % 100 <= 20 else {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')}"


def check_turn(s: Session, cfg: Settings, j: Job, station_id: str) -> None:
    """409 not_your_turn unless `j` is the next job for this station."""
    first = head(s, j.school_id, station_id, cfg)
    if first is None or first.id == j.id:
        return
    place = next((i for i, x in enumerate(eligible(s, j.school_id, station_id, cfg), 1) if x.id == j.id), None)
    where = f"It is {ordinal(place)} in the queue" if place else "It is not waiting for this laser"
    raise ApiError(409, "not_your_turn", f"Ticket {first.ticket} is next on {station_id}. {where} (ticket {j.ticket}). Wait for your turn, or ask a teacher.")


def entries(s: Session, who, cfg: Settings, station_id: str | None = None) -> list[dict[str, Any]]:
    """The queue as the API returns it: jobs on a laser first, then waiting jobs in order."""
    active = list(s.scalars(select(Job).where(Job.status.in_(ACTIVE), Job.school_id == who.school).order_by(Job.ticket)))
    wait = waiting(s, who.school)
    nxt = head(s, who.school, station_id, cfg) if station_id else None
    out: list[dict[str, Any]] = []
    ahead_s = 0.0
    for j in active:
        out.append(_entry(j, who, None, None, nxt))
    for pos, j in enumerate(wait, 1):
        out.append(_entry(j, who, pos, ahead_s, nxt))
        ahead_s += float((j.estimate or {}).get("durationS") or 0)
    return out


def _entry(j: Job, who, position: int | None, ahead_s: float | None, nxt: Job | None) -> dict[str, Any]:
    own = who.role == "pupil" and j.pupil_id == who.id
    show = who.staff() or own
    e: dict[str, Any] = {
        "ticket": j.ticket, "jobId": j.id if show else None, "status": j.status, "position": position,
        "pupilId": j.pupil_id if show else None, "own": own, "presetId": j.preset_id, "station": j.station,
        "framedOn": j.framed_station if j.status == "approved" else None,
        "estimatedS": (j.estimate or {}).get("durationS"), "aheadS": ahead_s, "approvedAt": iso(j.approved_at),
        "extentMm": (j.estimate or {}).get("extentMm"),
    }
    if nxt is not None:
        e["next"] = j.id == nxt.id
    return e


def position_of(s: Session, j: Job) -> int | None:
    for i, x in enumerate(waiting(s, j.school_id), 1):
        if x.id == j.id:
            return i
    return None


def move(s: Session, who, j: Job, to: str | None, position: int | None) -> None:
    if j.status != "approved":
        raise ApiError(409, "not_waiting", f"This job is {j.status}, not waiting in the queue.")
    if (to is None) == (position is None):
        raise ApiError(422, "invalid", "Say where to move it: either 'to' (front, back, up, down) or 'position'.")
    order = [x for x in waiting(s, j.school_id) if x.id != j.id]
    cur = position_of(s, j)
    if to is not None:
        if to not in ("front", "back", "up", "down"):
            raise ApiError(422, "invalid", "'to' must be front, back, up or down.")
        index = {"front": 0, "back": len(order), "up": max((cur or 1) - 2, 0), "down": min(cur or 1, len(order))}[to]
    else:
        index = min(max(position - 1, 0), len(order))  # type: ignore[operator]
    before = order[index - 1].rank if index > 0 else None
    after = order[index].rank if index < len(order) else None
    if before is None and after is None:
        j.rank = 1.0
    elif before is None:
        j.rank = after - 1  # type: ignore[operator]
    elif after is None:
        j.rank = before + 1
    else:
        j.rank = (before + after) / 2
    sj.event(s, j.id, who.id, "moved", {"to": to, "position": position, "newPosition": index + 1})


def defer(s: Session, who, j: Job) -> None:
    if j.status != "approved":
        raise ApiError(409, "not_waiting", f"This job is {j.status}, not waiting in the queue.")
    j.rank = _back_rank(s, j.school_id)
    j.framed_station = j.framed_at = j.framed_bounds = None
    sj.event(s, j.id, who.id, "deferred")
