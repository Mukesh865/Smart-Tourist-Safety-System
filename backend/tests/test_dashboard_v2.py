import csv
import io
from datetime import datetime, timedelta, timezone

from sqlmodel import Session, select

from app import csvutil, db as appdb
from app.models import Alert, AuditLog, Fix, Zone
from tests.test_detection_service import setup
from tests.test_ledger_api import H, token

NOW = datetime.now(timezone.utc)


def add_alerts(tid, specs):
    """specs: dicts with Alert fields; returns ids."""
    ids = []
    with Session(appdb.engine) as s:
        for sp in specs:
            a = Alert(tourist_id=tid, **{"kind": "panic", "detail": "d", **sp})
            s.add(a)
            s.commit()
            s.refresh(a)
            ids.append(a.id)
    return ids


def second_police(client, email="p2@x.com"):
    adm = token(client, "admin@tourist.local", "Admin@12345")
    client.post("/api/auth/staff", headers=H(adm), json={"email": email, "full_name": "Second Police", "password": "password123", "role": "police"})
    return token(client, email)


def me_id(client, tok):
    return client.get("/api/auth/me", headers=H(tok)).json()["id"]


# ------------------------------------------------------------------ queue filters
def test_filters_search_and_pagination(client):
    tid, tour, pol = setup(client)
    add_alerts(tid, [{"kind": "panic"}, {"kind": "dropoff", "rule": "R1"}, {"kind": "deviation", "rule": "R3"},
                     {"kind": "zone_entry"}, {"kind": "dropoff", "rule": "R1", "status": "resolved", "resolution": "false_alarm"}])
    get = lambda q="": client.get(f"/api/dashboard/alerts{q}", headers=H(pol))
    assert len(get().json()) == 4                                                # resolved hidden by default
    assert len(get("?include_resolved=true").json()) == 5
    assert [a["kind"] for a in get("?kind=dropoff&include_resolved=true").json()] == ["dropoff", "dropoff"]
    assert get("?status=resolved").json()[0]["resolution"] == "false_alarm"
    assert len(get("?rule=R3").json()) == 1
    code = get().json()[0]["id_code"]
    assert len(get(f"?q={code[:6].lower()}").json()) == 4                        # case-insensitive ID search
    assert get("?q=NOPE").json() == []
    page = get("?paged=true&limit=2&offset=1").json()
    assert page["total"] == 4 and len(page["items"]) == 2
    assert client.get("/api/dashboard/alerts", headers=H(tour)).status_code == 403


def test_date_range_filter(client):
    tid, _, pol = setup(client)
    old = NOW - timedelta(days=5)
    add_alerts(tid, [{"kind": "panic", "created_at": old}, {"kind": "panic"}])
    since = (NOW - timedelta(days=1)).isoformat().replace("+00:00", "Z")
    until = (NOW - timedelta(days=2)).isoformat().replace("+00:00", "Z")
    assert len(client.get("/api/dashboard/alerts", params={"since": since}, headers=H(pol)).json()) == 1
    assert len(client.get("/api/dashboard/alerts", params={"until": until}, headers=H(pol)).json()) == 1


def test_queue_order_is_panic_first_then_priority(client):
    tid, _, pol = setup(client)
    add_alerts(tid, [{"kind": "deviation", "score": 0.2}, {"kind": "inactivity", "score": 0.9}, {"kind": "panic"}, {"kind": "zone_entry"}])
    assert [a["kind"] for a in client.get("/api/dashboard/alerts", headers=H(pol)).json()] == ["panic", "inactivity", "deviation", "zone_entry"]


# ------------------------------------------------------------------ assignment + resolution
def test_acknowledging_assigns_to_the_actor_and_stamps_times(client):
    tid, _, pol = setup(client)
    aid = add_alerts(tid, [{}])[0]
    r = client.patch(f"/api/alerts/{aid}", json={"status": "acknowledged"}, headers=H(pol)).json()
    assert r["assigned_to"] == me_id(client, pol)
    row = client.get("/api/dashboard/alerts", headers=H(pol)).json()[0]
    assert row["assignee"] == "Pol"
    with Session(appdb.engine) as s:
        a = s.get(Alert, aid)
        assert a.acknowledged_at is not None and a.resolved_at is None


def test_reassign_unassign_and_validation(client):
    tid, tour, pol = setup(client)
    pol2 = second_police(client)
    aid = add_alerts(tid, [{}])[0]
    url = f"/api/alerts/{aid}"
    assert client.patch(url, json={"assignee_id": me_id(client, pol2)}, headers=H(pol)).json()["assigned_to"] == me_id(client, pol2)
    assert client.patch(url, json={"assignee_id": None}, headers=H(pol)).json()["assigned_to"] is None
    assert client.patch(url, json={"assignee_id": me_id(client, tour)}, headers=H(pol)).status_code == 422     # tourist cannot own an alert
    assert client.patch(url, json={"assignee_id": 9999}, headers=H(pol)).status_code == 422
    assert client.patch(url, json={}, headers=H(pol)).status_code == 422                                      # nothing to change
    with Session(appdb.engine) as s:
        assert [a.action for a in s.exec(select(AuditLog)).all()].count("assign") == 2


def test_assignment_does_not_change_status_and_status_change_keeps_assignee(client):
    tid, _, pol = setup(client)
    pol2 = second_police(client)
    aid = add_alerts(tid, [{}])[0]
    client.patch(f"/api/alerts/{aid}", json={"assignee_id": me_id(client, pol2)}, headers=H(pol))
    r = client.patch(f"/api/alerts/{aid}", json={"status": "acknowledged"}, headers=H(pol)).json()
    assert r["status"] == "acknowledged" and r["assigned_to"] == me_id(client, pol2)         # not stolen by the acknowledger


def test_resolution_reasons(client):
    tid, _, pol = setup(client)
    a, b, c = add_alerts(tid, [{}, {}, {}])
    p = lambda i, body: client.patch(f"/api/alerts/{i}", json=body, headers=H(pol))
    p(a, {"status": "acknowledged"})
    r = p(a, {"status": "resolved", "resolution": "false_alarm"})
    assert r.json()["resolution"] == "false_alarm"
    p(b, {"status": "acknowledged"})
    assert p(b, {"status": "resolved"}).json()["resolution"] == "resolved"                    # default reason
    assert p(c, {"status": "acknowledged", "resolution": "false_alarm"}).status_code == 422   # reason only when resolving
    assert p(c, {"status": "resolved", "resolution": "because"}).status_code == 422
    with Session(appdb.engine) as s:
        assert s.get(Alert, a).resolved_at is not None


# ------------------------------------------------------------------ bulk
def test_bulk_acknowledge_with_skips(client):
    tid, tour, pol = setup(client)
    a, b, c = add_alerts(tid, [{}, {}, {"status": "resolved", "resolution": "resolved"}])
    r = client.post("/api/alerts/bulk", json={"ids": [a, b, c, c, 9999], "status": "acknowledged"}, headers=H(pol)).json()
    assert sorted(r["updated"]) == sorted([a, b])
    reasons = {s["id"]: s["reason"] for s in r["skipped"]}
    assert "Cannot go from resolved" in reasons[c] and reasons[9999] == "not found"
    assert [s["id"] for s in r["skipped"]].count(c) == 1                                      # duplicate ids are processed once
    r2 = client.post("/api/alerts/bulk", json={"ids": [a, b], "status": "resolved", "resolution": "false_alarm"}, headers=H(pol)).json()
    assert sorted(r2["updated"]) == sorted([a, b])
    assert client.post("/api/alerts/bulk", json={"ids": list(range(101)), "status": "acknowledged"}, headers=H(pol)).status_code == 422
    assert client.post("/api/alerts/bulk", json={"ids": [], "status": "acknowledged"}, headers=H(pol)).status_code == 422
    assert client.post("/api/alerts/bulk", json={"ids": [a], "status": "open"}, headers=H(pol)).status_code == 422
    assert client.post("/api/alerts/bulk", json={"ids": [a], "status": "acknowledged"}, headers=H(tour)).status_code == 403


# ------------------------------------------------------------------ trail
def test_trail_is_ordered_windowed_and_staff_only(client):
    tid, tour, pol = setup(client)
    with Session(appdb.engine) as s:
        for h in (60, 30, 5, 3, 1):
            s.add(Fix(tourist_id=tid, lat=25.5 + h / 1000, lon=91.8, ts=NOW - timedelta(hours=h)))
        s.commit()
    pts = client.get(f"/api/dashboard/trail/{tid}", headers=H(pol)).json()["points"]
    assert [round((p["lat"] - 25.5) * 1000) for p in pts] == [5, 3, 1]                         # last 6 h, oldest first
    assert len(client.get(f"/api/dashboard/trail/{tid}?hours=2", headers=H(pol)).json()["points"]) == 1
    assert len(client.get(f"/api/dashboard/trail/{tid}?hours=999", headers=H(pol)).json()["points"]) == 4   # capped at 48 h: the 60 h-old fix is excluded
    assert client.get(f"/api/dashboard/trail/{tid}", headers=H(tour)).status_code == 403
    assert client.get("/api/dashboard/trail/999", headers=H(pol)).json()["points"] == []


# ------------------------------------------------------------------ notes + timeline
def test_notes_and_timeline(client):
    tid, tour, pol = setup(client)
    aid = add_alerts(tid, [{"detail": "Panic button pressed"}])[0]
    inc = client.patch(f"/api/alerts/{aid}", json={"status": "acknowledged"}, headers=H(pol)).json()["incident_id"]
    r = client.post(f"/api/incidents/{inc}/notes", json={"text": "  Called the hotel, tourist left at 14:00  "}, headers=H(pol))
    assert r.status_code == 201 and r.json()["text"] == "Called the hotel, tourist left at 14:00" and r.json()["by"] == "Pol"
    client.patch(f"/api/alerts/{aid}", json={"status": "dispatched"}, headers=H(pol))
    items = client.get(f"/api/incidents/{inc}/timeline", headers=H(pol)).json()["items"]
    kinds = [i["kind"] for i in items]
    assert kinds[0] == "alert" and "note" in kinds and kinds.count("action") >= 3             # ack, note audit, dispatch
    stamps = [i["ts"] for i in items]
    assert stamps == sorted(stamps)
    assert any("Called the hotel" in i["text"] and i["by"] == "Pol" for i in items if i["kind"] == "note")
    assert "Tess" not in str(items) and "AADHAAR" not in str(items)                            # timeline carries no personal data
    with Session(appdb.engine) as s:
        assert "note" in [a.action for a in s.exec(select(AuditLog)).all()]


def test_note_validation_and_roles(client):
    tid, tour, pol = setup(client)
    aid = add_alerts(tid, [{}])[0]
    inc = client.patch(f"/api/alerts/{aid}", json={"status": "acknowledged"}, headers=H(pol)).json()["incident_id"]
    url = f"/api/incidents/{inc}/notes"
    assert client.post(url, json={"text": ""}, headers=H(pol)).status_code == 422
    assert client.post(url, json={"text": "x" * 1001}, headers=H(pol)).status_code == 422
    assert client.post(url, json={"text": "ok"}, headers=H(tour)).status_code == 403
    assert client.post("/api/incidents/999/notes", json={"text": "ok"}, headers=H(pol)).status_code == 404
    assert client.get("/api/incidents/999/timeline", headers=H(pol)).status_code == 404
    assert client.get(f"/api/incidents/{inc}/timeline", headers=H(tour)).status_code == 403


# ------------------------------------------------------------------ CSV
def test_csv_cells_cannot_become_spreadsheet_formulas():
    for evil in ("=HYPERLINK(\"http://evil\")", "+1+1", "-2", "@SUM(A1)", "\tcmd"):
        assert csvutil.safe_cell(evil).startswith("'"), evil
    assert csvutil.safe_cell("normal") == "normal" and csvutil.safe_cell(None) == "" and csvutil.safe_cell(0) == "0"
    assert csvutil.safe_cell(NOW).startswith("20")


def test_alert_export_filters_escapes_and_is_audited(client):
    tid, tour, pol = setup(client)
    add_alerts(tid, [{"kind": "panic", "detail": "=EVIL()"}, {"kind": "dropoff", "rule": "R1", "detail": "No location for 22 min"}])
    r = client.get("/api/dashboard/alerts.csv", headers=H(pol))
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv") and "attachment" in r.headers["content-disposition"]
    rows = list(csv.DictReader(io.StringIO(r.text)))
    assert len(rows) == 2 and set(rows[0]) >= {"id", "created_at", "id_code", "kind", "status", "detail"}
    assert next(x for x in rows if x["kind"] == "panic")["detail"] == "'=EVIL()"             # formula neutralised
    only = list(csv.DictReader(io.StringIO(client.get("/api/dashboard/alerts.csv?kind=dropoff", headers=H(pol)).text)))
    assert [x["kind"] for x in only] == ["dropoff"]
    assert "AADHAAR" not in r.text and "Tess" not in r.text and "t@x.com" not in r.text          # no personal data
    with Session(appdb.engine) as s:
        assert "export_alerts" in [a.action for a in s.exec(select(AuditLog)).all()]
    assert client.get("/api/dashboard/alerts.csv", headers=H(tour)).status_code == 403


def test_audit_export_is_admin_only(client):
    tid, tour, pol = setup(client)
    adm = token(client, "admin@tourist.local", "Admin@12345")
    r = client.get("/api/admin/audit.csv", headers=H(adm))
    assert r.status_code == 200 and r.text.splitlines()[0].startswith("id,time,action,actor")
    assert client.get("/api/admin/audit.csv", headers=H(pol)).status_code == 403
    assert client.get("/api/admin/audit.csv").status_code == 401


# ------------------------------------------------------------------ analytics
def test_analytics_summary(client):
    tid, tour, pol = setup(client)
    with Session(appdb.engine) as s:
        s.add(Zone(id=7, name="Cliff Edge", polygon_json="[]", risk_weight=0.8))
        s.commit()
    two_days = NOW - timedelta(days=2)
    add_alerts(tid, [
        {"kind": "panic", "created_at": two_days, "status": "resolved", "resolution": "resolved",
         "acknowledged_at": two_days + timedelta(seconds=60), "resolved_at": two_days + timedelta(seconds=600)},
        {"kind": "panic", "created_at": two_days, "status": "resolved", "resolution": "cancelled_by_user", "resolved_at": two_days + timedelta(seconds=5)},
        {"kind": "dropoff", "rule": "R1", "created_at": NOW, "status": "resolved", "resolution": "false_alarm", "acknowledged_at": NOW + timedelta(seconds=180), "resolved_at": NOW + timedelta(seconds=900)},
        {"kind": "dropoff", "rule": "R1", "created_at": NOW, "status": "resolved", "resolution": "resolved", "acknowledged_at": NOW + timedelta(seconds=60), "resolved_at": NOW + timedelta(seconds=300)},
        {"kind": "dropoff", "rule": "R1"},
        {"kind": "zone_entry", "zone_id": 7}, {"kind": "zone_entry", "zone_id": 7}, {"kind": "zone_warning"},
        {"kind": "panic", "created_at": NOW - timedelta(days=40)},                                 # outside the window
    ])
    with Session(appdb.engine) as s:
        s.add(Fix(tourist_id=tid, lat=1, lon=1, ts=NOW - timedelta(hours=1)))
        s.add(Fix(tourist_id=tid, lat=1, lon=1, ts=NOW - timedelta(days=2)))
        s.commit()
    d = client.get("/api/analytics/summary?days=7", headers=H(pol)).json()
    assert len(d["per_day"]) == 7 and d["total_alerts"] == 8
    today = d["per_day"][-1]
    assert (today["panic"], today["movement"], today["zone"]) == (0, 3, 3)
    assert d["per_day"][-3]["panic"] == 2
    assert d["response"]["n_ack"] == 3                                                          # median of 60 s, 180 s, 60 s
    assert d["response"]["median_ack_s"] == 60.0
    assert d["response"]["n_resolved"] == 3                                                     # the cancelled one is excluded
    drop = next(r for r in d["rules"] if r["kind"] == "dropoff")
    assert (drop["total"], drop["genuine"], drop["false_alarm"], drop["open"], drop["judged"]) == (3, 1, 1, 1, 2)
    assert drop["false_alarm_ratio"] == 0.5
    panic = next(r for r in d["rules"] if r["kind"] == "panic")
    assert panic["cancelled"] == 1 and panic["genuine"] == 1
    assert d["zones"] == [{"zone_id": 7, "name": "Cliff Edge", "count": 2}]
    assert [x["count"] for x in d["active_tourists"]][-3:] == [1, 0, 1] and sum(x["count"] for x in d["active_tourists"]) == 2


def test_analytics_empty_range_and_guards(client):
    tid, tour, pol = setup(client)
    d = client.get("/api/analytics/summary", headers=H(pol)).json()
    assert d["total_alerts"] == 0 and d["response"]["median_ack_s"] is None and d["rules"] == [] and len(d["per_day"]) == 14
    assert len(client.get("/api/analytics/summary?days=500", headers=H(pol)).json()["per_day"]) == 90      # clamped
    assert len(client.get("/api/analytics/summary?days=0", headers=H(pol)).json()["per_day"]) == 1
    assert client.get("/api/analytics/summary", headers=H(tour)).status_code == 403
    assert client.get("/api/analytics/summary").status_code == 401


def test_staff_list_for_assignment(client):
    tid, tour, pol = setup(client)
    second_police(client)
    names = [u["name"] for u in client.get("/api/dashboard/staff", headers=H(pol)).json()]
    assert "Pol" in names and "Second Police" in names and "System Admin" in names and "Tess" not in names
    adm = token(client, "admin@tourist.local", "Admin@12345")
    uid = [u["id"] for u in client.get("/api/dashboard/staff", headers=H(pol)).json() if u["name"] == "Second Police"][0]
    client.patch(f"/api/admin/users/{uid}", json={"disabled": True}, headers=H(adm))
    assert "Second Police" not in [u["name"] for u in client.get("/api/dashboard/staff", headers=H(pol)).json()]   # disabled staff are not offered
    assert client.get("/api/dashboard/staff", headers=H(tour)).status_code == 403
