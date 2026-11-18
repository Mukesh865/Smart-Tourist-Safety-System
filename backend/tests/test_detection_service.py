from datetime import datetime, timedelta, timezone

from sqlmodel import Session, select

from app import anomaly_state, db as appdb, events
from app.detect import service
from app.models import Alert, Fix, Tourist
from tests.test_ledger_api import H, issue_body, setup_users, token
from tests.test_zones_location_api import ll

BASE = datetime(2026, 6, 1, 9, 0, tzinfo=timezone.utc)


def setup(client, **over):
    off, tour, adm = setup_users(client)
    body = issue_body(route=[list(ll(0, 0)), list(ll(5000, 0))],
                      stops=[{"name": "Hotel", "lat": ll(0, 0)[0], "lon": ll(0, 0)[1], "hotel": True},
                             {"name": "View", "lat": ll(2500, 0)[0], "lon": ll(2500, 0)[1], "hotel": False}],
                      **over)
    assert client.post("/api/ledger/issue", json=body, headers=H(off)).status_code == 201
    client.post("/api/auth/staff", headers=H(adm), json={"email": "p@x.com", "full_name": "Pol",
                "password": "password123", "role": "police"})
    with Session(appdb.engine) as s:
        tid = s.exec(select(Tourist)).first().id
    return tid, tour, token(client, "p@x.com")


def put(tid, pts):
    """pts: [(minute_offset, x_m, y_m)] -> Fix rows"""
    with Session(appdb.engine) as s:
        for m, x, y in pts:
            lat, lon = ll(x, y)
            s.add(Fix(tourist_id=tid, lat=lat, lon=lon, accuracy=5, ts=BASE + timedelta(minutes=m)))
        s.commit()


def run(at_min):
    with Session(appdb.engine) as s:
        return service.run_once(s, BASE + timedelta(minutes=at_min))


def alerts():
    with Session(appdb.engine) as s:
        return s.exec(select(Alert).order_by(Alert.id)).all()


def test_normal_walk_no_alerts(client):
    tid, _, _ = setup(client)
    put(tid, [(m, m * 20.0, 5.0) for m in range(120)])
    assert all(run(m) == [] for m in (30, 60, 119))
    assert alerts() == []


def test_dropoff_alert_after_20_min_silence_and_cooldown(client):
    tid, _, _ = setup(client)
    put(tid, [(m, m * 20.0, 0.0) for m in range(30)])
    assert run(45) == []                        # 16 min silent, still fine
    got = run(51)                               # 22 min silent
    assert len(got) == 1 and got[0].kind == "dropoff" and got[0].rule == "R1"
    assert "No location" in got[0].detail and got[0].lat is not None
    assert run(52) == [] and run(100) == []      # 60-minute cool-down
    assert len(run(112)) == 1                    # silence continues, cool-down over -> re-alert


def test_deviation_alert_over_1km_for_10_min(client):
    tid, _, _ = setup(client)
    put(tid, [(m, m * 20.0, 0.0) for m in range(20)] + [(m, 400.0, 1800.0) for m in range(20, 40)])
    assert run(25) == []
    got = run(32)
    assert [a.kind for a in got] == ["deviation"] and got[0].rule == "R3"


def test_inactivity_alert_when_stuck_away_from_stops(client):
    tid, _, _ = setup(client)
    put(tid, [(m, 1200.0 + (m % 3), 300.0) for m in range(60)])   # parked 600+ m from route/stops
    assert run(30) == []
    got = run(55)
    assert [a.kind for a in got] == ["inactivity"] and got[0].rule == "R2"


def test_stale_and_expired_tourists_are_skipped(client):
    tid, _, _ = setup(client)
    put(tid, [(m, 0.0, 0.0) for m in range(5)])
    assert run(13 * 60) == []                         # last fix 13 h ago: stale
    with Session(appdb.engine) as s:
        t = s.get(Tourist, tid)
        t.valid_to = BASE - timedelta(days=1)
        s.add(t)
        s.commit()
    assert run(60) == []                              # ID expired: not monitored


def test_alert_published_to_subscribers(client):
    tid, _, _ = setup(client)
    got = []
    events.subscribe(got.append)
    put(tid, [(m, m * 20.0, 0.0) for m in range(30)])
    run(55)
    assert len(got) == 1 and got[0]["kind"] == "dropoff"


def test_forest_only_ranks_and_never_raises(client):
    tid, _, _ = setup(client)
    service.train_and_save(n_train=40, n_val=20)
    assert service._model is not None
    put(tid, [(m, m * 20.0, 5.0) for m in range(120)])
    assert run(119) == []                             # a normal walk stays silent even with the forest on
    got = run(150)                                    # 31 min silent after the last fix -> R1
    assert len(got) == 1 and got[0].score is not None and 0.0 <= got[0].score <= 1.0


def test_no_model_alert_has_no_score(client):
    tid, _, _ = setup(client)
    put(tid, [(m, m * 20.0, 0.0) for m in range(30)])
    got = run(55)
    assert got[0].score is None


def test_model_persists_and_loads(client):
    service.train_and_save(n_train=30, n_val=10)
    thr = service._model.threshold
    service.reset_state()
    assert service._model is None
    assert service.load_model().threshold == thr


def test_anomaly_term_lowers_safety_score(client):
    tid, tour, _ = setup(client)
    client.post("/api/location", json={"lat": ll(0, 0)[0], "lon": ll(0, 0)[1]}, headers=H(tour))
    before = client.get("/api/me/score", headers=H(tour)).json()
    assert before["a"] == 0
    put(tid, [(m, m * 20.0, 0.0) for m in range(30)])
    run(55)                                           # raises R1 alert -> A = 1
    after = client.get("/api/me/score", headers=H(tour)).json()
    assert after["a"] == 1.0
    assert before["score"] - after["score"] == 30.0   # 0.3 * 100 weight on A
    anomaly_state._recent.clear()


def test_detection_endpoints_and_roles(client):
    tid, tour, pol = setup(client)
    assert client.post("/api/detection/run", headers=H(tour)).status_code == 403
    assert client.get("/api/detection/status", headers=H(tour)).status_code == 403
    st = client.get("/api/detection/status", headers=H(pol)).json()
    assert st["model_loaded"] is False
    assert client.post("/api/detection/run", headers=H(pol)).json() == {"created": []}
