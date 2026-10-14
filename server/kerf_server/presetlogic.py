"""A preset resolved for one laser: base values with that laser's overrides applied (brief section 6)."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class Operation:
    power_pct: float
    speed_mm_s: float
    passes: int
    air: bool
    dash_mm: float = 0.0  # 0 = solid line


@dataclass(frozen=True)
class ResolvedPreset:
    preset_id: str
    version: int
    material: str
    thickness_mm: float
    kerf_mm: float
    cut: Operation
    score: Operation
    #: True when no test grid has been run for this material on this laser.
    untested: bool

    def op(self, layer: str) -> Operation:
        return self.cut if layer == "cut" else self.score


def _op(base: dict[str, Any], patch: dict[str, Any] | None) -> Operation:
    d = {**base, **(patch or {})}
    return Operation(float(d["powerPct"]), float(d["speedMmPerS"]), int(d["passes"]), bool(d["airAssist"]), float(d.get("dashMm") or 0.0))


def resolve(preset: dict[str, Any], machine_id: str | None) -> ResolvedPreset:
    o = (preset.get("laserOverrides") or {}).get(machine_id or "", {})
    return ResolvedPreset(
        preset_id=preset["id"],
        version=int(preset["version"]),
        material=preset["material"],
        thickness_mm=float(preset["thicknessMm"]),
        kerf_mm=float(o.get("kerfMm", preset["kerfMm"])),
        cut=_op(preset["cut"], o.get("cut")),
        score=_op(preset["score"], o.get("score")),
        untested=machine_id is None or machine_id not in (preset.get("testedOn") or []),
    )
