"""Live detection service (paper Algorithm 1, EveryMinute).

Rules R1-R3 RAISE alerts (itinerary-aware, primary detector). The Isolation Forest never raises an alert
on its own; it only gives each alert a priority score so the control room can rank them. That is the
paper's own recommendation after the matched/shifted comparison.
"""
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import joblib
import numpy as np
from sqlmodel import Session, select

from .. import anomaly_state, events
from ..config import settings
from .. import settings_store
from ..geo.engine import Projection
from ..models import Alert, Fix, Itinerary, RevocationEntry, Tourist
from .detectors import Alerting, Forest, features_series, rule_flags
from .evaluate import train_forest
from .simulator import make_pois

KINDS = ("dropoff", "inactivity", "deviation")
RULE_NAMES = ("R1", "R2", "R3")
STALE_H = 12

_model: Forest | None = None
_state: dict[int, Alerting] = {}
_hour_scores: dict[int, list[tuple[float, float]]] = {}   # tourist -> [(minute, priority)]


def _model_path() -> Path:
    return Path(settings.models_dir) / "forest.joblib"


def load_model() -> Forest | None:
    global _model
    p = _model_path()
    if p.exists():
        _model = joblib.load(p)
    return _model


def train_and_save(n_train: int = 300, n_val: int = 100, seed: int = 0) -> Forest:
    """Train on simulated normal days (no real data exists yet) and persist."""
    global _model
    rng = np.random.default_rng(seed)
    forest, _ = train_forest(rng, make_pois(rng), n_train, n_val, seed)
    _model_path().parent.mkdir(parents=True, exist_ok=True)
    joblib.dump(forest, _model_path())
    _model = forest
    return forest


def reset_state() -> None:
    global _model
    _model = None
    _state.clear()
    _hour_scores.clear()


def _aware(d: datetime) -> datetime:
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _itinerary_xy(it: Itinerary | None, first_fix: Fix):
    route = json.loads(it.route_json) if it else []
    stops = json.loads(it.stops_json) if it else []
    hotel = next((s for s in stops if s.get("hotel")), stops[0] if stops else None)
    origin = (hotel["lat"], hotel["lon"]) if hotel else (first_fix.lat, first_fix.lon)
    proj = Projection(*origin)
    stop_xy = [proj.to_xy(s["lat"], s["lon"]) for s in stops] or [proj.to_xy(*origin)]
    if hotel:                                  # hotel must be stops[0]
        h = proj.to_xy(hotel["lat"], hotel["lon"])
        stop_xy = [h] + [p for p in stop_xy if p != h]
    route_xy = [proj.to_xy(*p) for p in route] or stop_xy
    return proj, np.array(route_xy, float), np.array(stop_xy, float)


def evaluate_tourist(session: Session, tourist: Tourist, now: datetime):
    """Returns (raw_features_last_row, flags(3,), priority) or None when there is nothing to judge."""
    since = now - timedelta(hours=STALE_H)
    fixes = session.exec(select(Fix).where(Fix.tourist_id == tourist.id, Fix.ts >= since)
                         .order_by(Fix.ts)).all()
    if not fixes:
        return None
    it = session.exec(select(Itinerary).where(Itinerary.tourist_id == tourist.id)).first()
    proj, route, stops = _itinerary_xy(it, fixes[0])
    t0 = _aware(fixes[0].ts)
    n = int((now - t0).total_seconds() // 60) + 1
    obs = np.full((max(n, 1), 2), np.nan)
    for f in fixes:
        m = int((_aware(f.ts) - t0).total_seconds() // 60)
        if 0 <= m < n:
            obs[m] = proj.to_xy(f.lat, f.lon)
    p = settings_store.get(session)
    raw = features_series(obs, route, stops, r3_minutes=p.r3_minutes)
    last = raw[-1:]
    flags = rule_flags(last, p)[0]
    prio = None
    if _model is not None:
        prio = float(min(_model.score(last)[0] / _model.threshold, 1.5) / 1.5)
    return last[0], flags, prio


def run_once(session: Session, now: datetime | None = None) -> list[Alert]:
    now = _aware(now) if now else datetime.now(timezone.utc)
    minute = now.timestamp() / 60.0
    created: list[Alert] = []
    tourists = session.exec(select(Tourist).where(Tourist.id_code != None)).all()  # noqa: E711
    revoked = {e.id_code for e in session.exec(select(RevocationEntry)).all()}
    for t in tourists:
        if t.valid_to and _aware(t.valid_to) < now or t.valid_from and _aware(t.valid_from) > now:
            continue
        if t.id_code in revoked:           # a revoked ID is no longer monitored
            continue
        res = evaluate_tourist(session, t, now)
        if res is None:
            continue
        raw, flags, prio = res
        hist = _hour_scores.setdefault(t.id, [])
        if prio is not None:
            hist.append((minute, prio))
        hist[:] = [(m, p) for m, p in hist if minute - m <= 60]
        a_term = max((p for _, p in hist), default=0.0)

        st = _state.setdefault(t.id, Alerting())
        st.cooldown = settings_store.get(session).cooldown_min
        fired = st.step(minute, bool(flags.any()), False)   # forest never raises on its own
        if fired:
            i = int(np.argmax(flags))
            last_fix = session.exec(select(Fix).where(Fix.tourist_id == t.id).order_by(Fix.ts.desc())).first()
            detail = {0: f"No location for {raw[0]:.0f} min",
                      1: f"Stationary {raw[3]:.0f} min, {raw[2]:.0f} m from nearest planned stop",
                      2: f"More than 1 km from planned route ({raw[1]:.0f} m)"}[i]
            alert = Alert(tourist_id=t.id, kind=KINDS[i], detail=detail, rule=RULE_NAMES[i], score=prio,
                          lat=last_fix.lat if last_fix else None, lon=last_fix.lon if last_fix else None)
            session.add(alert)
            session.commit()
            session.refresh(alert)
            events.publish(alert)
            created.append(alert)
            a_term = 1.0
        anomaly_state.set_recent_anomaly(t.id, a_term)
    return created
