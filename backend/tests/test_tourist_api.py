import time
from datetime import datetime, timezone

from app import anomaly_state, events
from app.score import is_night, safety_score
from tests.test_ledger_api import H, PHONE, issue_body, setup_users
from tests.test_zones_location_api import full_setup, send, zone_body


def test_score_formula_and_night():
    assert safety_score(0, 0, 0) == 100
    assert safety_score(1, 1, 1) == 0
    assert safety_score(0.8, 0, 0) == 60.0
    assert safety_score(0.4, 1, 0.5) == 45.0  # 100 * (1 - 0.5*0.4 - 0.2*1 - 0.3*0.5)
    assert safety_score(5, 0, -3) == 50.0  # inputs clamped
    utc = lambda h: datetime(2026, 1, 1, h, 0, tzinfo=timezone.utc)
    assert is_night(utc(15)) == 1   # 20:30 IST
    assert is_night(utc(23)) == 1   # 04:30 IST
    assert is_night(utc(0)) == 0    # 05:30 IST
    assert is_night(utc(8)) == 0


def test_panic_uses_last_fix_and_returns_contacts(client):
    tour, adm, pol = full_setup(client)
    send(client, tour, 100, 100)
    r = client.post("/api/panic", json={}, headers=H(tour))
    assert r.status_code == 201
    body = r.json()
    assert body["lat"] is not None and body["contacts"][0]["phone"] == PHONE
    alerts = client.get("/api/alerts?kind=panic", headers=H(pol)).json()
    assert len(alerts) == 1 and alerts[0]["lat"] == body["lat"]


def test_panic_without_any_fix_still_raises_alert(client):
    tour, _, pol = full_setup(client)
    assert client.post("/api/panic", json={}, headers=H(tour)).status_code == 201
    a = client.get("/api/alerts", headers=H(pol)).json()[0]
    assert a["kind"] == "panic" and a["lat"] is None


def test_panic_explicit_coords_and_validation(client):
    tour, _, _ = full_setup(client)
    assert client.post("/api/panic", json={"lat": 25.5, "lon": 91.8}, headers=H(tour)).json()["lat"] == 25.5
    assert client.post("/api/panic", json={"lat": 99, "lon": 0}, headers=H(tour)).status_code == 422


def test_panic_roles(client):
    off, tour, adm = setup_users(client)
    assert client.post("/api/panic", json={}).status_code == 401
    assert client.post("/api/panic", json={}, headers=H(off)).status_code == 403


def test_panic_reaches_subscribers_within_10s(client):
    """Paper Table V: panic alert to dashboard < 10 s (server-side part)."""
    tour, _, _ = full_setup(client)
    got = []
    events.clear()
    events.subscribe(got.append)
    t0 = time.time()
    client.post("/api/panic", json={}, headers=H(tour))
    events.clear()
    assert len(got) == 1 and got[0]["kind"] == "panic"
    assert got[0]["published_at"] - t0 < 10


def test_broken_subscriber_does_not_block_panic(client):
    tour, _, _ = full_setup(client)
    events.clear()
    events.subscribe(lambda m: 1 / 0)
    assert client.post("/api/panic", json={}, headers=H(tour)).status_code == 201
    events.clear()


def test_score_endpoint_uses_zone_risk_and_anomaly(client):
    tour, adm, _ = full_setup(client)
    client.post("/api/zones", json=zone_body(risk_weight=0.8), headers=H(adm))
    s = client.get("/api/me/score", headers=H(tour)).json()
    assert s["has_fix"] is False and s["z"] == 0
    send(client, tour, 0, 0)
    s = client.get("/api/me/score", headers=H(tour)).json()
    assert s["z"] == 0.8 and s["score"] <= 60.0
    anomaly_state._recent.clear()


def test_family_share_opt_in_and_revoke(client):
    tour, _, _ = full_setup(client)
    send(client, tour, 0, 0)
    assert client.get("/api/me/profile", headers=H(tour)).json()["share_token"] is None
    r = client.post("/api/me/share", json={"enabled": True}, headers=H(tour)).json()
    tok = r["share_token"]
    assert tok
    view = client.get(f"/api/share/{tok}")  # public, no auth
    assert view.status_code == 200 and view.json()["name"] == "Tess" and view.json()["lat"] is not None
    assert "email" not in view.text and "kyc" not in view.text.lower()
    client.post("/api/me/share", json={"enabled": False}, headers=H(tour))
    assert client.get(f"/api/share/{tok}").status_code == 404
    assert client.get("/api/share/nonsense").status_code == 404


def test_language(client):
    tour, _, _ = full_setup(client)
    assert client.put("/api/me/language", json={"language": "hi"}, headers=H(tour)).json() == {"language": "hi"}
    assert client.get("/api/auth/me", headers=H(tour)).json()["language"] == "hi"
    assert client.put("/api/me/language", json={"language": "xx"}, headers=H(tour)).status_code == 422
