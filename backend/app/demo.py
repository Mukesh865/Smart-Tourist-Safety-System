"""Demo mode: seeded Shillong data and scripted scenarios replayed through the REAL pipeline
(`process_fix` -> geo-fence engine, then the detection service once per virtual minute)."""
import json
from datetime import datetime, timedelta, timezone

from sqlmodel import Session, select

from . import anomaly_state, events
from .detect import service as detect
from .geo import manager
from .geo.engine import Projection
from .ledger import service as ledger
from .models import Alert, AuditLog, Fix, Incident, Itinerary, Role, Tourist, User, Zone
from .routers.location import FixIn, process_fix
from .security import hash_password

HOTEL = (25.5788, 91.8933)   # Shillong, as in the paper's prototype region
PROJ = Projection(*HOTEL)
DEMO_PASSWORD = "Demo@12345"
DEMO_USERS = [("demo1@tourist.local", "Asha Demo"), ("demo2@tourist.local", "Ben Demo"),
              ("demo3@tourist.local", "Chen Demo")]


def ll(x: float, y: float) -> tuple[float, float]:
    return (HOTEL[0] + y / PROJ.ky, HOTEL[1] + x / PROJ.kx)


def _square(cx, cy, half):
    return [list(ll(cx + dx, cy + dy)) for dx, dy in ((-half, -half), (half, -half), (half, half), (-half, half))]


DEMO_ZONES = [
    {"name": "DEMO Landslide Area", "polygon": _square(1500, 700, 250), "risk_weight": 0.8, "no_entry": False},
    {"name": "DEMO Restricted Border Belt", "polygon": _square(3000, 900, 300), "risk_weight": 1.0, "no_entry": True},
]
ROUTE = [ll(0, 0), ll(4000, 0)]
STOPS = [{"name": "Hotel", "lat": HOTEL[0], "lon": HOTEL[1], "hotel": True},
         {"name": "Viewpoint", "lat": ll(2000, 0)[0], "lon": ll(2000, 0)[1], "hotel": False},
         {"name": "Waterfall", "lat": ll(4000, 0)[0], "lon": ll(4000, 0)[1], "hotel": False}]


def seed(session: Session) -> dict:
    """Idempotent: demo zones + three demo tourists with issued IDs and itineraries."""
    made_users, made_zones = 0, 0
    for z in DEMO_ZONES:
        if not session.exec(select(Zone).where(Zone.name == z["name"])).first():
            session.add(Zone(name=z["name"], polygon_json=json.dumps(z["polygon"]),
                             risk_weight=z["risk_weight"], no_entry=z["no_entry"]))
            made_zones += 1
    session.commit()
    manager.invalidate()
    now = datetime.now(timezone.utc)
    fresh = []   # (tourist, user): created now, IDs issued together in ONE block (Merkle path > 0)
    for email, name in DEMO_USERS:
        if session.exec(select(User).where(User.email == email)).first():
            continue
        u = User(email=email, full_name=name, password_hash=hash_password(DEMO_PASSWORD), role=Role.tourist)
        session.add(u)
        session.commit()
        session.refresh(u)
        t = Tourist(user_id=u.id)
        session.add(t)
        session.commit()
        session.refresh(t)
        fresh.append((t, u))
    itin = {"route": [list(p) for p in ROUTE], "stops": STOPS}
    issued = ledger.issue_many(session, [
        {"kyc": f"DEMO-KYC-{u.id:04d}", "itinerary": itin, "contacts": [{"name": "Demo Contact", "phone": "+910000000000"}],
         "t_from": int((now - timedelta(days=1)).timestamp()), "t_to": int((now + timedelta(days=7)).timestamp())}
        for _, u in fresh])
    for (t, _), (id_code, _payload) in zip(fresh, issued):
        t.id_code, t.valid_from, t.valid_to = id_code, now - timedelta(days=1), now + timedelta(days=7)
        session.add(t)
        session.add(Itinerary(tourist_id=t.id, route_json=json.dumps([list(p) for p in ROUTE]),
                              stops_json=json.dumps(STOPS)))
        made_users += 1
    session.commit()
    return {"users_created": made_users, "zones_created": made_zones,
            "demo_login": {"emails": [e for e, _ in DEMO_USERS], "password": DEMO_PASSWORD}}


def _walk(n, x0=0.0, speed=40.0, y=4.0):
    return [(m, x0 + m * speed, y) for m in range(n)]


def build_track(scenario: str) -> list[tuple[int, float, float] | None]:
    """One entry per minute: (minute, x, y) or None when the phone is silent."""
    if scenario == "normal":
        return _walk(60)
    if scenario == "dropoff":
        return _walk(30) + [None] * 35
    if scenario == "inactivity":
        return _walk(10) + [(m, 1200.0 + (m % 3), 700.0) for m in range(10, 62)]
    if scenario == "deviation":
        return _walk(15) + [(m, 600.0 + 3 * (m % 2), 1700.0) for m in range(15, 35)]
    if scenario == "zone_entry":
        # walk from the road into the landslide area (centre 1500, 700)
        return [(m, 1000.0 + m * 30.0, 700.0) for m in range(0, 25)] + [(m, 1500.0, 700.0) for m in range(25, 30)]
    if scenario == "border_warning":
        # walk north from the road towards the belt (south edge at y=600) and stop 25 m short of it
        return [(m, 3000.0, 100.0 + m * 35.0) for m in range(0, 15)] + [(m, 3000.0, 575.0) for m in range(15, 21)]
    if scenario == "panic":
        return _walk(20)
    raise ValueError(f"Unknown scenario {scenario}")


SCENARIOS = ("normal", "dropoff", "inactivity", "deviation", "zone_entry", "border_warning", "panic")


def _fresh_start(session: Session, tourist: Tourist) -> None:
    """Earlier fixes would overlap in time with the replay and hide silences, so every scenario starts
    from an empty track for that tourist. Alerts and incidents are kept so history stays visible."""
    for row in session.exec(select(Fix).where(Fix.tourist_id == tourist.id)).all():
        session.delete(row)
    session.commit()
    detect._state.pop(tourist.id, None)
    detect._hour_scores.pop(tourist.id, None)
    anomaly_state.set_recent_anomaly(tourist.id, 0.0)
    eng = manager.get_engine(session)
    for key in [k for k in eng._count if k[0] == tourist.id]:
        del eng._count[key]


def run_scenario(session: Session, tourist: Tourist, scenario: str) -> dict:
    track = build_track(scenario)
    _fresh_start(session, tourist)
    n = len(track)
    end = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    start = end - timedelta(minutes=n)
    alerts: list[dict] = []
    for m, p in enumerate(track):
        ts = start + timedelta(minutes=m)
        if p is not None:
            lat, lon = ll(p[1], p[2])
            created, _ = process_fix(session, tourist, FixIn(lat=lat, lon=lon, accuracy=5.0, ts=ts))
            alerts += [{"minute": m, "kind": a.kind, "detail": a.detail} for a in created]
        for a in detect.run_once(session, ts):
            alerts.append({"minute": m, "kind": a.kind, "detail": a.detail, "rule": a.rule})
    if scenario == "panic":
        a = Alert(tourist_id=tourist.id, kind="panic", detail=f"Panic button pressed (demo)",
                  lat=ll(*track[-1][1:])[0], lon=ll(*track[-1][1:])[1])
        session.add(a)
        session.commit()
        session.refresh(a)
        events.publish(a)
        alerts.append({"minute": n, "kind": "panic", "detail": a.detail})
    return {"scenario": scenario, "minutes": n, "alerts": alerts}


def reset(session: Session) -> dict:
    """Remove all data produced for demo tourists (fixes, alerts, incidents) and reset in-memory state."""
    ids = [t.id for t in session.exec(select(Tourist).join(User, User.id == Tourist.user_id)
                                      .where(User.email.in_([e for e, _ in DEMO_USERS]))).all()]
    removed = 0
    for model in (Fix, Alert, Incident):
        for row in session.exec(select(model).where(model.tourist_id.in_(ids))).all():
            session.delete(row)
            removed += 1
    for row in session.exec(select(AuditLog).where(AuditLog.tourist_id.in_(ids))).all():
        session.delete(row)
    session.commit()
    manager.invalidate()
    detect._state.clear()
    detect._hour_scores.clear()
    for i in ids:
        anomaly_state.set_recent_anomaly(i, 0.0)
    return {"removed": removed}
