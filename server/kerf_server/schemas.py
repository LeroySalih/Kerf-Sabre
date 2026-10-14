"""JSON-schema validation against the shared contract (shared/*.schema.json)."""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

from .errors import ApiError

_FILES = {"job": "job.schema.json", "preset": "preset.schema.json", "machine": "machine-profile.schema.json"}


@lru_cache(maxsize=None)
def _validator(shared_dir: str, kind: str) -> Draft202012Validator:
    schema = json.loads((Path(shared_dir) / _FILES[kind]).read_text())
    return Draft202012Validator(schema)


def validate(shared_dir: Path, kind: str, doc: Any, what: str | None = None) -> None:
    """Raise a 422 ApiError listing every schema problem."""
    errors = sorted(_validator(str(shared_dir), kind).iter_errors(doc), key=lambda e: list(e.path))
    if errors:
        details = [{"path": "/".join(str(p) for p in e.absolute_path), "message": e.message} for e in errors[:20]]
        raise ApiError(422, "invalid", f"The {what or kind} does not match the shared schema.", details)
