"""One error shape for the whole API: {code, message, details?} as in shared/openapi.yaml."""
from __future__ import annotations

from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, details: list[dict[str, Any]] | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details


def body(code: str, message: str, details: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {"code": code, "message": message}
    if details:
        out["details"] = details
    return out


_CODES = {400: "bad_request", 401: "unauthorized", 403: "forbidden", 404: "not_found", 405: "method_not_allowed", 409: "conflict", 413: "too_large", 422: "invalid"}


def install(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api(_: Request, exc: ApiError) -> JSONResponse:
        return JSONResponse(body(exc.code, exc.message, exc.details), status_code=exc.status)

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        return JSONResponse(body(_CODES.get(exc.status_code, "error"), str(exc.detail)), status_code=exc.status_code, headers=getattr(exc, "headers", None))

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        details = [{"path": ".".join(str(p) for p in e["loc"]), "message": e["msg"]} for e in exc.errors()]
        return JSONResponse(body("validation_error", "The request is not valid.", details), status_code=422)
