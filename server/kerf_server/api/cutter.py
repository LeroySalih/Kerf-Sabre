"""The Cutter software download, for the Admin site: a short-lived download link and a token for one laser to put in its run command."""
from __future__ import annotations

import secrets
import time
from datetime import timedelta
from typing import Any

from fastapi import APIRouter, Body, Depends, Request
from fastapi.responses import Response
from sqlalchemy.orm import Session

from .. import services_schools as ss
from ..db import iso, utcnow
from ..deps import get_session
from ..devtools import package
from ..config import Settings
from ..deps import get_settings
from ..errors import ApiError
from ..security import Principal, require
from .stations import known

router = APIRouter(tags=["cutter"])
LINK_SECONDS = 3600


@router.post("/cutter/package", status_code=201)
def make_package(request: Request, body: dict[str, Any] = Body(...), who: Principal = Depends(require("admin")), s: Session = Depends(get_session), cfg: Settings = Depends(get_settings)):
    """For one of the school's lasers: a new station token (shown once, not stored in the clear) and a link to download the Cutter
    for an hour. The download itself holds no secret; the token goes in the run command."""
    station = body.get("station")
    if not isinstance(station, str):
        raise ApiError(422, "invalid", "Say which laser this Cutter is for.")
    known(s, who, station)
    token = ss.add_staff(request.app.state.db, who.school, "station", station, "cutter download")
    links: dict[str, float] = request.app.state.download_links
    now = time.time()
    for k in [k for k, exp in links.items() if exp < now]:
        del links[k]
    link = secrets.token_urlsafe(24)
    links[link] = now + LINK_SECONDS
    kind, name = package.kind_of(cfg)
    return {"station": station, "token": token, "kind": kind, "downloadPath": f"/api/v1/downloads/cutter/{link}/{name}",
            "fileName": name, "expiresAt": iso(utcnow().replace(microsecond=0) + timedelta(seconds=LINK_SECONDS))}


@router.get("/downloads/cutter/{link}/{name}", include_in_schema=False)
def download(request: Request, link: str, name: str, cfg: Settings = Depends(get_settings)):
    """A browser link cannot send a token, so the link itself is the (short-lived, unguessable) permission."""
    exp = request.app.state.download_links.get(link)
    kind, file_name, data = package.choose(cfg)
    if exp is None or exp < time.time() or name != file_name:
        raise ApiError(404, "not_found", "That download link has expired. Make a new one on the Admin site.")
    return Response(data, media_type="application/zip", headers={"Content-Disposition": f'attachment; filename="{file_name}"', "Cache-Control": "no-store"})
