"""The person's open tabs, kept so another browser shows the same ones."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends
from sqlalchemy.orm import Session

from .. import services_workspace as ws
from ..deps import get_session
from ..security import Principal, require

router = APIRouter(tags=["workspace"])


@router.get("/workspace")
def get_workspace(who: Principal = Depends(require("pupil")), s: Session = Depends(get_session)):
    return ws.load(s, who)


@router.put("/workspace")
def put_workspace(body: dict[str, Any] = Body(...), who: Principal = Depends(require("pupil")), s: Session = Depends(get_session)):
    return ws.save(s, who, body)
