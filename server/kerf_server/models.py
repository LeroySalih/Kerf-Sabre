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
    #: Files that arrive while this is on are approved at once (whatever a class says). NULL (a school made before this existed) takes `Settings.auto_approve_default`.
    auto_approve: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    #: "free" (the free tools) or "paid" (also the queue, lasers, Station pages, camera, activities, approval). Set by the site admin.
    #: NULL: a school made before plans existed, which counts as paid.
    plan: Mapped[str | None] = mapped_column(String(8), nullable=True)
    #: The short code pupils type with their group code, pupil ID and password (unique across Kerf).
    code: Mapped[str | None] = mapped_column(String(16), nullable=True, unique=True, index=True)
    #: Which sign-in methods the school's admins have switched on, e.g. {"dino": true, "groupCode": true, "googleDomain": "..."}
    #: (`services_signin`). NULL: a school from before per-school sign-in, which used DINO only.
    sign_in: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    #: A free school's own terms (`services_terms`): a copy of Kerf's default terms made when it registered, edited only by
    #: the site admin. NULL for a paid school (everything) or a free school from before terms (given a copy at start-up).
    terms: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
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
    #: How a person's session was started: "email" (a sign-in link). Such tokens are accepted even when DINO is the main way in.
    method: Mapped[str | None] = mapped_column(String(16), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class StaffAccount(Base):
    """A member of staff who signs in with an emailed link (Kerf's own account), invited by a school admin. The email is
    used only to send them links: never logged, never shown to pupils."""

    __tablename__ = "staff_accounts"
    person_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    school_id: Mapped[str] = mapped_column(String(32), index=True)
    email: Mapped[str] = mapped_column(String(254), index=True)
    role: Mapped[str] = mapped_column(String(16))  # admin | teacher | technician
    name: Mapped[str | None] = mapped_column(String(128), nullable=True)
    invited_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    disabled: Mapped[bool] = mapped_column(Boolean, default=False)
    last_login: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class SignInLink(Base):
    """A one-time sign-in link sent by email. Only its SHA-256 is stored."""

    __tablename__ = "sign_in_links"
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    person_id: Mapped[str] = mapped_column(String(64), index=True)
    school_id: Mapped[str] = mapped_column(String(32))
    purpose: Mapped[str] = mapped_column(String(16))  # signin | invite
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class PendingRegistration(Base):
    """A free school asked for at /register, waiting for its emailed confirmation link (24 hours). Nothing else exists until the
    link is used, so a junk address creates no school. Only the link's SHA-256 is stored; the email is used only to send the link
    and becomes the first admin's address. Never logged."""

    __tablename__ = "pending_registrations"
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    school_name: Mapped[str] = mapped_column(String(128))
    name: Mapped[str] = mapped_column(String(128))
    email: Mapped[str] = mapped_column(String(254))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    #: The school made when the link was used.
    school_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
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
    #: Deleted from the catalogue: no longer offered or usable for new files. The rows stay so old files can still be reproduced.
    deleted: Mapped[bool | None] = mapped_column(Boolean, nullable=True, default=False)


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
    #: The code pupils type to join or sign in through this group. Unique within the school; NULL means the same as `code`.
    #: A teacher may change it later (`code` never changes: activities and files point at it).
    join_code: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    #: An archived group keeps its pupils, activities and files but is hidden, cannot be signed in through and does not count
    #: towards a free school's group limit.
    archived: Mapped[bool | None] = mapped_column(Boolean, nullable=True, default=False)
    #: Where the group came from: manual, csv, dino, google, microsoft (NULL = manual), and the provider's own group id.
    source: Mapped[str | None] = mapped_column(String(16), nullable=True)
    source_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    #: One of the school's laser groups, picked by a school admin while its terms limit how many groups may send to the laser.
    laser: Mapped[bool | None] = mapped_column(Boolean, nullable=True, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class AuditEvent(Base):
    """Actions that must be on record (e.g. a pupil deleted for good). IDs only, never names."""

    __tablename__ = "audit_events"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    school_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    actor_id: Mapped[str] = mapped_column(String(64))
    action: Mapped[str] = mapped_column(String(48))
    subject_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    detail: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)


class PlatformSetting(Base):
    """Kerf-wide settings the site admin changes (e.g. the default terms copied to every new school)."""

    __tablename__ = "platform_settings"
    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[dict[str, Any]] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class GroupMember(Base):
    """A pupil in a group. A pupil can be in several groups of their school; `Pupil.class_code` is the group they were
    first added to (their home group, which fixes their school)."""

    __tablename__ = "group_members"
    class_code: Mapped[str] = mapped_column(String(32), ForeignKey("classes.code", ondelete="CASCADE"), primary_key=True)
    pupil_id: Mapped[str] = mapped_column(String(64), ForeignKey("pupils.pupil_id", ondelete="CASCADE"), primary_key=True, index=True)
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class JoinRequest(Base):
    """A pupil asked to join a group (by its join code) and waits for a teacher (shared 0.2.45). IDs only."""

    __tablename__ = "join_requests"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    school_id: Mapped[str] = mapped_column(String(32), index=True)
    class_code: Mapped[str] = mapped_column(String(32), ForeignKey("classes.code", ondelete="CASCADE"), index=True)
    pupil_id: Mapped[str] = mapped_column(String(64), index=True)
    status: Mapped[str] = mapped_column(String(10), default="pending")  # pending | approved | declined
    decided_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
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
    #: Archived (soft-deleted): out of every group, cannot sign in, files and work kept. Adding them to a group brings them
    #: back; only a school admin's explicit permanent delete removes them.
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
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


class Identity(Base):
    """A way a person signs in, linked to their Kerf ID: (provider, subject) -> person. Providers: dino, google, microsoft,
    group-code, email. One person may have several (e.g. a group code at school, Google at home). IDs only: no names or emails here."""

    __tablename__ = "identities"
    provider: Mapped[str] = mapped_column(String(16), primary_key=True)
    subject: Mapped[str] = mapped_column(String(160), primary_key=True)
    person_id: Mapped[str] = mapped_column(String(64), index=True)
    school_id: Mapped[str] = mapped_column(String(32), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_seen: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
