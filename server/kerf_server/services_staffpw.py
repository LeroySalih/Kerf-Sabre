"""Staff passwords (docs/ACCOUNTS.md: "Staff sign in with email and password; email validates the address").

Staff sign in with their school email and a password they chose. Email is only used to check the address: an invite, a new
school's confirmation and "Forgot your password?" each send a one-time link (`services_staffmail`) that leads to *Choose a
password*. Passwords are hashed with scrypt (standard library) and a random 16-byte salt each, stored as
``scrypt$<n>$<r>$<p>$<salt hex>$<hash hex>`` so the parameters can be raised later (a sign-in re-hashes an older one).
A plain password is never logged, returned, stored or put in an error. Log lines carry the person ID only, never an email.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
import unicodedata
from datetime import timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import Settings
from .db import as_utc, iso, utcnow
from .errors import ApiError
from .models import School, SignInLink, StaffAccount, Token
from .security import hash_token, new_token

log = logging.getLogger("kerf.audit")

#: scrypt cost today: 32 MiB of memory and roughly a tenth of a second per check. Raise these to make new hashes stronger;
#: older hashes keep working and are re-hashed at the next sign-in.
N, R, P = 2**15, 8, 1
DKLEN = 32
MIN_LEN, MAX_LEN = 10, 128
MAX_FAILURES = 5          # wrong passwords in a row before the account is locked
LOCK_MINUTES = 15
#: The most common passwords of 10 or more characters (and a few about Kerf). Kept short on purpose: length does most of the work.
COMMON = frozenset({
    "password123", "password1234", "password12345", "passw0rd123", "qwerty1234", "qwerty12345", "qwertyuiop", "1234567890",
    "12345678910", "0987654321", "1q2w3e4r5t", "1qaz2wsx3edc", "iloveyou12", "football123", "letmein123", "welcome123",
    "abcdefghij", "abc1234567", "princess123", "monkey1234", "changeme123", "administrator", "kerf123456", "kerfkerf12",
    "lasercutter", "lasercutting", "teacher123", "teacher1234", "school1234", "school12345",
})
WEAK_HINT = "Three random words work well."
BAD_LOGIN = "That email address or password is not right."

_dummy: str | None = None


def _maxmem(n: int, r: int, p: int) -> int:
    return 128 * r * (n + p + 2) + (16 << 20)  # what scrypt needs, plus room


def _derive(password: str, salt: bytes, n: int, r: int, p: int) -> bytes:
    data = unicodedata.normalize("NFC", password).encode("utf-8")
    return hashlib.scrypt(data, salt=salt, n=n, r=r, p=p, dklen=DKLEN, maxmem=_maxmem(n, r, p))


def hash_password(password: str, n: int = N, r: int = R, p: int = P) -> str:
    salt = secrets.token_bytes(16)
    return f"scrypt${n}${r}${p}${salt.hex()}${_derive(password, salt, n, r, p).hex()}"


def _parse(stored: str | None) -> tuple[int, int, int, bytes, bytes] | None:
    try:
        kind, n, r, p, salt, digest = str(stored or "").split("$")
        n_, r_, p_ = int(n), int(r), int(p)
        if kind != "scrypt" or not (2 <= n_ <= 2**20 and n_ & (n_ - 1) == 0 and 1 <= r_ <= 32 and 1 <= p_ <= 16):
            return None
        return n_, r_, p_, bytes.fromhex(salt), bytes.fromhex(digest)
    except ValueError:
        return None


def check_password(password: str, stored: str | None) -> bool:
    """True when the password matches. An account with no password (or a damaged hash) is checked against a dummy hash, so
    it costs the same time and is never a match."""
    parts = _parse(stored)
    if parts is None:
        _derive(password, b"\0" * 16, N, R, P)
        return False
    n, r, p, salt, digest = parts
    return hmac.compare_digest(_derive(password, salt, n, r, p), digest)


def needs_rehash(stored: str | None) -> bool:
    parts = _parse(stored)
    return parts is None or parts[0] < N or parts[1] < R or parts[2] < P


def dummy_check(password: str) -> None:
    """The same work as checking a real password (an unknown address)."""
    global _dummy
    _dummy = _dummy or hash_password(secrets.token_urlsafe(12))
    check_password(password, _dummy)


def check_rules(password: Any, email: str) -> str:
    """The password, if it is good enough; else `422 weak_password` with a plain reason (never the password itself)."""
    if not isinstance(password, str) or not password:
        raise ApiError(422, "weak_password", f"Choose a password. Use at least {MIN_LEN} characters. {WEAK_HINT}")
    if len(password) < MIN_LEN:
        raise ApiError(422, "weak_password", f"Use at least {MIN_LEN} characters. {WEAK_HINT}")
    if len(password) > MAX_LEN:
        raise ApiError(422, "weak_password", f"Use at most {MAX_LEN} characters.")
    folded = password.casefold()
    if folded == email.casefold() or folded in email.casefold():
        raise ApiError(422, "weak_password", f"Do not use your email address as your password. {WEAK_HINT}")
    if folded in COMMON or len(set(folded)) < 3:
        raise ApiError(422, "weak_password", f"That password is too easy to guess. {WEAK_HINT}")
    return password


def set_password(s: Session, acct: StaffAccount, password: str, keep_token_hash: str | None = None) -> None:
    """Store a new password (already checked by `check_rules`). Ends the person's other sessions, uses up their other links and
    clears any lockout."""
    now = utcnow()
    acct.password_hash = hash_password(password)
    acct.password_set_at = now
    acct.failed_attempts, acct.locked_until = 0, None
    for t in s.scalars(select(Token).where(Token.subject_id == acct.person_id, Token.school_id == acct.school_id, Token.revoked.is_(False))):
        if t.token_hash != keep_token_hash:
            t.revoked = True
    for link in s.scalars(select(SignInLink).where(SignInLink.person_id == acct.person_id, SignInLink.used_at.is_(None))):
        link.used_at = now


def session_for(s: Session, cfg: Settings, acct: StaffAccount, label: str = "password sign-in") -> dict[str, Any]:
    """A new staff session (`Token.method = "password"`), accepted alongside DINO like the other Kerf sign-ins."""
    now = utcnow()
    acct.last_login = now
    token = new_token(acct.role if acct.role != "technician" else "teacher")
    expires = now + timedelta(hours=cfg.session_hours)
    s.add(Token(token_hash=hash_token(token), role=acct.role, subject_id=acct.person_id, school_id=acct.school_id, label=label,
                expires_at=expires, method="password"))
    return {"token": token, "role": acct.role, "id": acct.person_id, "name": acct.name, "expiresAt": iso(expires), "school": acct.school_id}


def _locked(acct: StaffAccount) -> bool:
    return acct.locked_until is not None and as_utc(acct.locked_until) > utcnow()


def _failed(acct: StaffAccount) -> None:
    acct.failed_attempts = (acct.failed_attempts or 0) + 1
    if acct.failed_attempts >= MAX_FAILURES:
        acct.failed_attempts, acct.locked_until = 0, utcnow() + timedelta(minutes=LOCK_MINUTES)
        log.info("staff_login locked person=%s", acct.person_id)


def login(s: Session, cfg: Settings, throttle: Any, ip: str, body: dict[str, Any]) -> dict[str, Any]:
    """`{email, password, school?}` -> a session. Wrong email or wrong password is one identical `401 bad_login`."""
    from .services_signin import allowed
    from .services_staffmail import EMAIL_RE

    email, password, school = body.get("email"), body.get("password"), body.get("school")
    if not isinstance(email, str) or not email.strip() or not isinstance(password, str) or not password:
        raise ApiError(422, "invalid", "Enter your email address and password.")
    if school is not None and not isinstance(school, str):
        raise ApiError(422, "invalid", "school is a school ID.")
    if throttle.blocked(ip, cfg):
        raise ApiError(429, "too_many_attempts", "Too many wrong tries from this computer. Wait a few minutes.")
    email = email.strip().lower()
    bad = ApiError(401, "bad_login", BAD_LOGIN)
    accounts: list[StaffAccount] = []
    if len(email) <= 254 and EMAIL_RE.match(email) and len(password) <= 1024:
        q = select(StaffAccount).where(StaffAccount.email == email, StaffAccount.disabled.is_(False))
        if school:
            q = q.where(StaffAccount.school_id == school)
        accounts = list(s.scalars(q.order_by(StaffAccount.school_id)))
    if not accounts:
        dummy_check(password[:1024])
        throttle.fail(ip)
        log.info("staff_login bad_login (no such account)")
        raise bad
    matched: list[StaffAccount] = []
    locked = False
    for a in accounts:
        if _locked(a):
            locked = True
            dummy_check(password)
            continue
        if check_password(password, a.password_hash):
            matched.append(a)
        elif a.password_hash:
            _failed(a)
            log.info("staff_login bad_login person=%s", a.person_id)
    if not matched:
        throttle.fail(ip)
        s.commit()  # keep the counts even though we are about to raise
        if locked:
            raise ApiError(429, "locked", f"Too many wrong passwords. This account is locked for {LOCK_MINUTES} minutes. Wait, or use "
                                          "Forgot your password? to set a new one.")
        raise bad
    for a in matched:
        a.failed_attempts, a.locked_until = 0, None
    open_ = [a for a in matched if allowed(s, a.school_id, "email")]
    if not open_:
        s.commit()
        log.info("staff_login sign_in_off person=%s", matched[0].person_id)
        raise ApiError(403, "sign_in_off", "Email and password sign-in is switched off for your school. Use your school's sign-in, or ask your school's Kerf admin.")
    if len(open_) > 1:
        s.commit()
        names = {r.id: r.name for r in s.scalars(select(School).where(School.id.in_([a.school_id for a in open_])))}
        raise ApiError(409, "choose_school", "You have Kerf accounts at more than one school. Choose the school to sign in to.",
                       [{"school": a.school_id, "name": names.get(a.school_id, a.school_id)} for a in open_])
    acct = open_[0]
    if needs_rehash(acct.password_hash):
        acct.password_hash = hash_password(password)
    log.info("staff_login ok person=%s school=%s", acct.person_id, acct.school_id)
    return session_for(s, cfg, acct)


def change(s: Session, person_id: str, school: str | None, token_hash: str, body: dict[str, Any]) -> dict[str, Any]:
    """`{current, new}`: a signed-in member of staff changes their password. Their other sessions end; this one stays."""
    acct = s.get(StaffAccount, person_id)
    if acct is None or acct.school_id != school or acct.disabled or not acct.password_hash:
        raise ApiError(409, "no_password", "You signed in another way, so there is no Kerf password to change here.")
    current, new = body.get("current"), body.get("new")
    if not isinstance(current, str) or not current:
        raise ApiError(422, "invalid", "Enter your current password.")
    if _locked(acct):
        raise ApiError(429, "locked", f"Too many wrong passwords. Wait {LOCK_MINUTES} minutes, or use Forgot your password? on the sign-in page.")
    if not check_password(current, acct.password_hash):
        _failed(acct)
        s.commit()
        log.info("staff_password_change wrong_current person=%s", acct.person_id)
        raise ApiError(403, "wrong_password", "Your current password is not right.")
    password = check_rules(new, acct.email)
    if password == current:
        raise ApiError(422, "weak_password", "Choose a new password that is different from your current one.")
    set_password(s, acct, password, keep_token_hash=token_hash)
    log.info("staff_password_changed person=%s", acct.person_id)
    return {"message": "Your password has been changed. You are still signed in here; other computers are signed out."}
