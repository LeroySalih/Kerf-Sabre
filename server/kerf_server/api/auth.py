from __future__ import annotations

from fastapi import APIRouter, Depends

from ..security import Principal, current_principal

router = APIRouter(tags=["auth"])


@router.get("/auth/me")
def me(p: Principal = Depends(current_principal)) -> dict[str, str]:
    return {"role": p.role, "id": p.id}
