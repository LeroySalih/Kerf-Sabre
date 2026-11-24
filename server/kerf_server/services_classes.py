"""Classes, pupil PINs and class login. A pupil is a pupil ID and a PIN: no names anywhere."""
from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import time
from collections import defaultdict, deque
from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .config import Settings
from .db import as_utc, utcnow
from .errors import ApiError
from .models import DEFAULT_SCHOOL, AuditEvent, GroupMember, Pupil, SchoolClass, Token
from . import services_people as people
from .security import hash_token, new_token

CODE_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_SCRYPT = dict(n=2**14, r=8, p=1, dklen=32)
_DUMMY = None  # hash checked for unknown pupils so a wrong ID costs the same time as a wrong PIN


def new_pin() -> str:
    """A new pupil's password: two words (`services_passwords`). The name is kept from when pupils had 5-digit PINs."""
    from .services_passwords import new_password

    return new_password()


def new_pupil_id(s: Session) -> str:
    """A pupil ID Kerf makes up: 5 digits (6 when 5 run short), not used anywhere on this server (pupil IDs are server-wide)."""
    for digits in (5, 5, 5, 5, 6, 6, 6, 6, 7, 7):
        pid = str(secrets.randbelow(9 * 10 ** (digits - 1)) + 10 ** (digits - 1))
        if s.get(Pupil, pid) is None:
            return pid
    raise ApiError(500, "error", "Could not make a pupil ID. Try again.")


def hash_pin(pin: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    return f"scrypt${salt.hex()}${hashlib.scrypt(pin.encode(), salt=salt, **_SCRYPT).hex()}"


def check_pin(pin: str, stored: str) -> bool:
    try:
        _, salt, digest = stored.split("$")
        return hmac.compare_digest(hashlib.scrypt(pin.encode(), salt=bytes.fromhex(salt), **_SCRYPT).hex(), digest)
    except ValueError:
        return False


def norm_code(code: str) -> str:
    return code.strip().upper()


class IpThrottle:
    """Failed logins per address in a sliding window. In memory: a restart forgives everyone, which is fine for a school LAN."""

    def __init__(self) -> None:
        self.fails: dict[str, deque[float]] = defaultdict(deque)

    def blocked(self, ip: str, cfg: Settings) -> bool:
        q = self.fails[ip]
        now = time.monotonic()
        while q and now - q[0] > cfg.login_ip_window_s:
            q.popleft()
        return len(q) >= cfg.login_ip_failures

    def fail(self, ip: str) -> None:
        self.fails[ip].append(time.monotonic())


# ---------------------------------------------------------------- membership

def ensure_members(s: Session) -> None:
    """Pupils made before groups could hold a pupil more than once get a membership of their home group (start-up)."""
    have = set(s.execute(select(GroupMember.class_code, GroupMember.pupil_id)).all())
    for pid, code in s.execute(select(Pupil.pupil_id, Pupil.class_code)).all():
        if (code, pid) not in have:
            s.add(GroupMember(class_code=code, pupil_id=pid))
    s.flush()


def groups_of(s: Session, pupil_id: str, active_only: bool = True) -> list[str]:
    """The codes of the groups this pupil is in (archived groups left out unless asked for)."""
    q = select(GroupMember.class_code).join(SchoolClass, SchoolClass.code == GroupMember.class_code).where(GroupMember.pupil_id == pupil_id)
    if active_only:
        q = q.where(SchoolClass.archived.is_not(True))
    return list(s.scalars(q.order_by(GroupMember.class_code)))


def in_group(s: Session, code: str, pupil_id: str) -> bool:
    return s.get(GroupMember, (norm_code(code), pupil_id)) is not None


def member_ids(s: Session, code: str) -> list[str]:
    return list(s.scalars(select(GroupMember.pupil_id).where(GroupMember.class_code == norm_code(code)).order_by(GroupMember.pupil_id)))


def member_counts(s: Session) -> dict[str, int]:
    return dict(s.execute(select(GroupMember.class_code, func.count()).group_by(GroupMember.class_code)).all())


def laser_groups_of(s: Session, pupil_id: str) -> list[str]:
    """The pupil's groups that are laser groups (only asked while the school's terms limit laser groups)."""
    return [c for c in groups_of(s, pupil_id) if s.get(SchoolClass, c).laser]  # type: ignore[union-attr]


def set_laser(s: Session, c: SchoolClass, on: bool) -> None:
    """A school admin picks the groups that may send to the laser, up to the terms' `laserGroups`."""
    from . import services_terms as terms

    if on and not c.laser:
        terms.require(s, c.school_id, "laser")
        n = s.scalar(select(func.count()).select_from(SchoolClass).where(SchoolClass.school_id == c.school_id, SchoolClass.laser.is_(True), SchoolClass.archived.is_not(True))) or 0
        terms.check_limit(s, c.school_id, "laserGroups", n)
    c.laser = on


def groups_by_pupil(s: Session, school: str | None, pupil_ids) -> dict[str, list[dict]]:
    """For staff lists: each pupil's (not archived) groups in this school as `[{code, label}]`, in one query."""
    ids = list({p for p in pupil_ids if p})
    if not ids:
        return {}
    out: dict[str, list[dict]] = {}
    q = (select(GroupMember.pupil_id, SchoolClass.code, SchoolClass.label).join(SchoolClass, SchoolClass.code == GroupMember.class_code)
         .where(GroupMember.pupil_id.in_(ids), SchoolClass.school_id == school, SchoolClass.archived.is_not(True)).order_by(SchoolClass.code))
    for pid, code, label in s.execute(q):
        out.setdefault(pid, []).append({"code": code, "label": label})
    return out


def pupil_school(s: Session, row: Pupil) -> str | None:
    c = s.get(SchoolClass, row.class_code)
    return c.school_id if c else None


# ---------------------------------------------------------------- teacher side

def needs_approval(s: Session, pupil_id: str) -> bool:
    """Do this pupil's files wait for a teacher? Yes unless every group they are in lets them go straight to the queue.
    A pupil with no group (a token made by an administrator) always needs approval."""
    codes = groups_of(s, pupil_id)
    if not codes:
        return True
    return any(s.get(SchoolClass, c).require_approval is not False for c in codes)  # type: ignore[union-attr]


DINO_ONLY = "This group comes from DINO: its pupils and name follow the DINO class. Use Sync with DINO (archiving it is still up to you)."


def not_from_dino(c: SchoolClass) -> None:
    """Refuse a change Kerf does not own for a group imported from DINO (pupils, names, passwords, note, join code); only
    Sync with DINO changes its pupils. Archiving and the Kerf settings (approval, laser group) are still allowed."""
    if c.source == "dino":
        raise ApiError(409, "dino_group", DINO_ONLY)


def join_code_of(c: SchoolClass) -> str | None:
    """The code pupils type to sign in with a Pupil Card or ask to join. None for a group imported from DINO: its pupils come
    from DINO (Sync with DINO) and sign in with DINO, so nobody joins it by code."""
    if c.source == "dino":
        return None
    return c.join_code or c.code


def class_info(s: Session, c: SchoolClass, pupil_count: int, join_requests: int | None = None) -> dict:
    """`join_requests`: pupils waiting to join (counted here when not given)."""
    if join_requests is None:
        from .services_joinrequests import pending_count

        join_requests = pending_count(s, c)
    return {"code": c.code, "joinCode": join_code_of(c), "label": c.label, "teacherId": c.teacher_id,
            "teacherName": people.staff_name(s, c.school_id, c.teacher_id), "pupilCount": pupil_count,
            "requireApproval": c.require_approval is not False, "archived": bool(c.archived), "source": c.source or "manual", "laser": bool(c.laser),
            "joinRequests": join_requests}


def _check_join_code(s: Session, school: str | None, join_code: str, except_code: str | None = None) -> str:
    if not CODE_RE.match(join_code or ""):
        raise ApiError(422, "invalid", "A group code is letters, digits, - and _ (up to 32).")
    jc = norm_code(join_code)
    for other in s.scalars(select(SchoolClass).where(SchoolClass.school_id == school)):
        if other.code != except_code and join_code_of(other) == jc:
            raise ApiError(409, "conflict", f"Another group in your school already uses the code {jc}.")
    return jc


def new_group_code(s: Session, school: str | None) -> str:
    """A group code Kerf makes up: 5 characters that cannot be misread, free as a class code and as a join code in the school."""
    from .services_schools import CODE_ALPHABET

    for _ in range(200):
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(5))
        if s.get(SchoolClass, code) is None and s.scalar(select(SchoolClass).where(SchoolClass.school_id == school, SchoolClass.join_code == code)) is None:
            return code
    raise ApiError(500, "error", "Could not make a group code. Try again.")


def active_group_count(s: Session, school: str | None) -> int:
    return s.scalar(select(func.count()).select_from(SchoolClass).where(SchoolClass.school_id == school, SchoolClass.archived.is_not(True))) or 0


def update_class(s: Session, code: str, teacher_id: str | None, label: str | None, require_approval: bool | None, school: str | None = None,
                 join_code: str | None = None, archived: bool | None = None) -> SchoolClass:
    c = get_class(s, code, teacher_id, school)
    if join_code is not None or label is not None:
        not_from_dino(c)
    if label is not None:
        c.label = label.strip()[:128] or None
    if require_approval is not None:
        c.require_approval = require_approval
    if join_code is not None:
        jc = _check_join_code(s, c.school_id, join_code, except_code=c.code)
        c.join_code = None if jc == c.code else jc
    if archived is not None and bool(archived) != bool(c.archived):
        if not archived:
            from .services_schools import check_limit

            check_limit(s, c.school_id, "groupsPerSchool", active_group_count(s, c.school_id))
        c.archived = archived
        if archived:  # nobody signs in through an archived group; pupils with no other group are signed out
            for pid in member_ids(s, c.code):
                if not groups_of(s, pid):
                    revoke_sessions(s, pid)
    return c


def create_class(s: Session, code: str | None, label: str | None, teacher_id: str | None = None, require_approval: bool = True, school: str = DEFAULT_SCHOOL,
                 join_code: str | None = None, source: str | None = None, source_id: str | None = None) -> SchoolClass:
    """A new group. No code: Kerf makes one. A join code of its own is optional (else the group's code is used)."""
    from .services_schools import check_limit

    check_limit(s, school, "groupsPerSchool", active_group_count(s, school))
    if code is None or not str(code).strip():
        code = new_group_code(s, school)
    if not CODE_RE.match(code or ""):
        raise ApiError(422, "invalid", "A class code is letters, digits, - and _ (up to 32).")
    code = norm_code(code)
    if s.get(SchoolClass, code) is not None:
        raise ApiError(409, "conflict", f"The class {code} already exists.")
    jc = _check_join_code(s, school, join_code or code)
    c = SchoolClass(code=code, label=(label or "").strip()[:128] or None, teacher_id=teacher_id, require_approval=require_approval, school_id=school,
                    join_code=None if jc == code else jc, archived=False, source=source, source_id=source_id)
    s.add(c)
    s.flush()
    return c


def get_class(s: Session, code: str, teacher_id: str | None = None, school: str | None = None) -> SchoolClass:
    """The class. With a school, only that school's classes are visible; with a teacher ID, only that teacher's own (and
    shared) ones. Anything else looks like it doesn't exist. An admin passes no teacher ID: they see their whole school."""
    c = s.get(SchoolClass, norm_code(code))
    if c is None or (school is not None and c.school_id != school) or (teacher_id is not None and c.teacher_id is not None and c.teacher_id != teacher_id):
        raise ApiError(404, "not_found", f"There is no class {norm_code(code)}.")
    return c


def add_pupils(s: Session, code: str, pupil_ids: list[str] | None = None, teacher_id: str | None = None, school: str | None = None,
               entries: list[dict] | None = None, generate: int = 0, from_dino: bool = False) -> dict[str, list]:
    """Add pupils to a group. `pupil_ids`: IDs as before; `entries`: `[{id?, name?}]` (no id: Kerf makes one; a name is the
    teacher's display name, printed on Pupil Cards and shown to staff only); `generate`: that many new pupils with IDs Kerf makes.
    New pupils get a two-word password (returned here as `password` and, for older clients, `pin`: the only time it is ever
    visible). A pupil already in another group of the same school is added to this one too (`added`, password unchanged)."""
    from .services_schools import check_limit

    cls = get_class(s, code, teacher_id, school)
    if not from_dino:
        not_from_dino(cls)
    wanted: list[tuple[str | None, str | None]] = [(str(raw).strip(), None) for raw in (pupil_ids or [])]
    for e in entries or []:
        if not isinstance(e, dict):
            raise ApiError(422, "invalid", "Each pupil is {id?, name?}.")
        raw_id = str(e.get("id") or "").strip() or None
        wanted.append((raw_id, people.clean_name(e.get("name"))))
    if not isinstance(generate, int) or generate < 0 or generate > 500:
        raise ApiError(422, "invalid", "generate is a number from 0 to 500.")
    wanted += [(None, None)] * generate
    if not wanted:
        raise ApiError(422, "invalid", "Give at least one pupil.")
    seen: set[str] = set()
    plan: list[tuple[str, str | None, str | None]] = []  # (kind, pupil ID or None for "make one", name)
    out: dict[str, list] = {"created": [], "added": [], "restored": [], "existing": [], "conflicts": []}
    for pid, name in wanted:
        if pid is not None:
            if not ID_RE.match(pid):
                raise ApiError(422, "invalid", f"'{pid[:30]}' is not a valid pupil ID (letters, digits, - and _). IDs, never names.")
            if pid in seen:
                continue
            seen.add(pid)
            row = s.get(Pupil, pid)
            if row is None:
                plan.append(("created", pid, name))
            elif in_group(s, cls.code, pid):
                out["existing"].append(pid)
            elif pupil_school(s, row) == cls.school_id:
                plan.append(("restored" if row.archived_at else "added", pid, name))
            else:
                out["conflicts"].append(pid)
        else:
            plan.append(("created", None, name))
    check_limit(s, cls.school_id, "pupilsPerGroup", len(member_ids(s, cls.code)), len(plan))
    for kind, pid, name in plan:
        if kind == "created":
            pid = pid or new_pupil_id(s)
            password = new_pin()
            s.add(Pupil(pupil_id=pid, class_code=cls.code, pin_hash=hash_pin(password)))
            s.flush()
            if name:
                people.remember(s, pid, cls.school_id, name)
            out["created"].append({"pupilId": pid, "password": password, "pin": password, **({"displayName": name} if name else {})})
        else:
            assert pid is not None
            out[kind].append(pid)
            if kind == "restored":  # an archived pupil comes back with their files and password
                row = s.get(Pupil, pid)
                row.archived_at, row.class_code = None, cls.code  # type: ignore[union-attr]
            if name:
                people.remember(s, pid, cls.school_id, name)
        s.add(GroupMember(class_code=cls.code, pupil_id=pid))
    s.flush()
    return out


def new_group_passwords(s: Session, code: str, teacher_id: str | None = None, school: str | None = None, pupil_ids: list[str] | None = None) -> list[dict]:
    """New passwords for a group's pupils (all, or those listed), for printing Pupil Cards. Their old passwords stop working and
    they are signed out. Returned once, never again."""
    cls = get_class(s, code, teacher_id, school)
    not_from_dino(cls)
    ids = member_ids(s, cls.code)
    if pupil_ids is not None:
        want = {str(p) for p in pupil_ids}
        ids = [p for p in ids if p in want]
    named = people.names(s, cls.school_id, ids)
    out = []
    for pid in ids:
        row = s.get(Pupil, pid)
        if row is None:
            continue
        password = new_pin()
        row.pin_hash, row.failed_attempts, row.locked_until = hash_pin(password), 0, None
        revoke_sessions(s, pid)
        out.append({"pupilId": pid, "password": password, **({"displayName": named[pid]} if pid in named else {})})
    return out


def set_display_name(s: Session, code: str, pupil_id: str, name: object, teacher_id: str | None = None, school: str | None = None) -> str | None:
    """A teacher types (or clears) a pupil's display name: shown to staff and printed on the pupil's card, never logged."""
    cls = get_class(s, code, teacher_id, school)
    not_from_dino(cls)
    if not in_group(s, cls.code, pupil_id):
        raise ApiError(404, "not_found", "That pupil is not in this class.")
    clean = people.clean_name(name)
    if clean is None:
        people.forget(s, pupil_id)
        return None
    return people.remember(s, pupil_id, cls.school_id, clean)


def _may_manage(s: Session, pupil: Pupil, teacher_id: str | None, school: str | None) -> bool:
    """Is this pupil in a group of `school` that this teacher looks after (theirs or shared)? No teacher ID: any group of the school."""
    for code in groups_of(s, pupil.pupil_id, active_only=False):
        c = s.get(SchoolClass, code)
        if c is not None and (school is None or c.school_id == school) and (teacher_id is None or c.teacher_id is None or c.teacher_id == teacher_id):
            return True
    return False


def revoke_sessions(s: Session, pupil_id: str) -> None:
    for t in s.scalars(select(Token).where(Token.subject_id == pupil_id, Token.role == "pupil", Token.expires_at.is_not(None), Token.revoked.is_(False))):
        t.revoked = True


def reset_pin(s: Session, pupil_id: str, teacher_id: str | None = None, school: str | None = None) -> str:
    row = s.get(Pupil, pupil_id)
    if row is None or ((teacher_id is not None or school is not None) and not _may_manage(s, row, teacher_id, school)):
        raise ApiError(404, "not_found", f"There is no pupil {pupil_id} in any class.")
    pin = new_pin()
    row.pin_hash, row.failed_attempts, row.locked_until = hash_pin(pin), 0, None
    revoke_sessions(s, pupil_id)
    return pin


def remove_pupil(s: Session, code: str, pupil_id: str, teacher_id: str | None = None, school: str | None = None, from_dino: bool = False) -> None:
    """Takes the pupil out of this group. Out of their last group they are **archived** (soft-deleted): signed out, cannot
    sign in, files, work and name kept. Only `delete_pupil_forever` (a school admin, logged) removes them for good."""
    cls = get_class(s, code, teacher_id, school)
    if not from_dino:
        not_from_dino(cls)
    m = s.get(GroupMember, (cls.code, pupil_id))
    row = s.get(Pupil, pupil_id)
    if m is None or row is None:
        raise ApiError(404, "not_found", "That pupil is not in this class.")
    s.delete(m)
    s.flush()
    rest = groups_of(s, pupil_id, active_only=False)
    if rest:
        if row.class_code == cls.code:
            row.class_code = rest[0]
        return
    row.archived_at = utcnow()  # class_code stays: it still fixes the pupil's school
    revoke_sessions(s, pupil_id)


def is_archived(s: Session, pupil_id: str) -> bool:
    row = s.get(Pupil, pupil_id)
    return row is not None and row.archived_at is not None


def archived_pupils(s: Session, school: str | None) -> list[dict]:
    rows = [p for p in s.scalars(select(Pupil).where(Pupil.archived_at.is_not(None)).order_by(Pupil.pupil_id)) if pupil_school(s, p) == school]
    named = people.names(s, school, (p.pupil_id for p in rows))
    return [{"pupilId": p.pupil_id, "archivedAt": as_utc(p.archived_at).isoformat().replace("+00:00", "Z"), "lastGroup": p.class_code,  # type: ignore[arg-type]
             **({"displayName": named[p.pupil_id]} if p.pupil_id in named else {})} for p in rows]


def delete_pupil_forever(s: Session, who, pupil_id: str) -> dict:
    """A school admin deletes an archived pupil for good: the account, their files (with G-code and history), activity work,
    feedback, open tabs, display name and sign-in links. Logged (`AuditEvent`, logger `kerf.audit`), IDs only."""
    import logging

    from sqlalchemy import delete as sql_delete

    from .models import ActivityWork, Feedback, GcodeRow, Identity, Job, JobEvent, JoinRequest, Workspace

    row = s.get(Pupil, pupil_id)
    if row is None or pupil_school(s, row) != who.school:
        raise ApiError(404, "not_found", f"There is no pupil {pupil_id}.")
    if row.archived_at is None:
        raise ApiError(409, "not_archived", "Archive the pupil first (remove them from all their groups); then they can be deleted for good.")
    jobs = list(s.scalars(select(Job.id).where(Job.pupil_id == pupil_id, Job.school_id == who.school)))
    if s.scalar(select(func.count()).select_from(Job).where(Job.id.in_(jobs), Job.status.in_(("assigned", "running")))):
        raise ApiError(409, "in_use", "One of this pupil's files is on a laser right now. Try again when it has finished.")
    if jobs:
        s.execute(sql_delete(GcodeRow).where(GcodeRow.job_id.in_(jobs)))
        s.execute(sql_delete(JobEvent).where(JobEvent.job_id.in_(jobs)))
        s.execute(sql_delete(Job).where(Job.id.in_(jobs)))
    s.execute(sql_delete(Feedback).where(Feedback.pupil_id == pupil_id))
    s.execute(sql_delete(ActivityWork).where(ActivityWork.pupil_id == pupil_id))
    s.execute(sql_delete(Workspace).where(Workspace.user_id == pupil_id, Workspace.school_id == who.school))
    s.execute(sql_delete(Identity).where(Identity.person_id == pupil_id, Identity.school_id == who.school))
    s.execute(sql_delete(GroupMember).where(GroupMember.pupil_id == pupil_id))
    s.execute(sql_delete(JoinRequest).where(JoinRequest.pupil_id == pupil_id, JoinRequest.school_id == who.school))
    revoke_sessions(s, pupil_id)
    people.forget(s, pupil_id)
    s.delete(row)
    s.add(AuditEvent(school_id=who.school, actor_id=who.id, action="pupil_deleted", subject_id=pupil_id, detail={"files": len(jobs)}))
    logging.getLogger("kerf.audit").info("pupil_deleted school=%s by=%s pupil=%s files=%d", who.school, who.id, pupil_id, len(jobs))
    return {"pupilId": pupil_id, "filesDeleted": len(jobs)}


def class_pupils(s: Session, code: str, teacher_id: str | None = None, school: str | None = None) -> list[dict]:
    cls = get_class(s, code, teacher_id, school)
    now = utcnow()
    rows = list(s.scalars(select(Pupil).join(GroupMember, GroupMember.pupil_id == Pupil.pupil_id).where(GroupMember.class_code == cls.code).order_by(Pupil.pupil_id)))
    named = people.names(s, cls.school_id, (p.pupil_id for p in rows))
    return [{"pupilId": p.pupil_id, "lastLogin": p.last_login and as_utc(p.last_login).isoformat().replace("+00:00", "Z"),
             "locked": bool(p.locked_until and as_utc(p.locked_until) > now), "groups": groups_of(s, p.pupil_id),
             **({"displayName": named[p.pupil_id]} if p.pupil_id in named else {})} for p in rows]


# ---------------------------------------------------------------- login

BAD = ApiError(401, "bad_login", "That class code, pupil ID or PIN is not right.")


def _password_login(s: Session, cfg: Settings, throttle: IpThrottle, ip: str, row: Pupil | None, code: str, password: str, method: str | None) -> dict:
    """The shared end of both pupil logins. Wrong anything gives the same 401; repeated wrong passwords lock the pupil for a while."""
    global _DUMMY
    from .services_passwords import normalise

    typed = normalise(password)
    if row is None:
        _DUMMY = _DUMMY or hash_pin("tiger-river")
        check_pin(typed, _DUMMY)  # same work as a real check
        throttle.fail(ip)
        raise ApiError(401, "bad_login", BAD.message)
    now = utcnow()
    if row.locked_until and as_utc(row.locked_until) > now:
        mins = max(1, int((as_utc(row.locked_until) - now).total_seconds() // 60) + 1)
        raise ApiError(429, "locked", f"Too many wrong passwords. This pupil ID is locked for about {mins} more minute{'s' if mins != 1 else ''}. Ask your teacher if you have lost your card.")
    if not check_pin(typed, row.pin_hash) and (str(password) == typed or not check_pin(str(password), row.pin_hash)):
        throttle.fail(ip)
        row.failed_attempts += 1
        if row.failed_attempts >= cfg.login_max_failures:
            row.failed_attempts, row.locked_until = 0, now + timedelta(minutes=cfg.login_lockout_minutes)
        s.commit()  # keep the count even though we are about to raise
        raise ApiError(401, "bad_login", BAD.message)
    row.failed_attempts, row.locked_until, row.last_login = 0, None, now
    token = new_token("pupil")
    expires = now + timedelta(hours=cfg.session_hours)
    cls = s.get(SchoolClass, code)
    s.add(Token(token_hash=hash_token(token), role="pupil", subject_id=row.pupil_id, label=f"login {code}", expires_at=expires,
                school_id=(cls.school_id if cls else None) or DEFAULT_SCHOOL, method=method))
    return {"token": token, "role": "pupil", "id": row.pupil_id, "classCode": code, "expiresAt": expires.isoformat().replace("+00:00", "Z")}


def login(s: Session, cfg: Settings, throttle: IpThrottle, ip: str, class_code: str, pupil_id: str, pin: str) -> dict:
    """The old class login (class code + pupil ID + PIN or password; development servers only)."""
    if throttle.blocked(ip, cfg):
        raise ApiError(429, "too_many_attempts", "Too many wrong tries from this computer. Wait a few minutes.")
    code, pid = norm_code(class_code or ""), (pupil_id or "").strip()
    row = s.get(Pupil, pid) if ID_RE.match(pid) and code in groups_of(s, pid) else None  # any group the pupil is in that is not archived
    return _password_login(s, cfg, throttle, ip, row, code, pin, None)


GROUP_BAD = "That school code, group code, pupil ID or password is not right. Check your Pupil Card."


def group_login(s: Session, cfg: Settings, throttle: IpThrottle, ip: str, school_code: str, group_code: str, pupil_id: str, password: str) -> dict:
    """Pupil Card sign-in: school code + group (join) code + pupil ID + two-word password -> a session token for this school
    (`Token.method = "group"`, accepted alongside DINO). The school must have its Group code sign-in on."""
    from .models import School
    from .services_signin import allowed

    if throttle.blocked(ip, cfg):
        raise ApiError(429, "too_many_attempts", "Too many wrong tries from this computer. Wait a few minutes.")
    sc = (school_code or "").strip().upper()
    school = s.scalar(select(School).where(School.code == sc)) if sc else None
    if school is not None and not allowed(s, school.id, "groupCode"):
        raise ApiError(403, "sign_in_off", "Your school does not use Pupil Cards to sign in. Use your school's sign-in instead.")
    jc, pid = norm_code(group_code or ""), (pupil_id or "").strip()
    row = None
    code = ""
    if school is not None and jc and ID_RE.match(pid):
        cls = next((c for c in s.scalars(select(SchoolClass).where(SchoolClass.school_id == school.id, SchoolClass.archived.is_not(True)))
                    if join_code_of(c) == jc), None)
        if cls is not None and in_group(s, cls.code, pid):
            row, code = s.get(Pupil, pid), cls.code
            if row is not None and row.archived_at is not None:
                row = None
    try:
        return _password_login(s, cfg, throttle, ip, row, code, password, "group")
    except ApiError as e:
        if e.code == "bad_login":
            raise ApiError(401, "bad_login", GROUP_BAD) from None
        raise
