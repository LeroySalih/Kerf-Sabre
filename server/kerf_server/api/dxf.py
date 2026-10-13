"""POST /dxf/cleanup: run the clean-up pipeline on an uploaded DXF."""
from __future__ import annotations

from fastapi import APIRouter, Depends, File, Form, UploadFile
from fastapi.concurrency import run_in_threadpool

from ..cleanup import DxfError, cleanup_dxf
from ..config import Settings
from ..deps import get_settings
from ..errors import ApiError
from ..security import Principal, require

router = APIRouter(tags=["dxf"])
UNITS = ("mm", "cm", "inch")


async def read_upload(file: UploadFile, cfg: Settings) -> bytes:
    """The whole upload, refusing anything over the size limit. The file's own name is never looked at or kept."""
    limit = cfg.max_upload_mb * 1024 * 1024
    data = await file.read(limit + 1)
    if len(data) > limit:
        raise ApiError(413, "too_large", f"That file is bigger than {cfg.max_upload_mb} MB.")
    if not data:
        raise ApiError(422, "dxf_empty", "The file is empty.")
    return data


def check_options(tolerance_mm: float, units_override: str | None) -> None:
    if not (0.001 <= tolerance_mm <= 1.0):
        raise ApiError(422, "invalid", "toleranceMm must be between 0.001 and 1.")
    if units_override is not None and units_override not in UNITS:
        raise ApiError(422, "invalid", f"unitsOverride must be one of {', '.join(UNITS)}.")


async def run_cleanup(data: bytes, tolerance_mm: float, units_override: str | None):
    try:
        return await run_in_threadpool(cleanup_dxf, data, tolerance_mm, units_override)
    except DxfError as exc:  # includes EmptyDrawing
        code = "dxf_empty" if type(exc).__name__ == "EmptyDrawing" else "dxf_unreadable"
        raise ApiError(422, code, str(exc)) from exc


@router.post("/dxf/cleanup")
async def dxf_cleanup(
    file: UploadFile = File(...),
    toleranceMm: float = Form(0.01),
    unitsOverride: str | None = Form(None),
    _: Principal = Depends(require("pupil")),
    cfg: Settings = Depends(get_settings),
):
    check_options(toleranceMm, unitsOverride)
    out = await run_cleanup(await read_upload(file, cfg), toleranceMm, unitsOverride)
    return {"objects": out.objects, "report": out.report, "units": out.units}
