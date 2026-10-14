"""Classes, pupil PINs and class login. A pupil is a pupil ID and a PIN: no names anywhere."""
from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import time
from collections import defaultdict, deque
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import Settings
from .db import as_utc, utcnow
from .errors import ApiError
from .models import Pupil, SchoolClass, Token
from .security import hash_token, new_token

PIN_DIGITS = 5
CODE_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_SCRYPT = dict(n=2**14, r=8, p=1, dklen=32)
_DUMMY = None  # hash checked for unknown pupils so a wrong ID costs the same time as a wrong PIN


def new_pin() -> str:
    return "".join(str(secrets.randbelow(10)) for _ in range(PIN_DIGITS))


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


# ---------------------------------------------------------------- teacher side

def needs_approval(s: Session, pupil_id: str) -> bool:
    """Do this pupil's files wait for a teacher? Yes unless their class is set to let them go straight to the queue.
    A pupil with no class (a token made by an administrator) always needs approval."""
    row = s.get(Pupil, pupil_id)
    c = s.get(SchoolClass, row.class_code) if row is not None else None
    return c is None or c.require_approval is not False


def class_info(s: Session, c: SchoolClass, pupil_count: int) -> dict:
    return {"code": c.code, "label": c.label, "teacherId": c.teacher_id, "pupilCount": pupil_count, "requireApproval": c.require_approval is not False}


def update_class(s: Session, code: str, teacher_id: str | None, label: str | None, require_approval: bool | None) -> SchoolClass:
    c = get_class(s, code, teacher_id)
    if label is not None:
        c.label = label.strip()[:128] or None
    if require_approval is not None:
        c.require_approval = require_approval
    return c


def create_class(s: Session, code: str, label: str | None, teacher_id: str | None = None, require_approval: bool = True) -> SchoolClass:
    if not CODE_RE.match(code or ""):
        raise ApiError(422, "invalid", "A class code is letters, digits, - and _ (up to 32).")
    code = norm_code(code)
    if s.get(SchoolClass, code) is not None:
        raise ApiError(409, "conflict", f"The class {code} already exists.")
    c = SchoolClass(code=code, label=(label or "").strip()[:128] or None, teacher_id=teacher_id, require_approval=require_approval)
    s.add(c)
    return c


def get_class(s: Session, code: str, teacher_id: str | None = None) -> SchoolClass:
    """The class. With a teacher ID, only that teacher's own classes (and shared ones) are visible: others look like they don't exist."""
    c = s.get(SchoolClass, norm_code(code))
    if c is None or (teacher_id is not None and c.teacher_id is not None and c.teacher_id != teacher_id):
        raise ApiError(404, "not_found", f"There is no class {norm_code(code)}.")
    return c


def add_pupils(s: Session, code: str, pupil_ids: list[str], teacher_id: str | None = None) -> dict[str, list]:
    """New IDs get a PIN (returned here, the only time it is ever visible). Existing members are left alone."""
    cls = get_class(s, code, teacher_id)
    out: dict[str, list] = {"created": [], "existing": [], "conflicts": []}
    for raw in pupil_ids:
        pid = str(raw).strip()
        if not ID_RE.match(pid):
            raise ApiError(422, "invalid", f"'{pid[:30]}' is not a valid pupil ID (letters, digits, - and _). IDs, never names.")
        row = s.get(Pupil, pid)
        if row is None:
            pin = new_pin()
            s.add(Pupil(pupil_id=pid, class_code=cls.code, pin_hash=hash_pin(pin)))
            out["created"].append({"pupilId": pid, "pin": pin})
        elif row.class_code == cls.code:
            out["existing"].append(pid)
        else:
            out["conflicts"].append(pid)
    return out


def _may_manage(s: Session, pupil: Pupil, teacher_id: str) -> bool:
    c = s.get(SchoolClass, pupil.class_code)
    return c is not None and (c.teacher_id is None or c.teacher_id == teacher_id)


def revoke_sessions(s: Session, pupil_id: str) -> None:
    for t in s.scalars(select(Token).where(Token.subject_id == pupil_id, Token.role == "pupil", Token.expires_at.is_not(None), Token.revoked.is_(False))):
        t.revoked = True


def reset_pin(s: Session, pupil_id: str, teacher_id: str | None = None) -> str:
    row = s.get(Pupil, pupil_id)
    if row is None or (teacher_id is not None and not _may_manage(s, row, teacher_id)):
        raise ApiError(404, "not_found", f"There is no pupil {pupil_id} in any class.")
    pin = new_pin()
    row.pin_hash, row.failed_attempts, row.locked_until = hash_pin(pin), 0, None
    revoke_sessions(s, pupil_id)
    return pin


def remove_pupil(s: Session, code: str, pupil_id: str, teacher_id: str | None = None) -> None:
    row = s.get(Pupil, pupil_id)
    if row is None or row.class_code != norm_code(code) or (teacher_id is not None and not _may_manage(s, row, teacher_id)):
        raise ApiError(404, "not_found", "That pupil is not in this class.")
    revoke_sessions(s, pupil_id)
    s.delete(row)


def class_pupils(s: Session, code: str, teacher_id: str | None = None) -> list[dict]:
    cls = get_class(s, code, teacher_id)
    now = utcnow()
    rows = s.scalars(select(Pupil).where(Pupil.class_code == cls.code).order_by(Pupil.pupil_id))
    return [{"pupilId": p.pupil_id, "lastLogin": p.last_login and as_utc(p.last_login).isoformat().replace("+00:00", "Z"),
             "locked": bool(p.locked_until and as_utc(p.locked_until) > now)} for p in rows]


# ---------------------------------------------------------------- login

BAD = ApiError(401, "bad_login", "That class code, pupil ID or PIN is not right.")


def login(s: Session, cfg: Settings, throttle: IpThrottle, ip: str, class_code: str, pupil_id: str, pin: str) -> dict:
    """Returns the login result. Wrong anything gives the same 401; repeated wrong PINs lock the pupil for a while."""
    global _DUMMY
    if throttle.blocked(ip, cfg):
        raise ApiError(429, "too_many_attempts", "Too many wrong tries from this computer. Wait a few minutes.")
    code, pid = norm_code(class_code or ""), (pupil_id or "").strip()
    row = s.scalar(select(Pupil).where(Pupil.pupil_id == pid, Pupil.class_code == code)) if ID_RE.match(pid) else None
    if row is None:
        _DUMMY = _DUMMY or hash_pin("00000")
        check_pin(str(pin), _DUMMY)  # same work as a real check
        throttle.fail(ip)
        raise ApiError(401, "bad_login", BAD.message)
    now = utcnow()
    if row.locked_until and as_utc(row.locked_until) > now:
        mins = max(1, int((as_utc(row.locked_until) - now).total_seconds() // 60) + 1)
        raise ApiError(429, "locked", f"Too many wrong PINs. This ID is locked for about {mins} more minute{'s' if mins != 1 else ''}. Ask your teacher for a new PIN.")
    if not check_pin(str(pin), row.pin_hash):
        throttle.fail(ip)
        row.failed_attempts += 1
        if row.failed_attempts >= cfg.login_max_failures:
            row.failed_attempts, row.locked_until = 0, now + timedelta(minutes=cfg.login_lockout_minutes)
        s.commit()  # keep the count even though we are about to raise
        raise ApiError(401, "bad_login", BAD.message)
    row.failed_attempts, row.locked_until, row.last_login = 0, None, now
    token = new_token("pupil")
    expires = now + timedelta(hours=cfg.session_hours)
    s.add(Token(token_hash=hash_token(token), role="pupil", subject_id=row.pupil_id, label=f"login {row.class_code}", expires_at=expires))
    return {"token": token, "role": "pupil", "id": row.pupil_id, "classCode": row.class_code, "expiresAt": expires.isoformat().replace("+00:00", "Z")}
