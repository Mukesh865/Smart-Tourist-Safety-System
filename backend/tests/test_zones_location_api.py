import math

from tests.test_ledger_api import H, issue_body, setup_users, token

LAT0, LON0 = 25.5788, 91.8933


def ll(x, y):
    return LAT0 + y / 111_194.9, LON0 + x / (111_194.9 * math.cos(math.radians(LAT0)))


def sq(cx, cy, half):
    return [list(ll(cx + dx, cy + dy)) for dx, dy in
            ((-half, -half), (half, -half), (half, half), (-half, half))]


def zone_body(**kw):
    b = {"name": "Cliff Edge", "polygon": sq(0, 0, 500), "risk_weight": 0.8, "no_entry": False}
    b.update(kw)
    return b


def full_setup(c):
    off, tour, adm = setup_users(c)
    c.post("/api/ledger/issue", json=issue_body(), headers=H(off))
    c.post("/api/auth/staff", headers=H(adm), json={"email": "p@x.com", "full_name": "Pol",
           "password": "password123", "role": "police"})
    return tour, adm, token(c, "p@x.com")


def send(c, tour, x, y, **kw):
    return c.post("/api/location", json={"lat": ll(x, y)[0], "lon": ll(x, y)[1], **kw}, headers=H(tour))


def test_zone_crud_and_roles(client):
    tour, adm, pol = full_setup(client)
    assert client.post("/api/zones", json=zone_body(), headers=H(tour)).status_code == 403
    assert client.post("/api/zones", json=zone_body()).status_code == 401
    r = client.post("/api/zones", json=zone_body(), headers=H(pol))
    assert r.status_code == 201
    zid = r.json()["id"]
    # tourists may read zones (map), not edit them
    assert len(client.get("/api/zones", headers=H(tour)).json()) == 1
    assert client.put(f"/api/zones/{zid}", json=zone_body(name="Renamed"), headers=H(adm)).json()["name"] == "Renamed"
    assert client.put("/api/zones/999", json=zone_body(), headers=H(adm)).status_code == 404
    assert client.delete(f"/api/zones/{zid}", headers=H(adm)).status_code == 204
    assert client.get("/api/zones", headers=H(adm)).json() == []


def test_zone_validation(client):
    _, adm, _ = full_setup(client)
    assert client.post("/api/zones", json=zone_body(polygon=[[1, 1], [2, 2]]), headers=H(adm)).status_code == 422
    assert client.post("/api/zones", json=zone_body(risk_weight=1.5), headers=H(adm)).status_code == 422
    assert client.post("/api/zones", json=zone_body(polygon=[[95, 0], [0, 0], [1, 1]]), headers=H(adm)).status_code == 422


def test_entry_alert_after_k_fixes_and_visible_to_police(client):
    tour, adm, pol = full_setup(client)
    client.post("/api/zones", json=zone_body(), headers=H(adm))
    assert send(client, tour, 2000, 0).json()["alerts"] == []
    results = [send(client, tour, 0, 0).json() for _ in range(3)]
    assert [len(r["alerts"]) for r in results] == [0, 0, 1]
    assert results[2]["alerts"][0]["kind"] == "zone_entry"
    assert "Cliff Edge" in results[2]["alerts"][0]["detail"]
    alerts = client.get("/api/alerts", headers=H(pol)).json()
    assert len(alerts) == 1 and alerts[0]["status"] == "open"
    assert client.get("/api/alerts?kind=panic", headers=H(pol)).json() == []
    assert client.get("/api/alerts", headers=H(tour)).status_code == 403
    assert len(client.get("/api/alerts/mine", headers=H(tour)).json()) == 1


def test_adaptive_interval_15s_near_zone_60s_elsewhere(client):
    tour, adm, _ = full_setup(client)
    client.post("/api/zones", json=zone_body(), headers=H(adm))
    assert send(client, tour, 0, 0).json()["next_interval_s"] == 15
    assert send(client, tour, 800, 0).json()["next_interval_s"] == 15   # within 1 km of a zone
    assert send(client, tour, 9000, 0).json()["next_interval_s"] == 60


def test_zone_edit_takes_effect_immediately(client):
    tour, adm, _ = full_setup(client)
    assert send(client, tour, 0, 0).json()["nearby_risk"] == 0.0
    client.post("/api/zones", json=zone_body(), headers=H(adm))
    assert send(client, tour, 0, 0).json()["nearby_risk"] == 0.8


def test_no_entry_zone_warns_before_crossing(client):
    tour, adm, _ = full_setup(client)
    client.post("/api/zones", json=zone_body(name="Border", no_entry=True, risk_weight=1), headers=H(adm))
    res = [send(client, tour, 520, 0).json() for _ in range(3)]
    assert res[2]["alerts"][0]["kind"] == "zone_warning"


def test_location_requires_tourist_with_id(client):
    off, tour, adm = setup_users(client)  # tourist has no ID yet
    assert send(client, tour, 0, 0).status_code == 403
    assert send(client, off, 0, 0).status_code == 403
    assert client.post("/api/location", json={"lat": 1, "lon": 1}).status_code == 401


def test_bad_coordinates_rejected(client):
    tour, _, _ = full_setup(client)
    assert client.post("/api/location", json={"lat": 91, "lon": 0}, headers=H(tour)).status_code == 422
    assert client.post("/api/location", json={"lat": 0, "lon": 181}, headers=H(tour)).status_code == 422
    assert client.post("/api/location", json={"lat": 0, "lon": 0, "accuracy": -1}, headers=H(tour)).status_code == 422


def test_geojson_roundtrip_and_import_rules(client):
    tour, adm, pol = full_setup(client)
    client.post("/api/zones", json=zone_body(), headers=H(adm))
    fc = client.get("/api/zones/geojson", headers=H(pol)).json()
    f = fc["features"][0]
    ring = f["geometry"]["coordinates"][0]
    assert fc["type"] == "FeatureCollection" and ring[0] == ring[-1] and len(ring) == 5
    assert abs(ring[0][0] - 91.8933) < 0.1 and abs(ring[0][1] - 25.5788) < 0.1          # [lon, lat] order
    assert f["properties"] == {"name": "Cliff Edge", "risk_weight": 0.8, "no_entry": False}
    assert client.post("/api/zones/import", json=fc, headers=H(adm)).json() == {"added": 0, "skipped": 1}   # same name skipped
    fc["features"][0]["properties"]["name"] = "Copy"
    assert client.post("/api/zones/import", json=fc, headers=H(adm)).json() == {"added": 1, "skipped": 0}
    assert len(client.get("/api/zones", headers=H(adm)).json()) == 2
    assert client.get("/api/zones/geojson", headers=H(tour)).status_code == 403
    assert client.post("/api/zones/import", json=fc, headers=H(tour)).status_code == 403


def test_geojson_import_is_all_or_nothing_and_validated(client):
    tour, adm, pol = full_setup(client)
    good = {"type": "Feature", "properties": {"name": "Good"}, "geometry": {"type": "Polygon", "coordinates": [[[91.0, 25.0], [91.1, 25.0], [91.1, 25.1], [91.0, 25.0]]]}}
    bad = {"type": "Feature", "properties": {"name": "Bad"}, "geometry": {"type": "Point", "coordinates": [91, 25]}}
    r = client.post("/api/zones/import", json={"type": "FeatureCollection", "features": [good, bad]}, headers=H(adm))
    assert r.status_code == 422 and "Feature 2" in r.json()["detail"]
    assert client.get("/api/zones", headers=H(adm)).json() == []                          # nothing imported
    assert client.post("/api/zones/import", json={"type": "Feature"}, headers=H(adm)).status_code == 422
    badrisk = {**good, "properties": {"name": "X", "risk_weight": 7}}
    assert client.post("/api/zones/import", json={"type": "FeatureCollection", "features": [badrisk]}, headers=H(adm)).status_code == 422
    nopoly = {**good, "geometry": {"type": "Polygon", "coordinates": [[[91.0, 25.0], [91.1, 25.0]]]}}
    assert client.post("/api/zones/import", json={"type": "FeatureCollection", "features": [nopoly]}, headers=H(adm)).status_code == 422
    assert client.post("/api/zones/import", json={"type": "FeatureCollection", "features": [good]}, headers=H(adm)).json()["added"] == 1
