"""Process-wide geo-fence engine, rebuilt from the Zone table whenever zones change.
Debounce counters live in memory, so they reset on restart or zone edits (acceptable:
at worst an entry alert is delayed by k fixes)."""
import json
from threading import Lock

from sqlmodel import Session, select

from ..models import Zone
from .. import settings_store
from .engine import GeoFenceEngine

_engine: GeoFenceEngine | None = None
_lock = Lock()


def invalidate() -> None:
    global _engine
    with _lock:
        _engine = None


def get_engine(session: Session) -> GeoFenceEngine:
    global _engine
    with _lock:
        if _engine is None:
            zones = [{"id": z.id, "name": z.name, "polygon": json.loads(z.polygon_json),
                      "risk_weight": z.risk_weight, "no_entry": z.no_entry}
                     for z in session.exec(select(Zone)).all()]
            p = settings_store.get(session)
            _engine = GeoFenceEngine(zones, k=p.geo_k, b=p.geo_buffer_m, warn_ring=p.warn_ring_m)
        return _engine
