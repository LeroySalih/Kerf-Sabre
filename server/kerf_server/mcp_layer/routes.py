"""POST /mcp and the OAuth discovery document MCP clients read first (RFC 9728), pointing them at planner-004 (DINO)."""
from __future__ import annotations

import json
import logging
from typing import Any
from urllib.parse import urlsplit

from fastapi import APIRouter, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from ..errors import ApiError
from ..models import DEFAULT_SCHOOL
from ..security import Principal, bearer, lookup
from ..sso import looks_like_jwt
from . import protocol
from .tools import TOOLS, ToolContext

log = logging.getLogger("kerf.mcp")
router = APIRouter(tags=["mcp"], include_in_schema=False)
STAFF = ("teacher", "admin", "technician")  # pupils and stations never get MCP
MAX_BODY = 256 * 1024


def _origin(request: Request) -> str:
    cfg = request.app.state.settings
    return cfg.public_url or str(request.base_url).rstrip("/")


def _resource(request: Request) -> str:
    cfg = request.app.state.settings
    return cfg.mcp_resource or f"{_origin(request)}/mcp"


def _challenge(request: Request, status: int, message: str, error: str = "invalid_token") -> JSONResponse:
    meta = f"{_origin(request)}/.well-known/oauth-protected-resource/mcp"
    hdr = f'Bearer resource_metadata="{meta}"' + (f', error="{error}"' if error else "")
    return JSONResponse({"error": error, "error_description": message}, status_code=status, headers={"WWW-Authenticate": hdr})


def _principal(request: Request, token: str) -> Principal:
    cfg = request.app.state.settings
    if looks_like_jwt(token):
        sso = request.app.state.sso
        if sso is None or not cfg.mcp_aud:
            raise ApiError(401, "unauthorized", "Sign-in with DINO is not set up for MCP on this server.")
        role, sub = sso.verify(token, audience=cfg.mcp_aud, any_client=True)  # a token bound to the MCP resource, from any registered client
        return Principal(role, sub, DEFAULT_SCHOOL)
    with request.app.state.db.session() as s:  # stored tokens: tests and offline development only (never in planner mode)
        p = lookup(s, token, cfg.auth_mode != "planner")
    if p is None:
        raise ApiError(401, "unauthorized", "That token is not recognised or has been revoked.")
    return p


def _origin_ok(request: Request) -> bool:
    """MCP asks servers to check Origin (DNS rebinding). AI apps call from servers and send none; browsers must be one of ours."""
    o = request.headers.get("origin")
    if not o:
        return True
    cfg = request.app.state.settings
    allowed = {x.rstrip("/") for x in cfg.cors_origins}
    if cfg.public_url:
        allowed.add(cfg.public_url)
    return o.rstrip("/") in allowed


@router.get("/.well-known/oauth-protected-resource")
@router.get("/.well-known/oauth-protected-resource/mcp")
def protected_resource(request: Request) -> dict[str, Any]:
    cfg = request.app.state.settings
    return {
        "resource": _resource(request),
        "authorization_servers": [cfg.sso_issuer] if cfg.sso_issuer else [],
        "bearer_methods_supported": ["header"],
        "resource_name": "BISAK Kerf Server (read-only)",
    }


@router.get("/mcp")
@router.delete("/mcp")
def not_a_stream() -> Response:
    """Stateless server: no event stream to open and no session to end."""
    return Response(status_code=405, headers={"Allow": "POST"})


@router.post("/mcp")
async def mcp(request: Request) -> Response:
    if not _origin_ok(request):
        return JSONResponse({"error": "forbidden", "error_description": "That origin is not allowed."}, status_code=403)
    token = bearer(request)
    if not token:
        return _challenge(request, 401, "Sign in with DINO to use this server.", error="")
    try:
        who = await run_in_threadpool(_principal, request, token)
    except ApiError as e:
        if e.status == 401:
            return _challenge(request, 401, e.message)
        return JSONResponse({"error": e.code, "error_description": e.message}, status_code=e.status)
    if who.role not in STAFF:
        return JSONResponse({"error": "forbidden", "error_description": "MCP is for teachers, admins and technicians."}, status_code=403)

    raw = await request.body()
    if len(raw) > MAX_BODY:
        return JSONResponse({"error": "too_large"}, status_code=413)
    try:
        body = json.loads(raw)
    except ValueError:
        return JSONResponse(protocol._err(None, protocol.PARSE_ERROR, "That is not JSON."), status_code=400)

    app = request.app

    def run_one(msg: Any):
        def ctx() -> ToolContext:
            return ToolContext(who, s_holder["s"], app.state.settings, app.state.hub)

        def audit(tool: str, ok: bool) -> None:  # who and what only: never arguments, names or results
            log.info("mcp tool=%s by=%s role=%s ok=%s", tool, who.id, who.role, ok)

        with app.state.db.session() as s:
            s_holder["s"] = s
            return protocol.handle(msg, TOOLS, ctx, audit)

    s_holder: dict[str, Any] = {}
    msgs = body if isinstance(body, list) else [body]  # older protocol versions allow batches
    if not msgs or len(msgs) > 20:
        return JSONResponse(protocol._err(None, protocol.INVALID_REQUEST, "Send one message, or at most 20."), status_code=400)
    replies = [r for r in [await run_in_threadpool(run_one, m) for m in msgs] if r is not None]
    if not replies:
        return Response(status_code=202)  # only notifications or responses
    return JSONResponse(replies if isinstance(body, list) else replies[0])
