"""Database tables. Pupils are only ever identified by pupil ID: there is no column for a name."""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, Boolean, Float, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base, utcnow


DEFAULT_SCHOOL = "main"  # the school that databases made before schools existed belong to


class School(Base):
    """A school. Everything else (classes, pupils, activities, files, lasers, materials) belongs to exactly one school."""

    __tablename__ = "schools"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Token(Base):
    """A bearer token. Only its SHA-256 is stored, so a database leak does not leak working tokens."""

    __tablename__ = "tokens"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    role: Mapped[str] = mapped_column(String(16))  # pupil | teacher | admin | station | platform
    subject_id: Mapped[str] = mapped_column(String(64), index=True)  # pupil ID, teacher ID or station id
    #: The school this token belongs to. None only for a platform token, which belongs to no school.
    school_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    label: Mapped[str | None] = mapped_column(String(128), nullable=True)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)
    #: Login sessions expire; tokens issued by an administrator do not (None).
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Job(Base):
    __tablename__ = "jobs"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    pupil_id: Mapped[str] = mapped_column(String(64), index=True)
    school_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
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
    #: The pupil's own title for the file (optional).
    name: Mapped[str | None] = mapped_column(String(60), nullable=True)
    #: The class activity this file was made for, if any.
    activity_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    approved_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    framed_station: Mapped[str | None] = mapped_column(String(64), nullable=True)
    framed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    framed_bounds: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    running_since: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Workspace(Base):
    """The files a person has open in the Editor, in tab order, so another browser shows the same tabs after sign-in. One row per person."""

    __tablename__ = "workspaces"
    user_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    school_id: Mapped[str] = mapped_column(String(32), primary_key=True, default="")
    data: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


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
    school_id: Mapped[str] = mapped_column(String(32), primary_key=True, default=DEFAULT_SCHOOL)  # each school keeps its own list
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    version: Mapped[int] = mapped_column(Integer, primary_key=True)
    data: Mapped[dict[str, Any]] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_by: Mapped[str | None] = mapped_column(String(64), nullable=True)


class MachineRow(Base):
    __tablename__ = "machines"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # a laser's ID is unique across all schools (it is also its station ID)
    school_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    data: Mapped[dict[str, Any]] = mapped_column(JSON)
    #: Camera picture -> bed mapping for this laser (services_presets.put_calibration). None until a teacher calibrates it.
    camera_calibration: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
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


class SchoolClass(Base):
    """A class that pupils log in through. The label is a note for teachers (never a pupil name)."""

    __tablename__ = "classes"
    code: Mapped[str] = mapped_column(String(32), primary_key=True)
    label: Mapped[str | None] = mapped_column(String(128), nullable=True)
    school_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    #: The teacher who set the class up and looks after it. None: a shared class that every teacher may manage.
    teacher_id: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    #: Must a teacher approve this class's files before they can be cut? NULL (a class made before this existed) counts as yes.
    require_approval: Mapped[bool | None] = mapped_column(Boolean, nullable=True, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Pupil(Base):
    """A pupil who can log in with class code + pupil ID + PIN. Pupil ID only: there is no column for a name."""

    __tablename__ = "pupils"
    pupil_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    class_code: Mapped[str] = mapped_column(String(32), ForeignKey("classes.code", ondelete="CASCADE"), index=True)
    pin_hash: Mapped[str] = mapped_column(String(200))
    failed_attempts: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_login: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Activity(Base):
    """Something a class works through: instructions, an optional suggested material, an optional due date."""

    __tablename__ = "activities"
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    class_code: Mapped[str] = mapped_column(String(32), ForeignKey("classes.code", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(200))
    instructions: Mapped[str] = mapped_column(Text, default="")
    position: Mapped[int] = mapped_column(Integer, default=0)
    preset_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    published: Mapped[bool] = mapped_column(Boolean, default=False)  # pupils only see published activities
    archived: Mapped[bool] = mapped_column(Boolean, default=False)  # hidden from everyone, work and feedback are kept
    created_by: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ActivityWork(Base):
    """One pupil's progress on one activity: todo (no row), working, submitted, revise, complete."""

    __tablename__ = "activity_work"
    pupil_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    activity_id: Mapped[str] = mapped_column(String(32), ForeignKey("activities.id", ondelete="CASCADE"), primary_key=True)
    status: Mapped[str] = mapped_column(String(12), default="working")
    job_id: Mapped[str | None] = mapped_column(String(32), nullable=True)  # the file the pupil handed in
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class Feedback(Base):
    """A teacher's comment on a pupil's work for an activity. Author is a teacher ID, never a name."""

    __tablename__ = "feedback"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    pupil_id: Mapped[str] = mapped_column(String(64), index=True)
    activity_id: Mapped[str] = mapped_column(String(32), ForeignKey("activities.id", ondelete="CASCADE"), index=True)
    teacher_id: Mapped[str] = mapped_column(String(64))
    text: Mapped[str] = mapped_column(Text)
    outcome: Mapped[str] = mapped_column(String(12), default="comment")  # comment | revise | complete
    job_id: Mapped[str | None] = mapped_column(String(32), nullable=True)  # the file it was about
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Person(Base):
    """What a signed-in person is called, for staff to read ("Sam Jones" instead of a DINO ID). Fetched from DINO's userinfo when they sign in
    (`POST /auth/profile`), shown only to staff of the same school, never logged, and deleted when the pupil is removed. Never an email."""

    __tablename__ = "people"
    person_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    school_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    display_name: Mapped[str] = mapped_column(String(128))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
