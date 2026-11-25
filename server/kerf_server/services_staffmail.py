"""Staff accounts and the emails that check their address (docs/ACCOUNTS.md: "Staff sign in with email and password; email
validates the address"). A school admin invites them (`StaffAccount`); the invite, and "Forgot your password?", are one-time
links (`SignInLink`) that lead to *Choose a password* on the sign-in page. Finishing a link sets the password
(`services_staffpw`) and starts an ordinary expiring session (`Token.method = "password"`). Nobody signs in by link alone.

Asking for a reset link always gets the same answer whether or not the address has an account, so nobody can find out who
works where. Requests are limited per address and per computer. Addresses, links and passwords are never logged.
"""
from __future__ import annotations

import logging

import re
import secrets
import time
from collections import defaultdict, deque
from datetime import timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from . import services_email as mail
from .config import Settings
from .db import as_utc, iso, utcnow
from .errors import ApiError
from .models import School, SignInLink, StaffAccount, Token
from .security import hash_token

EMAIL_RE = re.compile(r"^[^@\s<>\"',;]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+$")
ROLES = ("admin", "teacher", "technician")
RESET_MINUTES = 30
INVITE_DAYS = 7
PER_ADDRESS = 3      # links per address per window
PER_COMPUTER = 20    # link requests per IP per window
WINDOW_S = 15 * 60
SAME = "If that address has a Kerf account, a link to set a new password is on its way. Check your email (and your junk folder)."
PASSWORD_NEEDED = ApiError(422, "password_needed", "Choose a password to finish. Reload the sign-in page and open the link from your email again.")


def clean_email(raw: Any) -> str:
    e = str(raw or "").strip().lower()
    if len(e) > 254 or not EMAIL_RE.match(e):
        raise ApiError(422, "invalid", "That is not an email address.")
    return e


class LinkThrottle:
    """In memory, like the class-login throttle: a restart forgives everyone."""

    def __init__(self) -> None:
        self.hits: dict[str, deque[float]] = defaultdict(deque)

    def allow(self, key: str, limit: int, window_s: float = WINDOW_S) -> bool:
        q, now = self.hits[key], time.monotonic()
        while q and now - q[0] > window_s:
            q.popleft()
        if len(q) >= limit:
            return False
        q.append(now)
        return True


def link_base(cfg: Settings, request_base: str) -> str:
    """Where links point. Production must set KERF_PUBLIC_URL: a link built from the request's Host header could be made to
    point at someone else's site. Only a development server (class-code sign-in) falls back to the request's address."""
    if cfg.public_url:
        return cfg.public_url
    if cfg.auth_mode == "pins":
        return request_base.rstrip("/")
    raise ApiError(503, "email_not_set_up", "Email sign-in is not set up on this server yet (KERF_PUBLIC_URL is missing).")


def _make_link(s: Session, acct: StaffAccount, purpose: str, lifetime: timedelta) -> str:
    token = secrets.token_urlsafe(32)
    s.add(SignInLink(token_hash=hash_token(token), person_id=acct.person_id, school_id=acct.school_id, purpose=purpose, expires_at=utcnow() + lifetime))
    return token


def _url(base: str, app: str, token: str) -> str:
    """The emailed link: Kerf's one sign-in page shows *Choose a password*, trades the token with the password, then opens the
    Admin site or the Editor. (Older links, ``/admin/?signin=`` and ``/?signin=``, are sent on to the sign-in page.)"""
    return f"{base}/sign-in?signin={token}&app={'admin' if app == 'admin' else 'editor'}"


def account_doc(a: StaffAccount) -> dict[str, Any]:
    return {"id": a.person_id, "email": a.email, "role": a.role, "name": a.name, "status": "active" if a.last_login else "invited",
            "lastLogin": iso(a.last_login), "createdAt": iso(a.created_at), "disabled": bool(a.disabled), "hasPassword": bool(a.password_hash)}


def list_accounts(s: Session, school: str) -> list[dict[str, Any]]:
    q = select(StaffAccount).where(StaffAccount.school_id == school, StaffAccount.disabled.is_(False)).order_by(StaffAccount.email)
    return [account_doc(a) for a in s.scalars(q)]


def invite(s: Session, mailer: mail.Mailer, cfg: Settings, base: str, school: str, by: str, body: dict[str, Any]) -> dict[str, Any]:
    """A school admin invites a member of staff by email (or sends a fresh invite to someone not signed in yet)."""
    email = clean_email(body.get("email"))
    role = body.get("role", "teacher")
    if role not in ROLES:
        raise ApiError(422, "invalid", f"role is one of {', '.join(ROLES)}.")
    name = str(body.get("name") or "").strip()[:128] or None
    row = s.get(School, school)
    if row is None:
        raise ApiError(404, "not_found", "There is no such school.")
    base = link_base(cfg, base)
    acct = s.scalar(select(StaffAccount).where(StaffAccount.school_id == school, StaffAccount.email == email))
    if acct is not None and not acct.disabled and (acct.last_login or acct.password_hash):
        raise ApiError(409, "conflict", "That person already has an account here. They sign in with their email and password; "
                                        "Forgot your password? on the sign-in page sets a new one.")
    if acct is None:
        acct = StaffAccount(person_id="st-" + secrets.token_hex(6), school_id=school, email=email, role=role, name=name, invited_by=by)
        s.add(acct)
    else:
        acct.role, acct.disabled, acct.invited_by = role, False, by
        acct.name = name or acct.name
    s.flush()
    token = _make_link(s, acct, "invite", timedelta(days=INVITE_DAYS))
    mailer.send(mail.invite_email(email, _url(base, "admin", token), row.name, role, INVITE_DAYS))
    return account_doc(acct)


def remove(s: Session, school: str, person_id: str) -> None:
    acct = s.get(StaffAccount, person_id)
    if acct is None or acct.school_id != school:
        raise ApiError(404, "not_found", "There is no such member of staff.")
    acct.disabled = True
    acct.password_hash = None  # an account added again later starts with a new invite and a new password
    for t in s.scalars(select(Token).where(Token.subject_id == person_id, Token.revoked.is_(False))):
        t.revoked = True
    for link in s.scalars(select(SignInLink).where(SignInLink.person_id == person_id, SignInLink.used_at.is_(None))):
        link.used_at = utcnow()


def forgot(s: Session, mailer: mail.Mailer, cfg: Settings, throttle: LinkThrottle, base: str, ip: str, body: dict[str, Any]) -> dict[str, Any]:
    """"Forgot your password?": email a reset link (30 minutes, once) to every school where this address has an account and
    email-and-password sign-in is on. The same answer either way, with the limits sign-in links had."""
    from .services_signin import allowed

    email = clean_email(body.get("email"))
    app = "editor" if body.get("app") == "editor" else "admin"
    if not throttle.allow(f"ip:{ip}", PER_COMPUTER):
        raise ApiError(429, "too_many_attempts", "Too many emails asked for from this computer. Wait a few minutes.")
    base = link_base(cfg, base)
    if not throttle.allow(f"to:{email}", PER_ADDRESS):
        logging.getLogger("kerf.email").info("email skipped: password reset link (3 already asked for this address in 15 minutes)")
        return {"message": SAME}  # quietly: the address already has links on the way
    for acct in s.scalars(select(StaffAccount).where(StaffAccount.email == email, StaffAccount.disabled.is_(False))):
        school = s.get(School, acct.school_id)
        if school is None or not allowed(s, acct.school_id, "email"):
            continue
        token = _make_link(s, acct, "reset", timedelta(minutes=RESET_MINUTES))
        s.flush()
        mailer.send(mail.reset_email(email, _url(base, app, token), school.name, RESET_MINUTES))
    return {"message": SAME}


#: The old name: `POST /auth/email/start` is now the same as `POST /auth/password/forgot`.
start = forgot


def finish(s: Session, cfg: Settings, body: dict[str, Any]) -> dict[str, Any]:
    """`{token, password}`: an invite or reset link plus the password the person chose -> the password is set and they are
    signed in. A link works once; an expired, used or unknown one gets the same answer. Without a password (an old page) the
    link is not used up: `422 password_needed`."""
    from .services_signin import allowed
    from . import services_staffpw as pw

    if body.get("password") in (None, ""):
        raise PASSWORD_NEEDED
    raw = str(body.get("token") or "").strip()
    link = s.get(SignInLink, hash_token(raw)) if raw else None
    bad = ApiError(401, "link_invalid", "That link has expired or has already been used. Use Forgot your password? to get a new one.")
    if link is None or link.used_at is not None or as_utc(link.expires_at) <= utcnow():
        raise bad
    acct = s.get(StaffAccount, link.person_id)
    if acct is None or acct.disabled or acct.school_id != link.school_id:
        raise bad
    if link.purpose != "invite" and not allowed(s, acct.school_id, "email"):
        raise ApiError(403, "sign_in_off", "Email and password sign-in is switched off for your school. Ask your school's Kerf admin.")
    password = pw.check_rules(body.get("password"), acct.email)  # a weak password leaves the link unused, to try again
    link.used_at = utcnow()
    pw.set_password(s, acct, password)
    logging.getLogger("kerf.audit").info("staff_password_set person=%s school=%s from=%s", acct.person_id, acct.school_id, link.purpose)
    return pw.session_for(s, cfg, acct)
