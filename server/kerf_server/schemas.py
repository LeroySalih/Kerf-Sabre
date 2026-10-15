"""JSON-schema validation against the shared contract (shared/*.schema.json)."""
from __future__ import annotations

import json
import re
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


_SERIES = re.compile(r"^(\d+\.\d+)\.\d+$")


def _same_series(doc: Any, current: str) -> Any:
    """Every 0.2.x change to shared/ is additive, so an Editor page a few versions behind (a cached tab, a PC that was not updated) still
    saves: its schemaVersion is treated as the current one if only the last number differs. A different 0.N or a major version is still refused."""
    if isinstance(doc, dict) and isinstance(doc.get("schemaVersion"), str):
        a, b = _SERIES.match(doc["schemaVersion"]), _SERIES.match(current)
        if a and b and a.group(1) == b.group(1):
            return {**doc, "schemaVersion": current}
    return doc


def validate(shared_dir: Path, kind: str, doc: Any, what: str | None = None) -> None:
    """Raise a 422 ApiError listing every schema problem."""
    validator = _validator(str(shared_dir), kind)
    current = validator.schema.get("properties", {}).get("schemaVersion", {}).get("const")
    if isinstance(current, str):
        doc = _same_series(doc, current)
    errors = sorted(validator.iter_errors(doc), key=lambda e: list(e.path))
    if errors:
        details = [{"path": "/".join(str(p) for p in e.absolute_path), "message": e.message} for e in errors[:20]]
        raise ApiError(422, "invalid", f"The {what or kind} does not match the shared schema.", details)
