"""First-run data: the placeholder material presets and the placeholder machine profiles from shared/."""
from __future__ import annotations

import json
from importlib import resources
from pathlib import Path

from sqlalchemy import select

from .config import Settings
from .db import Database
from .models import MachineRow, PresetRow


def seed(db: Database, settings: Settings) -> None:
    presets = json.loads(resources.files("kerf_server").joinpath("seed/presets.json").read_text())
    machine_dir = Path(settings.shared_dir) / "machine-profiles"
    with db.session() as s:
        for p in presets:
            if s.get(PresetRow, (p["id"], p["version"])) is None and s.scalar(select(PresetRow).where(PresetRow.id == p["id"])) is None:
                s.add(PresetRow(id=p["id"], version=p["version"], data=p, updated_by="seed"))
        if machine_dir.exists():
            for f in sorted(machine_dir.glob("*.json")):
                m = json.loads(f.read_text())
                if s.get(MachineRow, m["id"]) is None:
                    s.add(MachineRow(id=m["id"], data=m))
