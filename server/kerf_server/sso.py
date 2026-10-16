"""Sign in with planner-004 (DINO): verify its RS256 JWT access tokens offline against its published keys (JWKS).

Design: docs/AUTH-PLANNER-004.md. The token carries `sub` (the DINO user ID, used as the person's ID here), `roles`,
`iss`, `aud`, `client_id` and `exp`. Never a name or email, and this module never stores or logs the token or claims
beyond `sub`. A JWT can only ever become a pupil, teacher, technician or admin: never a station or the platform.
"""
from __future__ import annotations

import json
import logging
import threading
import time
import urllib.request
from collections.abc import Callable
from typing import Any

import jwt
from jwt.algorithms import RSAAlgorithm

from .config import Settings
from .errors import ApiError
from .models import DEFAULT_SCHOOL

log = logging.getLogger("kerf.sso")

LEEWAY_S = 30
KEY_TTL_S = 300  # how long fetched keys are trusted without a refresh
UNKNOWN_KID_REFETCH_S = 30  # an unknown key ID may mean a rotation, but never refetch more often than this
ID_OK = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")


def looks_like_jwt(token: str) -> bool:
    return token.startswith("eyJ") and token.count(".") == 2


def _http_get_json(url: str) -> dict[str, Any]:
    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "kerf-server"})
    with urllib.request.urlopen(req, timeout=5) as r:  # noqa: S310 (operator-configured https URL)
        return json.loads(r.read().decode())


def pick_role(roles: Any) -> str | None:
    """admin > teacher > technician > pupil. None when the token holds no role Kerf knows."""
    if not isinstance(roles, list):
        return None
    have = {r.strip().lower() for r in roles if isinstance(r, str)}
    if "admin" in have:
        return "admin"
    if "teacher" in have:
        return "teacher"
    if "technician" in have:
        return "technician"
    if "pupil" in have:
        return "pupil"
    return None


class Verifier:
    def __init__(self, cfg: Settings, fetch: Callable[[str], dict[str, Any]] | None = None, clock: Callable[[], float] = time.monotonic):
        self.cfg = cfg
        self.fetch = fetch or _http_get_json
        self.clock = clock
        self._keys: dict[str, Any] = {}
        self._fetched_at: float | None = None
        self._last_attempt: float | None = None
        self._lock = threading.Lock()

    @property
    def jwks_url(self) -> str:
        return self.cfg.sso_jwks_url or f"{self.cfg.sso_issuer}/oauth/jwks"

    def _refresh(self) -> None:
        self._last_attempt = self.clock()
        doc = self.fetch(self.jwks_url)
        keys: dict[str, Any] = {}
        for jwk in doc.get("keys", []):
            if jwk.get("kty") == "RSA" and jwk.get("kid") and jwk.get("use", "sig") == "sig":
                keys[jwk["kid"]] = RSAAlgorithm.from_jwk(json.dumps(jwk))
        if not keys:
            raise ValueError("the key set has no usable RSA signing keys")
        self._keys, self._fetched_at = keys, self.clock()

    def _key_for(self, kid: str) -> Any:
        with self._lock:
            now = self.clock()
            fresh = self._fetched_at is not None and now - self._fetched_at < KEY_TTL_S
            key = self._keys.get(kid) if fresh else None
            if key is not None:
                return key
            may_try = self._last_attempt is None or now - self._last_attempt >= UNKNOWN_KID_REFETCH_S
            if may_try:
                try:
                    self._refresh()
                except Exception as e:  # network, bad JSON, bad keys
                    log.warning("could not fetch the planner-004 signing keys from %s: %s", self.jwks_url, e)
                    key = self._keys.get(kid)  # an old key beats locking everyone out during a short outage
                    if key is not None:
                        return key
                    raise ApiError(503, "sso_unavailable", "Sign-in with DINO is not reachable right now. Try again in a minute.") from e
            key = self._keys.get(kid)
            if key is None:
                raise ApiError(401, "unauthorized", "That sign-in token was not signed by DINO.")
            return key

    def verify(self, token: str) -> tuple[str, str]:
        """Returns (role, id) for a valid token, else raises ApiError 401/403/503."""
        bad = ApiError(401, "unauthorized", "That sign-in token is not valid or has expired. Sign in again.")
        try:
            header = jwt.get_unverified_header(token)
        except jwt.PyJWTError:
            raise bad from None
        if header.get("alg") != "RS256" or not isinstance(header.get("kid"), str) or str(header.get("typ", "")).lower() not in ("at+jwt", "application/at+jwt"):
            raise bad
        key = self._key_for(header["kid"])
        try:
            claims = jwt.decode(
                token, key, algorithms=["RS256"], audience=self.cfg.sso_audience, issuer=self.cfg.sso_issuer,
                leeway=LEEWAY_S, options={"require": ["exp", "nbf", "iss", "aud", "sub"]},
            )
        except jwt.PyJWTError as e:
            log.info("sign-in token refused: %s", type(e).__name__)
            raise bad from None
        allowed_clients = {self.cfg.sso_client_editor, self.cfg.sso_client_admin}
        if claims.get("client_id") not in allowed_clients:
            raise bad
        sub = claims["sub"]
        if not isinstance(sub, str) or not 0 < len(sub) <= 64 or not set(sub) <= ID_OK:
            raise bad
        role = pick_role(claims.get("roles"))
        if role is None:
            raise ApiError(403, "forbidden", "Your DINO account does not have a role that can use Kerf.")
        return role, sub

    def principal(self, token: str):
        from .security import Principal

        role, sub = self.verify(token)
        return Principal(role, sub, DEFAULT_SCHOOL)


def auth_config(cfg: Settings) -> dict[str, Any]:
    """What `GET /auth/config` tells the Editor and Admin: how to sign in here."""
    out: dict[str, Any] = {"mode": cfg.auth_mode, "sso": None}
    if cfg.sso_enabled:
        o = cfg.sso_issuer
        out["sso"] = {
            "issuer": o, "authorizeUrl": f"{o}/oauth/authorize", "tokenUrl": f"{o}/oauth/token",
            "revokeUrl": f"{o}/oauth/revoke", "userinfoUrl": f"{o}/oauth/userinfo",
            "clientIds": {"editor": cfg.sso_client_editor, "admin": cfg.sso_client_admin}, "scopes": ["profile"],
        }
    return out
