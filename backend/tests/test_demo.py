import pytest
from sqlmodel import Session, select

from app import db as appdb
from app.models import Alert, Fix, Incident, Tourist, User
from tests.test_ledger_api import H, token


def police(client):
    adm = token(client, "admin@tourist.local", "Admin@12345")
    client.post("/api/auth/staff", headers=H(adm), json={"email": "p@x.com", "full_name": "Pol",
                "password": "password123", "role": "police"})
    return token(client, "p@x.com"), adm


def seeded(client):
    pol, adm = police(client)
    assert client.post("/api/demo/seed", headers=H(pol)).status_code == 200
    return pol, adm


def run(client, pol, scenario, email="demo1@tourist.local"):
    r = client.post("/api/demo/scenario", json={"scenario": scenario, "email": email}, headers=H(pol))
    assert r.status_code == 200, r.text
    return r.json()


def kinds(res):
    return [a["kind"] for a in res["alerts"]]


def test_seed_is_idempotent_and_demo_login_works(client):
    pol, _ = police(client)
    r1 = client.post("/api/demo/seed", headers=H(pol)).json()
    assert r1["users_created"] == 3 and r1["zones_created"] == 2
    r2 = client.post("/api/demo/seed", headers=H(pol)).json()
    assert r2["users_created"] == 0 and r2["zones_created"] == 0
    tok = token(client, "demo1@tourist.local", "Demo@12345")
    assert client.get("/api/ledger/my-credential", headers=H(tok)).json()["id_code"].startswith("TID-")
    pub = client.get("/api/ledger/my-credential", headers=H(tok)).json()["payload"]
    assert client.post("/api/ledger/verify", json={"payload": pub}).json()["valid"]


def test_normal_scenario_raises_nothing(client):
    pol, _ = seeded(client)
    assert run(client, pol, "normal")["alerts"] == []


@pytest.mark.parametrize("scenario,expected", [
    ("dropoff", "dropoff"), ("inactivity", "inactivity"), ("deviation", "deviation"),
    ("zone_entry", "zone_entry"), ("border_warning", "zone_warning"), ("panic", "panic"),
])
def test_each_scenario_produces_its_alert_through_the_real_pipeline(client, scenario, expected):
    pol, _ = seeded(client)
    res = run(client, pol, scenario)
    assert kinds(res) == [expected], res
    q = client.get("/api/dashboard/alerts", headers=H(pol)).json()
    assert [a["kind"] for a in q] == [expected]       # it really is in the control-room queue


def test_scenario_alert_timing_matches_the_rules(client):
    pol, _ = seeded(client)
    d = run(client, pol, "dropoff")["alerts"][0]
    assert d["rule"] == "R1" and 49 <= d["minute"] <= 52     # last fix minute 29 + 20 min of silence
    inact = run(client, pol, "inactivity", "demo2@tourist.local")["alerts"][0]
    assert inact["rule"] == "R2" and 49 <= inact["minute"] <= 53
    dev = run(client, pol, "deviation", "demo3@tourist.local")["alerts"][0]
    assert dev["rule"] == "R3" and 24 <= dev["minute"] <= 27


def test_scenarios_can_be_chained_on_the_same_tourist(client):
    """Regression: a previous scenario's fixes used to fill the silence of the next one."""
    pol, _ = seeded(client)
    assert run(client, pol, "normal")["alerts"] == []
    assert kinds(run(client, pol, "dropoff")) == ["dropoff"]
    assert kinds(run(client, pol, "zone_entry")) == ["zone_entry"]
    assert kinds(run(client, pol, "zone_entry")) == ["zone_entry"]      # zone alert re-arms on a fresh run
    assert kinds(run(client, pol, "inactivity")) == ["inactivity"]
    with Session(appdb.engine) as s:
        assert len(s.exec(select(Fix)).all()) == 62          # only the last scenario's fixes remain


def test_scenarios_are_isolated_per_tourist(client):
    pol, _ = seeded(client)
    run(client, pol, "dropoff", "demo1@tourist.local")
    assert run(client, pol, "normal", "demo2@tourist.local")["alerts"] == []


def test_live_websocket_sees_scenario_alert(client):
    pol, _ = seeded(client)
    with client.websocket_connect(f"/api/ws/alerts?token={pol}") as ws:
        run(client, pol, "panic")
        assert ws.receive_json()["kind"] == "panic"


def test_reset_clears_demo_data_only(client):
    pol, _ = seeded(client)
    run(client, pol, "dropoff")
    client.post("/api/auth/register", json={"email": "real@x.com", "full_name": "Real", "password": "password123"})
    with Session(appdb.engine) as s:
        real = s.exec(select(Tourist).join(User, User.id == Tourist.user_id).where(User.email == "real@x.com")).one()
        s.add(Fix(tourist_id=real.id, lat=1, lon=1))
        s.add(Alert(tourist_id=real.id, kind="panic", detail="real"))
        s.commit()
    assert client.post("/api/demo/reset", headers=H(pol)).json()["removed"] > 0
    with Session(appdb.engine) as s:
        alerts = s.exec(select(Alert)).all()
        assert [a.detail for a in alerts] == ["real"]       # the real tourist's alert survives
        assert len(s.exec(select(Fix)).all()) == 1
    # after reset the same scenario fires again (cool-down state was cleared)
    assert kinds(run(client, pol, "dropoff")) == ["dropoff"]


def test_guards_and_validation(client):
    pol, adm = police(client)
    client.post("/api/auth/register", json={"email": "t@x.com", "full_name": "T", "password": "password123"})
    tour = token(client, "t@x.com")
    assert client.post("/api/demo/seed", headers=H(tour)).status_code == 403
    assert client.post("/api/demo/seed").status_code == 401
    assert client.post("/api/demo/scenario", json={"scenario": "dropoff"}, headers=H(pol)).status_code == 409  # unseeded
    client.post("/api/demo/seed", headers=H(adm))
    assert client.post("/api/demo/scenario", json={"scenario": "nope"}, headers=H(pol)).status_code == 422
    assert client.post("/api/demo/scenario", json={"scenario": "normal", "email": "t@x.com"}, headers=H(pol)).status_code == 422
    assert client.get("/api/demo/scenarios", headers=H(pol)).json()["scenarios"][0] == "normal"


def test_demo_can_be_disabled(client, monkeypatch):
    from app.config import settings
    pol, _ = police(client)
    monkeypatch.setattr(settings, "demo_enabled", False)
    assert client.post("/api/demo/seed", headers=H(pol)).status_code == 404


def test_full_incident_from_scenario_to_efir(client):
    """Scenario -> alert -> acknowledge -> reveal -> e-FIR PDF, all on seeded demo data."""
    pol, _ = seeded(client)
    run(client, pol, "dropoff")
    a = client.get("/api/dashboard/alerts", headers=H(pol)).json()[0]
    inc = client.patch(f"/api/alerts/{a['id']}", json={"status": "acknowledged"}, headers=H(pol)).json()["incident_id"]
    reveal = client.post(f"/api/incidents/{inc}/reveal", headers=H(pol)).json()
    assert reveal["name"] == "Asha Demo" and reveal["kyc"].startswith("DEMO-KYC")
    d = client.get(f"/api/incidents/{inc}/efir", headers=H(pol)).json()
    assert d["last_known_position"] and len(d["recent_track"]) == 20
    assert [s["name"] for s in d["itinerary"]["stops"]] == ["Hotel", "Viewpoint", "Waterfall"]
    assert client.get(f"/api/incidents/{inc}/efir.pdf", headers=H(pol)).content.startswith(b"%PDF")
