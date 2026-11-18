import json
from datetime import datetime, timedelta, timezone

import numpy as np
import pytest
from sqlmodel import Session, select

from app import db as appdb
from app.detect.detectors import features_series, rule_flags
from app.detect.params import DEFAULTS, Params, validate
from app.models import AuditLog, SystemSettings
from app.score import is_night
from tests.test_detection_service import put, run, setup
from tests.test_ledger_api import H, token
from tests.test_zones_location_api import send, zone_body


def admin(c):
    return H(token(c, "admin@tourist.local", "Admin@12345"))


# ------------------------------------------------------------------ validation
def test_defaults_are_the_papers_values():
    assert (DEFAULTS.r1_minutes, DEFAULTS.r2_still_min, DEFAULTS.r2_dist_m, DEFAULTS.r2_anywhere_min) == (20, 40, 200, 150)
    assert (DEFAULTS.r3_km, DEFAULTS.r3_minutes, DEFAULTS.cooldown_min) == (1.0, 10, 60)
    assert (DEFAULTS.geo_k, DEFAULTS.geo_buffer_m) == (3, 20)


@pytest.mark.parametrize("bad,msg", [
    ({"r1_minutes": 1}, "between"), ({"geo_k": 0}, "between"), ({"nope": 1}, "Unknown"), ({"r1_minutes": "20"}, "number"),
    ({"r1_minutes": True}, "number"), ({"geo_k": 2.5}, "whole"), ({"r2_still_min": 100, "r2_anywhere_min": 50}, "shorter"),
    ({"night_start": 24}, "between"),
])
def test_validation_rejects(bad, msg):
    with pytest.raises(ValueError, match=msg):
        validate(bad)


def test_validation_merges_over_defaults_and_casts_ints():
    p = validate({"r1_minutes": 35, "geo_k": 4.0})
    assert p.r1_minutes == 35 and p.geo_k == 4 and isinstance(p.geo_k, int) and p.r2_dist_m == 200


# ------------------------------------------------------------------ rules read the parameters
ROUTE = np.array([[0.0, 0.0], [5000.0, 0.0]])
STOPS = np.array([[0.0, 0.0], [2500.0, 0.0]])


def obs(n, fn):
    o = np.full((n, 2), np.nan)
    for m in range(n):
        v = fn(m)
        if v is not None:
            o[m] = v
    return o


def first(f, col):
    i = np.where(f[:, col])[0]
    return int(i[0]) if len(i) else None


def test_r1_threshold_is_configurable():
    o = obs(120, lambda m: (m * 10.0, 0.0) if m < 30 else None)
    raw = features_series(o, ROUTE, STOPS)
    assert first(rule_flags(raw), 0) == 29 + 21
    assert first(rule_flags(raw, Params(r1_minutes=45)), 0) == 29 + 46          # a district with long normal gaps


def test_r3_distance_and_window_are_configurable():
    o = obs(80, lambda m: (m * 40.0, 0.0 if m < 20 else 800.0))                  # 800 m off route from minute 20
    assert first(rule_flags(features_series(o, ROUTE, STOPS)), 2) is None        # default: needs 1 km
    f = rule_flags(features_series(o, ROUTE, STOPS, r3_minutes=5), Params(r3_km=0.5, r3_minutes=5))
    assert 24 <= first(f, 2) <= 25                                                 # 5 minutes after leaving


def test_r2_distance_is_configurable():
    o = obs(120, lambda m: (1500.0, 0.0) if m >= 10 else (m * 150.0, 0.0))
    assert first(rule_flags(features_series(o, ROUTE, STOPS)), 1) is not None
    assert first(rule_flags(features_series(o, ROUTE, STOPS), Params(r2_dist_m=1500)), 1) is None


# ------------------------------------------------------------------ night window
def test_night_window_wrapping_and_same_day():
    t = lambda h: datetime(2026, 1, 1, h, 0, tzinfo=timezone.utc) - timedelta(hours=5, minutes=30)   # h:00 IST
    assert [is_night(t(h)) for h in (3, 4, 5, 12, 19, 20, 23)] == [1, 1, 0, 0, 0, 1, 1]
    assert [is_night(t(h), 22, 6) for h in (21, 22, 5, 6)] == [0, 1, 1, 0]
    assert [is_night(t(h), 1, 6) for h in (0, 1, 5, 6)] == [0, 1, 1, 0]                               # does not wrap midnight


# ------------------------------------------------------------------ API
def test_get_put_reset_and_audit(client):
    s = client.get("/api/admin/settings", headers=admin(client)).json()
    assert s["values"] == s["defaults"] and s["bounds"]["geo_k"] == {"min": 1, "max": 10}
    r = client.put("/api/admin/settings", json={"r1_minutes": 45, "geo_k": 4}, headers=admin(client))
    assert r.status_code == 200 and r.json()["values"]["r1_minutes"] == 45 and r.json()["values"]["r2_dist_m"] == 200
    assert client.get("/api/admin/settings", headers=admin(client)).json()["values"]["geo_k"] == 4
    with Session(appdb.engine) as sess:
        assert json.loads(sess.get(SystemSettings, 1).values_json) == {"r1_minutes": 45.0, "geo_k": 4}   # only differences are stored
        d = [a.detail for a in sess.exec(select(AuditLog)).all() if a.action == "admin_update_settings"][0]
        assert "r1_minutes 20->45" in d and "geo_k 3->4" in d
    reset = client.post("/api/admin/settings/reset", headers=admin(client)).json()
    assert reset["values"] == reset["defaults"]


def test_put_validation_and_roles(client):
    tid, tour, pol = setup(client)
    assert client.put("/api/admin/settings", json={"r1_minutes": 1}, headers=admin(client)).status_code == 422
    assert client.put("/api/admin/settings", json={"bogus": 1}, headers=admin(client)).status_code == 422
    for who in (tour, pol):
        for m, path in (("get", "/api/admin/settings"), ("put", "/api/admin/settings"), ("post", "/api/admin/settings/reset"), ("post", "/api/admin/settings/whatif")):
            kw = {"json": {}} if m != "get" else {}
            assert getattr(client, m)(path, headers=H(who), **kw).status_code == 403
    assert client.get("/api/admin/settings").status_code == 401


def test_corrupt_stored_settings_fall_back_to_defaults(client):
    from app import settings_store
    with Session(appdb.engine) as s:
        s.add(SystemSettings(id=1, values_json='{"r1_minutes": 9999}'))
        s.commit()
    settings_store.invalidate()
    with Session(appdb.engine) as s:
        assert settings_store.get(s) == DEFAULTS


# ------------------------------------------------------------------ settings change live behaviour
def test_changing_r1_changes_when_the_dropoff_alert_fires(client):
    tid, tour, pol = setup(client)
    put(tid, [(m, m * 20.0, 0.0) for m in range(30)])
    assert run(40) == []                                                           # 11 min of silence: quiet under the default
    client.put("/api/admin/settings", json={"r1_minutes": 8}, headers=admin(client))
    assert [a.kind for a in run(41)] == ["dropoff"]                                # a stricter district alerts sooner


def test_changing_geo_k_and_buffer_changes_zone_alerts(client):
    tid, tour, pol = setup(client)
    client.post("/api/zones", json=zone_body(), headers=admin(client))
    client.put("/api/admin/settings", json={"geo_k": 1, "geo_buffer_m": 0}, headers=admin(client))
    assert len(send(client, tour, 0, 0).json()["alerts"]) == 1                     # first fix alerts with k=1
    client.put("/api/admin/settings", json={"geo_k": 5}, headers=admin(client))
    res = [len(send(client, tour, 1, 0).json()["alerts"]) for _ in range(5)]
    assert res == [0, 0, 0, 0, 1]


def test_whatif_is_a_dry_run_that_shows_the_effect(client):
    r = client.post("/api/admin/settings/whatif", json={"r1_minutes": 60}, headers=admin(client))
    assert r.status_code == 200
    d = r.json()
    for part in ("candidate", "defaults"):
        for ds in ("matched", "shifted"):
            assert set(d[part][ds]) >= {"recall", "precision", "fa_per_100", "kinds"}
    assert d["defaults"]["matched"]["recall"] >= 0.9
    assert d["candidate"]["matched"]["kinds"]["dropoff"]["median_delay"] > d["defaults"]["matched"]["kinds"]["dropoff"]["median_delay"]
    assert set(d["geo"]) == {"candidate", "defaults"}
    assert client.get("/api/admin/settings", headers=admin(client)).json()["values"]["r1_minutes"] == 20   # nothing saved
    assert client.post("/api/admin/settings/whatif", json={"r1_minutes": 1}, headers=admin(client)).status_code == 422


def test_looser_thresholds_reduce_false_alerts_on_shifted_days(client):
    d = client.post("/api/admin/settings/whatif", json={"r1_minutes": 45, "r2_still_min": 70, "r2_dist_m": 400, "r3_km": 2.0}, headers=admin(client)).json()
    assert d["candidate"]["shifted"]["fa_per_100"] < d["defaults"]["shifted"]["fa_per_100"]
