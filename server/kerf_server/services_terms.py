"""A school's terms: which parts of Kerf it has and its limits (docs/ACCOUNTS.md, "Terms").

A paid school (or one from before plans, `plan` NULL) has everything with no limits. A free school has its own **terms**,
a copy of Kerf's default terms made when it registered: later changes to the default never touch a school that already
has its terms. The site admin edits the default and any one school's terms.

Terms are a base (features + limits) plus **grants**: extras for a while, e.g. "3 months of everything" or "the laser for
10 groups for 12 months". In the default a grant lasts `months` from registration; copied to a school it gets dates.

    {"features": {"laser": false, "activities": false},
     "limits": {"groupsPerSchool": 20, "pupilsPerGroup": 50, "filesPerPupil": 20, "laserGroups": null},
     "grants": [{"label": "Trial", "months": 3, "features": {"laser": true, "activities": true}, "limits": {"groupsPerSchool": null}}]}

A limit of null is no limit. `laserGroups` limits how many groups may send files to the laser (the school admin picks them,
`SchoolClass.laser`); null: every group may.
"""
from __future__ import annotations

import calendar
import copy
from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from .db import as_utc, iso, utcnow
from .errors import ApiError
from .models import PlatformSetting, School

FEATURES = ("laser", "activities")
LIMITS = ("groupsPerSchool", "pupilsPerGroup", "filesPerPupil", "laserGroups")
FEATURE_TEXT = {"laser": "sending files to the laser (the queue, approval, Station pages, the camera)", "activities": "activities and teacher feedback"}
LIMIT_TEXT = {"filesPerPupil": "files per pupil", "groupsPerSchool": "groups in a school", "pupilsPerGroup": "pupils in a group", "laserGroups": "groups that send to the laser"}
#: What Kerf starts with until the site admin changes the default (the free tools, owner 2026-11-23).
BUILT_IN: dict[str, Any] = {"features": {"laser": False, "activities": False},
                            "limits": {"groupsPerSchool": 20, "pupilsPerGroup": 50, "filesPerPupil": 20, "laserGroups": None}, "grants": []}
EVERYTHING = {"features": {f: True for f in FEATURES}, "limits": {k: None for k in LIMITS}}
DEFAULT_KEY = "default_terms"


def add_months(t: datetime, months: int) -> datetime:
    y, m = divmod(t.month - 1 + months, 12)
    y, m = t.year + y, m + 1
    return t.replace(year=y, month=m, day=min(t.day, calendar.monthrange(y, m)[1]))


def _when(v: Any, field: str) -> str | None:
    if v in (None, ""):
        return None
    try:
        return iso(as_utc(datetime.fromisoformat(str(v).replace("Z", "+00:00"))))
    except ValueError:
        raise ApiError(422, "invalid", f"{field} is a date, e.g. 2027-09-01.") from None


def _part(doc: Any, where: str) -> tuple[dict[str, bool], dict[str, int | None]]:
    if doc is None:
        doc = {}
    if not isinstance(doc, dict):
        raise ApiError(422, "invalid", f"{where} is an object.")
    feats, lims = doc.get("features") or {}, doc.get("limits") or {}
    if not isinstance(feats, dict) or not isinstance(lims, dict):
        raise ApiError(422, "invalid", f"{where}: features and limits are objects.")
    out_f: dict[str, bool] = {}
    for k, v in feats.items():
        if k not in FEATURES or not isinstance(v, bool):
            raise ApiError(422, "invalid", f"{where}: features are {', '.join(FEATURES)}, each true or false.")
        out_f[k] = v
    out_l: dict[str, int | None] = {}
    for k, v in lims.items():
        if k not in LIMITS or not (v is None or (isinstance(v, int) and not isinstance(v, bool) and 0 <= v <= 100000)):
            raise ApiError(422, "invalid", f"{where}: limits are {', '.join(LIMITS)}, each a whole number or null (no limit).")
        out_l[k] = v
    return out_f, out_l


def clean(doc: Any, default: bool) -> dict[str, Any]:
    """Checked terms. In the default a grant has `months`; in a school's terms it has `from` and `until` (either may be left
    out: from now, or for good)."""
    if not isinstance(doc, dict):
        raise ApiError(422, "invalid", "Send the terms as an object with features, limits and grants.")
    f, l = _part(doc, "terms")
    base = {"features": {k: f.get(k, False) for k in FEATURES}, "limits": {k: l.get(k, BUILT_IN["limits"][k]) for k in LIMITS}}
    grants = doc.get("grants") or []
    if not isinstance(grants, list) or len(grants) > 20:
        raise ApiError(422, "invalid", "grants is a list (up to 20).")
    out = []
    for i, g in enumerate(grants):
        gf, gl = _part(g, f"grant {i + 1}")
        label = str(g.get("label") or "").strip()[:80] or f"Grant {i + 1}"
        item: dict[str, Any] = {"label": label, "features": gf, "limits": gl}
        if default:
            m = g.get("months")
            if not isinstance(m, int) or isinstance(m, bool) or not 1 <= m <= 120:
                raise ApiError(422, "invalid", f"grant {i + 1}: months is a whole number from 1 to 120.")
            item["months"] = m
        else:
            item["from"], item["until"] = _when(g.get("from"), f"grant {i + 1} from"), _when(g.get("until"), f"grant {i + 1} until")
        out.append(item)
    return {**base, "grants": out}


def get_default(s: Session) -> dict[str, Any]:
    row = s.get(PlatformSetting, DEFAULT_KEY)
    return copy.deepcopy(row.value) if row is not None else copy.deepcopy(BUILT_IN)


def set_default(s: Session, doc: Any) -> dict[str, Any]:
    terms = clean(doc, default=True)
    row = s.get(PlatformSetting, DEFAULT_KEY)
    if row is None:
        s.add(PlatformSetting(key=DEFAULT_KEY, value=terms))
    else:
        row.value = terms
    return terms


def snapshot(default: dict[str, Any], now: datetime | None = None) -> dict[str, Any]:
    """The default as a school's own terms: each grant's months become dates from now."""
    now = now or utcnow()
    out = copy.deepcopy(default)
    out["grants"] = [{"label": g["label"], "features": g.get("features", {}), "limits": g.get("limits", {}),
                      "from": iso(now), "until": iso(add_months(now, int(g.get("months", 1))))} for g in default.get("grants", [])]
    return out


def ensure_terms(s: Session) -> None:
    """Free schools without terms (made before terms existed) get a copy of the current default (start-up)."""
    from sqlalchemy import select

    for row in s.scalars(select(School).where(School.plan == "free", School.terms.is_(None))):
        row.terms = snapshot(get_default(s), as_utc(row.created_at) if row.created_at else None)


def _active(g: dict[str, Any], now: datetime) -> bool:
    start, end = g.get("from"), g.get("until")
    return (start is None or as_utc(datetime.fromisoformat(start.replace("Z", "+00:00"))) <= now) and (
        end is None or now < as_utc(datetime.fromisoformat(end.replace("Z", "+00:00"))))


def effective(row: School | None, now: datetime | None = None) -> dict[str, Any]:
    """What the school has right now: `{features, limits, grants: [active grant labels and ends], paid}`."""
    if row is None or row.plan != "free":
        return {**copy.deepcopy(EVERYTHING), "grants": [], "paid": True}
    now = now or utcnow()
    terms = row.terms or BUILT_IN
    feats = {k: bool(terms.get("features", {}).get(k, False)) for k in FEATURES}
    lims: dict[str, int | None] = {k: terms.get("limits", {}).get(k, BUILT_IN["limits"][k]) for k in LIMITS}
    active = [g for g in terms.get("grants", []) if _active(g, now)]
    for g in active:
        for k, v in (g.get("features") or {}).items():
            feats[k] = feats.get(k, False) or bool(v)
        for k, v in (g.get("limits") or {}).items():
            if k in lims and lims[k] is not None:
                lims[k] = None if v is None else max(lims[k], v)  # type: ignore[type-var]
    return {"features": feats, "limits": lims, "grants": [{"label": g["label"], "until": g.get("until")} for g in active], "paid": False}


def of(s: Session, school_id: str | None) -> dict[str, Any]:
    return effective(s.get(School, school_id) if school_id else None)


def has(s: Session, school_id: str | None, feature: str) -> bool:
    return bool(of(s, school_id)["features"].get(feature))


def require(s: Session, school_id: str | None, feature: str) -> None:
    if not has(s, school_id, feature):
        raise ApiError(403, "paid_feature", f"Your school's plan does not include {FEATURE_TEXT[feature]}. Your school's admin can ask Kerf about it.")


def limit(s: Session, school_id: str | None, key: str) -> int | None:
    return of(s, school_id)["limits"].get(key)


def check_limit(s: Session, school_id: str | None, key: str, current: int, adding: int = 1) -> None:
    """409 `limit_reached` when the school would go over one of its limits."""
    cap = limit(s, school_id, key)
    if cap is None or current + adding <= cap:
        return
    raise ApiError(409, "limit_reached", f"Your school's plan allows up to {cap} {LIMIT_TEXT[key]}"
                   + (f" (this would make {current + adding})." if adding > 1 else "."), [{"limit": key, "max": cap, "current": current}])


def set_school_terms(s: Session, school_id: str, doc: Any) -> School:
    row = s.get(School, school_id)
    if row is None:
        raise ApiError(404, "not_found", f"There is no school '{school_id}'.")
    row.terms = clean(doc, default=False)
    return row


def terms_doc(row: School) -> dict[str, Any]:
    return {"plan": "paid" if row.plan != "free" else "free", "terms": row.terms, "now": effective(row)}
