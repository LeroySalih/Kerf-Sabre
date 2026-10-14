"""First-run data: the default school, the placeholder material presets and the placeholder machine profiles from shared/."""
from __future__ import annotations

import json
from importlib import resources
from pathlib import Path

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from .config import Settings
from .db import Database
from .models import DEFAULT_SCHOOL, Job, MachineRow, PresetRow, School, SchoolClass, Token


def seed_presets(s: Session, school: str) -> None:
    """Give a school the placeholder material list (once: a school that already has any is left alone)."""
    if s.scalar(select(PresetRow).where(PresetRow.school_id == school).limit(1)) is not None:
        return
    for p in json.loads(resources.files("kerf_server").joinpath("seed/presets.json").read_text()):
        s.add(PresetRow(school_id=school, id=p["id"], version=p["version"], data=p, updated_by="seed"))


def seed(db: Database, settings: Settings) -> None:
    machine_dir = Path(settings.shared_dir) / "machine-profiles"
    with db.session() as s:
        if s.get(School, DEFAULT_SCHOOL) is None:
            s.add(School(id=DEFAULT_SCHOOL, name="Main school"))
            s.flush()
        # data made before schools existed all belongs to the default school
        for model in (SchoolClass, Job, MachineRow):
            s.execute(update(model).where(model.school_id.is_(None)).values(school_id=DEFAULT_SCHOOL))
        s.execute(update(Token).where(Token.school_id.is_(None), Token.role != "platform").values(school_id=DEFAULT_SCHOOL))
        seed_presets(s, DEFAULT_SCHOOL)
        if machine_dir.exists():
            for f in sorted(machine_dir.glob("*.json")):
                m = json.loads(f.read_text())
                if s.get(MachineRow, m["id"]) is None:
                    s.add(MachineRow(id=m["id"], school_id=DEFAULT_SCHOOL, data=m))
