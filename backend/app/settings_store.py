"""Loads/saves the calibrated parameters. The current value is cached in memory (read on every fix and every minute)
and refreshed whenever an admin saves; tests reset it with invalidate()."""
import json
from threading import Lock

from sqlmodel import Session

from .detect.params import DEFAULTS, Params, to_dict, validate
from .models import SystemSettings

_cache: Params | None = None
_lock = Lock()


def invalidate() -> None:
    global _cache
    with _lock:
        _cache = None


def get(session: Session) -> Params:
    global _cache
    with _lock:
        if _cache is None:
            row = session.get(SystemSettings, 1)
            try:
                _cache = validate(json.loads(row.values_json)) if row else DEFAULTS
            except (ValueError, TypeError):
                _cache = DEFAULTS          # a corrupt row must never stop detection: fall back to the paper's values
        return _cache


def save(session: Session, values: dict, user_id: int) -> Params:
    p = validate(values)
    row = session.get(SystemSettings, 1) or SystemSettings(id=1)
    changed = {k: v for k, v in to_dict(p).items() if v != getattr(DEFAULTS, k)}   # store only differences from the defaults
    row.values_json = json.dumps(changed)
    row.updated_by = user_id
    session.add(row)
    session.commit()
    invalidate()
    from .geo import manager
    manager.invalidate()                   # rebuild the geo engine with the new k / buffer / ring
    return p
