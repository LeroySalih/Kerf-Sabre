"""Kerf's emails (invites, password resets, school confirmations), sent through Resend (https://resend.com) from `Settings.email_from`.

The API key comes from the environment (`RESEND_API`). Without one, emails are kept in memory (`Mailer.outbox`, newest 50)
instead of sent, so development and tests work offline. Addresses and links are never logged: a log line says only what
kind of email went out and whether it worked.
"""
from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request
from collections import deque
from dataclasses import dataclass, field
from html import escape

from .config import Settings
from .errors import ApiError

log = logging.getLogger("kerf.email")
RESEND_URL = "https://api.resend.com/emails"


@dataclass
class Email:
    to: str
    subject: str
    text: str
    html: str
    kind: str


@dataclass
class Mailer:
    api_key: str
    sender: str
    outbox: deque = field(default_factory=lambda: deque(maxlen=50))

    @staticmethod
    def from_settings(cfg: Settings) -> "Mailer":
        return Mailer(cfg.resend_api_key, cfg.email_from)

    @property
    def live(self) -> bool:
        return bool(self.api_key)

    def send(self, mail: Email) -> None:
        if not self.live:
            self.outbox.append(mail)
            log.info("email kept (no RESEND_API set): %s", mail.kind)
            return
        body = json.dumps({"from": self.sender, "to": [mail.to], "subject": mail.subject, "text": mail.text, "html": mail.html}).encode()
        req = urllib.request.Request(RESEND_URL, data=body, method="POST", headers={
            "Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json", "User-Agent": "kerf-server"})
        try:
            with urllib.request.urlopen(req, timeout=15) as res:  # noqa: S310 (fixed https URL)
                res.read()
            log.info("email sent: %s", mail.kind)
        except urllib.error.HTTPError as e:
            log.warning("email not sent: %s (Resend answered %s)", mail.kind, e.code)
            raise ApiError(502, "email_failed", "Kerf could not send the email just now. Try again in a minute.") from e
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            log.warning("email not sent: %s (%s)", mail.kind, type(e).__name__)
            raise ApiError(502, "email_failed", "Kerf could not send the email just now. Try again in a minute.") from e


def _html(title: str, lines: list[str], link: str, button: str, small: str) -> str:
    paras = "".join(f'<p style="margin:0 0 14px">{escape(x)}</p>' for x in lines)
    return (f'<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#111827">'
            f'<h1 style="font-size:20px;margin:0 0 16px">{escape(title)}</h1>{paras}'
            f'<p style="margin:22px 0"><a href="{escape(link, quote=True)}" style="background:#f97316;color:#fff;padding:11px 18px;border-radius:6px;text-decoration:none;font-weight:600">{escape(button)}</a></p>'
            f'<p style="margin:0 0 8px;color:#6b7280;font-size:13px">Or copy this address into your browser:<br><span style="word-break:break-all">{escape(link)}</span></p>'
            f'<p style="margin:16px 0 0;color:#6b7280;font-size:13px">{escape(small)}</p></div>')


def reset_email(to: str, link: str, school_name: str, minutes: int) -> Email:
    """"Forgot your password?": a one-time link to choose a new password. Signing in is always email + password."""
    lines = [f"Someone (we hope it was you) asked to set a new password for your Kerf account at {school_name}.",
             f"Press the button to choose a new password. The link works once, for {minutes} minutes. "
             "Choosing a new password signs you out on every other computer."]
    small = "If you did not ask for this, you can ignore this email: your password stays as it is."
    text = f"Reset your Kerf password\n\n{lines[0]}\n{lines[1]}\n\n{link}\n\n{small}\n"
    return Email(to, f"Reset your Kerf password ({school_name})", text, _html("Reset your Kerf password", lines, link, "Choose a new password", small), "password reset link")


def invite_email(to: str, link: str, school_name: str, role: str, days: int) -> Email:
    what = {"admin": "a school admin", "teacher": "a teacher", "technician": "a technician (laser stations)"}.get(role, role)
    lines = [f"You have been invited to Kerf, the laser design and cutting service used by {school_name}, as {what}.",
             f"Press the button to choose your password. The link works once, for {days} days. "
             "After that, you sign in with this email address and your password."]
    small = "If you were not expecting this, you can ignore it."
    text = f"You are invited to Kerf\n\n{lines[0]}\n{lines[1]}\n\n{link}\n\n{small}\n"
    return Email(to, f"You are invited to Kerf ({school_name})", text, _html("You are invited to Kerf", lines, link, "Choose your password", small), "invite")


def register_email(to: str, link: str, school_name: str, hours: int) -> Email:
    """Confirm a school that registered at /register. Nothing exists until the link is used."""
    lines = [f"Thank you for registering {school_name} on Kerf, the free laser design tools for schools.",
             f"Press the button to confirm and choose your password. Kerf then sets up {school_name} on the free plan, makes you its admin and signs you in. "
             "Next you add your teachers, make groups and print Pupil Cards for your pupils.",
             f"The link works once, for {hours} hours. Nothing is set up until you press it."]
    small = "If you did not register a school on Kerf, you can ignore this email: nothing will be set up."
    text = "Confirm your school on Kerf\n\n" + "\n".join(lines) + f"\n\n{link}\n\n{small}\n"
    return Email(to, f"Confirm your school on Kerf ({school_name})", text, _html("Confirm your school on Kerf", lines, link, "Confirm and choose a password", small), "registration link")


def school_registered_email(to: str, school_name: str, school_id: str) -> Email:
    """One line for Kerf's owner (`KERF_ADMIN_EMAIL`): which school registered. Never the person's email."""
    line = f"A new free school registered on Kerf: {school_name} ({school_id})."
    html = f'<p style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#111827">{escape(line)}</p>'
    return Email(to, f"New school on Kerf: {school_name}", line + "\n", html, "school registered")
