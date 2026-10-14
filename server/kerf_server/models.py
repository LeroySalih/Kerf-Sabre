"""Database tables. Pupils are only ever identified by pupil ID: there is no column for a name."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, Boolean, Float, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base, utcnow


class Token(Base):
    """A bearer token. Only its SHA-256 is stored, so a database leak does not leak working tokens."""

    __tablename__ = "tokens"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    role: Mapped[str] = mapped_column(String(16))  # pupil | teacher | station
    subject_id: Mapped[str] = mapped_column(String(64), index=True)  # pupil ID, teacher ID or station id
    label: Mapped[str | None] = mapped_column(String(128), nullable=True)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Job(Base):
    __tablename__ = "jobs"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    pupil_id: Mapped[str] = mapped_column(String(64), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    status: Mapped[str] = mapped_column(String(16), index=True)
    status_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    source: Mapped[str] = mapped_column(String(8), default="editor")
    preset_id: Mapped[str] = mapped_column(String(64))
    preset_version: Mapped[int] = mapped_column(Integer)
    station: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    origin: Mapped[dict[str, Any]] = mapped_column(JSON)
    objects: Mapped[list[dict[str, Any]]] = mapped_column(JSON)
    estimate: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    #: Dimension annotations from the Editor. Stored and returned, never used for G-code.
    dimensions: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    warnings: Mapped[list[str]] = mapped_column(JSON, default=list)
    report: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)  # DXF clean-up report
    units: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    #: Queue ticket (only ever goes up, never reused) and sort key (changes when a teacher reorders or a job is deferred).
    ticket: Mapped[int | None] = mapped_column(Integer, nullable=True, unique=True)
    rank: Mapped[float | None] = mapped_column(Float, nullable=True, index=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    approved_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    framed_station: Mapped[str | None] = mapped_column(String(64), nullable=True)
    framed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    framed_bounds: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    running_since: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class JobEvent(Base):
    """Audit trail: who did what to a job, and when. Actor is a pupil/teacher/station ID, never a name."""

    __tablename__ = "job_events"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    job_id: Mapped[str] = mapped_column(String(32), ForeignKey("jobs.id", ondelete="CASCADE"), index=True)
    ts: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    actor: Mapped[str] = mapped_column(String(64))
    kind: Mapped[str] = mapped_column(String(32))
    detail: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)


class PresetRow(Base):
    """Every version of every preset is kept, so a job can always be reproduced with the version it recorded."""

    __tablename__ = "presets"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    version: Mapped[int] = mapped_column(Integer, primary_key=True)
    data: Mapped[dict[str, Any]] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_by: Mapped[str | None] = mapped_column(String(64), nullable=True)


class MachineRow(Base):
    __tablename__ = "machines"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    data: Mapped[dict[str, Any]] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class GcodeRow(Base):
    """Generated G-code. station is '' for the general version made at submission, or the laser it was resolved for."""

    __tablename__ = "gcode"
    __table_args__ = (UniqueConstraint("job_id", "station", name="uq_gcode_job_station"), Index("ix_gcode_job", "job_id"))
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    job_id: Mapped[str] = mapped_column(String(32), ForeignKey("jobs.id", ondelete="CASCADE"))
    station: Mapped[str] = mapped_column(String(64), default="")
    preset_version: Mapped[int] = mapped_column(Integer)
    text: Mapped[str] = mapped_column(Text)
    sha256: Mapped[str] = mapped_column(String(64))
    total_lines: Mapped[int] = mapped_column(Integer)
    estimated_s: Mapped[float] = mapped_column(default=0.0)
    bounds: Mapped[dict[str, Any]] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Counter(Base):
    """Named counters that only go up (the queue ticket number)."""

    __tablename__ = "counters"
    name: Mapped[str] = mapped_column(String(32), primary_key=True)
    value: Mapped[int] = mapped_column(Integer, default=0)
