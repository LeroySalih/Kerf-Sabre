from __future__ import annotations

from collections.abc import Iterator

from fastapi import Depends, Request
from sqlalchemy.orm import Session

from .config import Settings


def get_session(request: Request) -> Iterator[Session]:
    with request.app.state.db.session() as s:
        yield s


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def feature(name: str):
    """Dependency: refuses a school whose terms leave out this feature (`laser` or `activities`) with 403 paid_feature.
    A site admin with no school (the Platform) and a paid school pass."""

    def dep(request: Request):
        from .security import current_principal
        from .services_terms import require as require_feature

        who = current_principal(request)
        if who.school is None:
            return who
        with request.app.state.db.session() as s:
            require_feature(s, who.school, name)
        return who

    return dep


#: Sending to the laser: the queue, approval, Station pages and lasers, the Cutter download, the camera.
PAID = [Depends(feature("laser"))]
#: Activities and teacher feedback.
ACTIVITIES = [Depends(feature("activities"))]
