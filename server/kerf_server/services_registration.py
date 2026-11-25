"""Free schools register themselves (docs/ACCOUNTS.md: "Free schools register instantly"; paid schools are still approved by
the site admin).

A teacher fills in /register (school name, their name, their school email). `start` stores a **pending registration** (only the
SHA-256 of the link) and emails a confirmation link that works once, for 24 hours. Nothing is made until the link is used, so a
junk address creates no school. The link opens *Choose a password*; `finish` (token + password) makes the school on the free
plan (a school code, the default terms copied, group code and email-and-password sign-in on), makes the person its first admin
(a `StaffAccount` with that password) and signs them in (`Token.method = "password"`).

The answer to `start` is the same whatever happens, so nobody can find out whether an address already has accounts. Requests
are limited per address and per computer (in memory, like the sign-in links). Addresses and links are never logged.
"""
from __future__ import annotations

import logging
import re
import secrets
import unicodedata
from datetime import timedelta
from typing import Any

from sqlalchemy.orm import Session

from . import services_email as mail
from . import services_people as people
from .config import Settings
from .db import as_utc, utcnow
from .errors import ApiError
from .models import AuditEvent, PendingRegistration, School, StaffAccount
from .security import hash_token
from .services_staffmail import PASSWORD_NEEDED, LinkThrottle, clean_email, link_base

log = logging.getLogger("kerf.audit")
LINK_HOURS = 24
PER_ADDRESS = 3              # registrations per address per 15 minutes
PER_COMPUTER = 10            # registrations per IP per day
ADDRESS_WINDOW_S = 15 * 60
COMPUTER_WINDOW_S = 24 * 60 * 60
SAME = "Thank you. If that address can receive email, a link to confirm your school is on its way. Check your email (and your junk folder)."
CLOSED = ApiError(403, "registration_closed", "Kerf is not taking new schools at the moment. Please try again later.")


def school_id_for(s: Session, name: str) -> str:
    """A school ID made from the name: lower case, dashes, at most 32 characters, unique (`-2`, `-3`... on a clash)."""
    ascii_name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    base = re.sub(r"[^a-z0-9]+", "-", ascii_name.lower()).strip("-")[:32].strip("-") or "school"
    if s.get(School, base) is None:
        return base
    for n in range(2, 10_000):
        tail = f"-{n}"
        cand = base[: 32 - len(tail)].strip("-") + tail
        if s.get(School, cand) is None:
            return cand
    raise ApiError(500, "error", "Could not make a school ID. Try again.")


def _text(raw: Any, what: str) -> str:
    v = " ".join("".join(c for c in str(raw or "") if c.isprintable()).split())
    if not v:
        raise ApiError(422, "invalid", f"Fill in {what}.")
    if len(v) > 128:
        raise ApiError(422, "invalid", f"{what[0].upper()}{what[1:]} is too long (at most 128 characters).")
    return v


def start(s: Session, mailer: mail.Mailer, cfg: Settings, throttle: LinkThrottle, base: str, ip: str, body: dict[str, Any]) -> dict[str, Any]:
    """Email a confirmation link for a new free school. The same answer whatever happens."""
    if not cfg.registration:
        raise CLOSED
    school_name = _text(body.get("schoolName"), "the school's name")
    name = people.clean_name(_text(body.get("name"), "your name"))
    if name is None:
        raise ApiError(422, "invalid", "Your name cannot be an email address.")
    email = clean_email(body.get("email"))
    if not throttle.allow(f"reg-ip:{ip}", PER_COMPUTER, COMPUTER_WINDOW_S):
        raise ApiError(429, "too_many_attempts", "Too many schools registered from this computer today. Try again tomorrow.")
    base = link_base(cfg, base)
    if not throttle.allow(f"reg-to:{email}", PER_ADDRESS, ADDRESS_WINDOW_S):
        logging.getLogger("kerf.email").info("email skipped: registration link (3 already asked for this address in 15 minutes)")
        return {"message": SAME}  # quietly: links are already on their way to this address
    token = secrets.token_urlsafe(32)
    s.add(PendingRegistration(token_hash=hash_token(token), school_name=school_name, name=name, email=email, expires_at=utcnow() + timedelta(hours=LINK_HOURS)))
    s.flush()
    mailer.send(mail.register_email(email, f"{base}/sign-in?register={token}", school_name, LINK_HOURS))
    return {"message": SAME}


def finish(s: Session, mailer: mail.Mailer, cfg: Settings, body: dict[str, Any]) -> dict[str, Any]:
    """Use the confirmation link (`{token, password}`): make the free school and its first admin with that password, and sign
    them in. A link works once. Without a password (an old page) the link is not used up: `422 password_needed`."""
    from . import services_staffpw as pw
    from .services_schools import create_school

    if not cfg.registration:
        raise CLOSED
    if body.get("password") in (None, ""):
        raise PASSWORD_NEEDED
    raw = str(body.get("token") or "").strip()
    row = s.get(PendingRegistration, hash_token(raw)) if raw else None
    if row is None or row.used_at is not None or as_utc(row.expires_at) <= utcnow():
        raise ApiError(401, "link_invalid", "That link has expired or has already been used. If you have already confirmed your school, sign in with your email and password; otherwise register again.")
    password = pw.check_rules(body.get("password"), row.email)  # a weak password leaves the link unused, to try again
    now = utcnow()
    school = create_school(s, school_id_for(s, row.school_name), row.school_name, plan="free")
    acct = StaffAccount(person_id="st-" + secrets.token_hex(6), school_id=school.id, email=row.email, role="admin", name=row.name,
                        invited_by="registered", password_hash=pw.hash_password(password), password_set_at=now, failed_attempts=0)
    s.add(acct)
    row.used_at, row.school_id = now, school.id
    out = pw.session_for(s, cfg, acct)
    s.add(AuditEvent(school_id=school.id, actor_id=acct.person_id, action="school_registered", subject_id=school.id))
    s.flush()
    log.info("school_registered school=%s by=%s", school.id, acct.person_id)
    if cfg.admin_email:  # one line for Kerf's owner: the school only, never the person's email
        try:
            mailer.send(mail.school_registered_email(cfg.admin_email, school.name, school.id))
        except ApiError:
            pass  # the school is made either way; the mailer has logged why
    return {**out, "school": school.id, "schoolName": school.name, "schoolCode": school.code}
