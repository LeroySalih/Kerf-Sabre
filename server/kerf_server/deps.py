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


def paid_school(request: Request):
    """Dependency for the paid service (queue, approval, lasers, Station pages, camera, activities): refuses a free school with 403 paid_feature.
    A site admin with no school (the Platform) and a school made before plans existed pass."""
    from .security import current_principal
    from .services_schools import require_paid

    who = current_principal(request)
    if who.school is None:
        return who
    with request.app.state.db.session() as s:
        require_paid(s, who.school)
    return who


PAID = [Depends(paid_school)]
