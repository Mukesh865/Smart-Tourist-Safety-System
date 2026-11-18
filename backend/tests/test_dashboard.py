import json
import time

from sqlmodel import Session, select

from app import db as appdb
from app.models import Alert, AuditLog, Incident, OffchainPII
from tests.test_detection_service import BASE, put, run, setup
from tests.test_ledger_api import H, KYC, PHONE
from tests.test_zones_location_api import send, zone_body


def make_panic(client, tour):
    return client.post("/api/panic", json={}, headers=H(tour)).json()["alert_id"]


def test_websocket_receives_panic_alert_live(client):
    tid, tour, pol = setup(client)
    with client.websocket_connect(f"/api/ws/alerts?token={pol}") as ws:
        t0 = time.time()
        make_panic(client, tour)
        msg = ws.receive_json()
    assert msg["kind"] == "panic" and msg["tourist_id"] == tid
    assert time.time() - t0 < 10     # paper limit: panic to dashboard < 10 s


def test_websocket_receives_zone_entry_and_detector_alerts(client):
    tid, tour, pol = setup(client)
    adm = client.post("/api/auth/login", data={"username": "admin@tourist.local", "password": "Admin@12345"}).json()["access_token"]
    client.post("/api/zones", json=zone_body(), headers=H(adm))
    with client.websocket_connect(f"/api/ws/alerts?token={pol}") as ws:
        for _ in range(3):
            send(client, tour, 0, 0)
        assert ws.receive_json()["kind"] == "zone_entry"
        put(tid, [(m, m * 20.0, 0.0) for m in range(30)])
        run(55)
        assert ws.receive_json()["kind"] == "dropoff"


def test_websocket_rejects_bad_or_unauthorised_tokens(client):
    import pytest
    from starlette.websockets import WebSocketDisconnect
    _, tour, _ = setup(client)
    for tok in ("", "junk", tour):    # none, invalid, tourist role
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(f"/api/ws/alerts?token={tok}") as ws:
                ws.receive_json()


def test_ranked_queue_panic_first_then_score(client):
    tid, tour, pol = setup(client)
    with Session(appdb.engine) as s:
        s.add(Alert(tourist_id=tid, kind="deviation", detail="d", score=0.2))
        s.add(Alert(tourist_id=tid, kind="inactivity", detail="i", score=0.9))
        s.add(Alert(tourist_id=tid, kind="zone_entry", detail="z"))
        s.commit()
    make_panic(client, tour)
    kinds = [a["kind"] for a in client.get("/api/dashboard/alerts", headers=H(pol)).json()]
    assert kinds == ["panic", "inactivity", "deviation", "zone_entry"]
    assert client.get("/api/dashboard/alerts", headers=H(tour)).status_code == 403


def test_overview_positions_clusters_and_no_personal_data(client):
    tid, tour, pol = setup(client)
    send(client, tour, 0, 0)
    make_panic(client, tour)
    ov = client.get("/api/dashboard/overview", headers=H(pol))
    d = ov.json()
    assert d["active_tourists"] == 1 and d["positions"][0]["open_alerts"] == 1
    assert d["clusters"][0]["count"] == 1 and d["alerts_by_status"]["open"] == 1
    assert KYC not in ov.text and "Tess" not in ov.text and "t@x.com" not in ov.text
    assert client.get("/api/dashboard/overview", headers=H(tour)).status_code == 403


def test_workflow_transitions_and_incident_lifecycle(client):
    tid, tour, pol = setup(client)
    aid = make_panic(client, tour)
    patch = lambda s: client.patch(f"/api/alerts/{aid}", json={"status": s}, headers=H(pol))
    assert patch("resolved").status_code == 409          # cannot skip acknowledge
    r = patch("acknowledged")
    assert r.status_code == 200 and r.json()["incident_id"]
    assert patch("acknowledged").status_code == 409
    assert patch("dispatched").status_code == 200
    assert patch("resolved").status_code == 200
    assert patch("dispatched").status_code == 409        # no going back
    with Session(appdb.engine) as s:
        assert s.exec(select(Incident)).one().status == "closed"
        assert [a.action for a in s.exec(select(AuditLog).order_by(AuditLog.id)).all() if a.action != "issue_id"] == ["ack", "dispatch", "resolve"]
    assert client.patch(f"/api/alerts/{aid}", json={"status": "acknowledged"}, headers=H(tour)).status_code == 403
    assert client.patch("/api/alerts/999", json={"status": "acknowledged"}, headers=H(pol)).status_code == 404


def test_two_alerts_share_one_incident_and_close_together(client):
    tid, tour, pol = setup(client)
    a1, a2 = make_panic(client, tour), make_panic(client, tour)
    i1 = client.patch(f"/api/alerts/{a1}", json={"status": "acknowledged"}, headers=H(pol)).json()["incident_id"]
    i2 = client.patch(f"/api/alerts/{a2}", json={"status": "acknowledged"}, headers=H(pol)).json()["incident_id"]
    assert i1 == i2
    client.patch(f"/api/alerts/{a1}", json={"status": "resolved"}, headers=H(pol))
    with Session(appdb.engine) as s:
        assert s.get(Incident, i1).status == "open"      # a2 still pending
    client.patch(f"/api/alerts/{a2}", json={"status": "resolved"}, headers=H(pol))
    with Session(appdb.engine) as s:
        assert s.get(Incident, i1).status == "closed"


def test_pii_only_for_active_incident_and_audited(client):
    tid, tour, pol = setup(client)
    aid = make_panic(client, tour)
    assert client.post("/api/incidents/1/reveal", headers=H(pol)).status_code == 404   # no incident yet
    inc = client.patch(f"/api/alerts/{aid}", json={"status": "acknowledged"}, headers=H(pol)).json()["incident_id"]
    assert client.post(f"/api/incidents/{inc}/reveal", headers=H(tour)).status_code == 403
    r = client.post(f"/api/incidents/{inc}/reveal", headers=H(pol))
    assert r.status_code == 200
    body = r.json()
    assert body["kyc"] == KYC and body["contacts"][0]["phone"] == PHONE and body["name"] == "Tess"
    client.patch(f"/api/alerts/{aid}", json={"status": "resolved"}, headers=H(pol))
    assert client.post(f"/api/incidents/{inc}/reveal", headers=H(pol)).status_code == 403   # closed
    adm = client.post("/api/auth/login", data={"username": "admin@tourist.local", "password": "Admin@12345"}).json()["access_token"]
    log = client.get("/api/audit", headers=H(adm)).json()
    assert "reveal_pii" in [x["action"] for x in log]
    assert client.get("/api/audit", headers=H(pol)).status_code == 403


def test_reveal_after_erasure_returns_410(client):
    tid, tour, pol = setup(client)
    aid = make_panic(client, tour)
    inc = client.patch(f"/api/alerts/{aid}", json={"status": "acknowledged"}, headers=H(pol)).json()["incident_id"]
    with Session(appdb.engine) as s:
        for r in s.exec(select(OffchainPII)).all():
            s.delete(r)
        s.commit()
    assert client.post(f"/api/incidents/{inc}/reveal", headers=H(pol)).status_code == 410
    d = client.get(f"/api/incidents/{inc}/efir", headers=H(pol)).json()      # e-FIR still works, flags erasure
    assert "erased" in d["missing_person"]["kyc_number"] and d["itinerary"] is None


def test_efir_draft_contents_and_pdf(client):
    tid, tour, pol = setup(client)
    send(client, tour, 100, 50)
    send(client, tour, 150, 60)
    aid = make_panic(client, tour)
    inc = client.patch(f"/api/alerts/{aid}", json={"status": "acknowledged"}, headers=H(pol)).json()["incident_id"]
    d = client.get(f"/api/incidents/{inc}/efir", headers=H(pol)).json()
    assert d["status"].startswith("DRAFT")
    assert d["missing_person"]["name"] == "Tess" and d["missing_person"]["kyc_number"] == KYC
    assert d["emergency_contacts"][0]["phone"] == PHONE
    assert d["last_known_position"] is not None and len(d["recent_track"]) == 2
    assert d["alert_log"][0]["kind"] == "panic"
    assert [s["name"] for s in d["itinerary"]["stops"]] == ["Hotel", "View"]
    pdf = client.get(f"/api/incidents/{inc}/efir.pdf", headers=H(pol))
    assert pdf.status_code == 200 and pdf.headers["content-type"] == "application/pdf"
    assert pdf.content.startswith(b"%PDF") and len(pdf.content) > 1500
    assert client.get(f"/api/incidents/{inc}/efir.pdf", headers=H(tour)).status_code == 403
    adm = client.post("/api/auth/login", data={"username": "admin@tourist.local", "password": "Admin@12345"}).json()["access_token"]
    assert [x["action"] for x in client.get("/api/audit", headers=H(adm)).json()].count("efir") == 2


def test_efir_for_closed_incident_refused(client):
    tid, tour, pol = setup(client)
    aid = make_panic(client, tour)
    inc = client.patch(f"/api/alerts/{aid}", json={"status": "acknowledged"}, headers=H(pol)).json()["incident_id"]
    client.patch(f"/api/alerts/{aid}", json={"status": "resolved"}, headers=H(pol))
    assert client.get(f"/api/incidents/{inc}/efir", headers=H(pol)).status_code == 403
