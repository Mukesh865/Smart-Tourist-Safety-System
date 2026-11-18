import random
from datetime import datetime, timedelta, timezone

from sqlmodel import Session, select

from app import db as appdb, events
from app.config import settings
from app.models import Alert, Fix, OffchainPII
from tests.test_ledger_api import H, PHONE, setup_users, token
from tests.test_zones_location_api import full_setup, ll, zone_body


def iso(dt):
    return dt.isoformat().replace("+00:00", "Z")


def fix_at(minutes_ago, x, y, now=None):
    now = now or datetime.now(timezone.utc)
    lat, lon = ll(x, y)
    return {"lat": lat, "lon": lon, "accuracy": 5, "ts": iso(now - timedelta(minutes=minutes_ago))}


def batch(c, tour, fixes):
    return c.post("/api/location/batch", json={"fixes": fixes}, headers=H(tour))


def fix_rows():
    with Session(appdb.engine) as s:
        return s.exec(select(Fix).order_by(Fix.ts)).all()


# ------------------------------------------------------------------ offline replay
def test_batch_replay_is_processed_oldest_first_and_raises_the_zone_alert(client):
    tour, adm, pol = full_setup(client)
    client.post("/api/zones", json=zone_body(), headers=H(adm))
    # three fixes deep inside the zone, sent in shuffled order: the engine must still see them in time order
    fixes = [fix_at(m, 0, 0) for m in (5, 3, 1)]
    random.Random(1).shuffle(fixes)
    r = batch(client, tour, fixes).json()
    assert r["accepted"] == 3 and r["duplicates"] == 0 and r["rejected"] == 0
    assert [a["kind"] for a in r["alerts"]] == ["zone_entry"]                 # k=3 consecutive fixes -> exactly one alert
    ts = [f.ts for f in fix_rows()]
    assert ts == sorted(ts)


def test_batch_retry_is_idempotent(client):
    tour, _, _ = full_setup(client)
    fixes = [fix_at(m, 100 * m, 0) for m in (9, 8, 7)]
    assert batch(client, tour, fixes).json()["accepted"] == 3
    again = batch(client, tour, fixes).json()
    assert again["accepted"] == 0 and again["duplicates"] == 3
    assert len(fix_rows()) == 3


def test_single_fix_with_same_device_time_is_not_stored_twice(client):
    tour, _, _ = full_setup(client)
    f = fix_at(2, 0, 0)
    assert client.post("/api/location", json=f, headers=H(tour)).status_code == 200
    assert client.post("/api/location", json=f, headers=H(tour)).status_code == 200
    assert len(fix_rows()) == 1


def test_too_old_and_future_timestamps(client):
    tour, _, _ = full_setup(client)
    old = fix_at(49 * 60, 0, 0)
    future = fix_at(-60, 0, 0)                                              # an hour in the future (clock skew)
    r = batch(client, tour, [old, future, fix_at(1, 0, 0)]).json()
    assert r["rejected"] == 1 and r["accepted"] == 2
    stored = [f.ts.replace(tzinfo=timezone.utc) for f in fix_rows()]
    assert max(stored) <= datetime.now(timezone.utc) + timedelta(seconds=5)   # the future time was clamped to "now"
    assert client.post("/api/location", json=old, headers=H(tour)).status_code == 422


def test_batch_validation_roles_and_rate_limit(client, monkeypatch):
    off, tour, adm = setup_users(client)
    assert batch(client, tour, [fix_at(1, 0, 0)]).status_code == 403          # no ID yet
    tour, _, _ = full_setup(client)
    assert client.post("/api/location/batch", json={"fixes": []}, headers=H(tour)).status_code == 422
    assert client.post("/api/location/batch", json={"fixes": [fix_at(1, 0, 0)] * 201}, headers=H(tour)).status_code == 422
    assert client.post("/api/location/batch", json={"fixes": [fix_at(1, 0, 0)]}).status_code == 401
    monkeypatch.setattr(settings, "rate_limit_enabled", True)
    codes = [batch(client, tour, [fix_at(m + 10, 0, 0)]).status_code for m in range(12)]
    assert codes[:10] == [200] * 10 and codes[10:] == [429, 429]


def test_batch_of_200_fixes_is_fast_enough(client):
    import time
    tour, _, _ = full_setup(client)
    fixes = [fix_at(300 - m, m * 5, 0) for m in range(200)]
    t0 = time.perf_counter()
    r = batch(client, tour, fixes).json()
    assert r["accepted"] == 200 and time.perf_counter() - t0 < 20


# ------------------------------------------------------------------ panic delivery
def test_late_panic_is_labelled_and_recent_panic_is_not(client):
    tour, _, pol = full_setup(client)
    late = datetime.now(timezone.utc) - timedelta(minutes=20)
    client.post("/api/panic", json={"ts": iso(late)}, headers=H(tour))
    client.post("/api/panic", json={"ts": iso(datetime.now(timezone.utc) - timedelta(seconds=10))}, headers=H(tour))
    details = [a["detail"] for a in client.get("/api/alerts?kind=panic", headers=H(pol)).json()]
    assert sum("delivered late" in d for d in details) == 1


def test_cancel_accidental_panic(client):
    tour, _, pol = full_setup(client)
    got = []
    events.subscribe(got.append)
    aid = client.post("/api/panic", json={}, headers=H(tour)).json()["alert_id"]
    r = client.post(f"/api/panic/{aid}/cancel", headers=H(tour))
    assert r.status_code == 200 and r.json()["status"] == "resolved"
    assert got[-1]["id"] == aid and got[-1]["status"] == "resolved"           # the dashboard is told
    mine = client.get("/api/alerts/mine", headers=H(tour)).json()[0]
    assert mine["resolution"] == "cancelled_by_user" and "accidental" in mine["detail"]
    queue = client.get("/api/dashboard/alerts", headers=H(pol)).json()
    assert queue == []                                                         # resolved alerts leave the control-room queue
    assert client.post(f"/api/panic/{aid}/cancel", headers=H(tour)).status_code == 409     # cannot cancel twice


def test_cannot_cancel_once_the_control_room_acknowledged(client):
    tour, _, pol = full_setup(client)
    aid = client.post("/api/panic", json={}, headers=H(tour)).json()["alert_id"]
    client.patch(f"/api/alerts/{aid}", json={"status": "acknowledged"}, headers=H(pol))
    r = client.post(f"/api/panic/{aid}/cancel", headers=H(tour))
    assert r.status_code == 409 and "control room" in r.json()["detail"]
    assert client.get("/api/alerts/mine", headers=H(tour)).json()[0]["status"] == "acknowledged"   # the app can show it


def test_cancel_window_and_ownership(client):
    tour, _, pol = full_setup(client)
    aid = client.post("/api/panic", json={}, headers=H(tour)).json()["alert_id"]
    with Session(appdb.engine) as s:
        a = s.get(Alert, aid)
        a.created_at = datetime.now(timezone.utc) - timedelta(minutes=11)
        s.add(a)
        s.commit()
    assert client.post(f"/api/panic/{aid}/cancel", headers=H(tour)).status_code == 409
    client.post("/api/auth/register", json={"email": "other@x.com", "full_name": "O", "password": "password123"})
    other = token(client, "other@x.com")
    assert client.post(f"/api/panic/{aid}/cancel", headers=H(other)).status_code == 404
    assert client.post("/api/panic/999/cancel", headers=H(tour)).status_code == 404
    assert client.post(f"/api/panic/{aid}/cancel", headers=H(pol)).status_code == 403
    with Session(appdb.engine) as s:                                          # only panic alerts can be cancelled
        z = Alert(tourist_id=1, kind="zone_entry", detail="z")
        s.add(z)
        s.commit()
        zid = z.id
    assert client.post(f"/api/panic/{zid}/cancel", headers=H(tour)).status_code == 404


# ------------------------------------------------------------------ trip + contacts
def test_trip_and_contacts_for_the_tourist(client):
    tour, _, pol = full_setup(client)
    trip = client.get("/api/me/trip", headers=H(tour)).json()
    assert [s["name"] for s in trip["stops"]] == ["Hotel"] and len(trip["route"]) == 2 and trip["valid_to"]
    c = client.get("/api/me/contacts", headers=H(tour)).json()["contacts"]
    assert c == [{"name": "Mom", "phone": PHONE}]
    for who in (pol,):
        assert client.get("/api/me/trip", headers=H(who)).status_code == 403
        assert client.get("/api/me/contacts", headers=H(who)).status_code == 403
    assert client.get("/api/me/contacts").status_code == 401


def test_contacts_empty_after_erasure(client):
    tour, _, _ = full_setup(client)
    with Session(appdb.engine) as s:
        for r in s.exec(select(OffchainPII)).all():
            s.delete(r)
        s.commit()
    assert client.get("/api/me/contacts", headers=H(tour)).json() == {"contacts": []}
