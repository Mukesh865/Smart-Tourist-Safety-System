"""Detector unit tests (crafted tracks) + a reduced-scale reproduction of paper Table III."""
import numpy as np
import pytest

from app.detect.detectors import (COOLDOWN, ROUTE, SHARE, SINCE, SPEED, STILL, STOP, Alerting,
                                  features_series, rule_flags)
from app.detect.evaluate import evaluate
from app.detect.simulator import make_pois, simulate_day

ROUTE_LINE = np.array([[0.0, 0.0], [5000.0, 0.0]])
STOPS = np.array([[0.0, 0.0], [2500.0, 0.0], [5000.0, 0.0]])  # hotel first


def track(n, fn):
    """obs array of length n from fn(minute) -> (x, y) or None (no fix)."""
    o = np.full((n, 2), np.nan)
    for m in range(n):
        p = fn(m)
        if p is not None:
            o[m] = p
    return o


def flags(obs):
    return rule_flags(features_series(obs, ROUTE_LINE, STOPS))


def first(f, col):
    idx = np.where(f[:, col])[0]
    return int(idx[0]) if len(idx) else None


def test_normal_walk_raises_nothing():
    obs = track(300, lambda m: (m * 15.0, 3.0))  # walks along the route at 0.25 m/s... within route
    assert not flags(obs).any()


def test_r1_silence_over_20_min():
    obs = track(100, lambda m: (m * 10.0, 0.0) if m < 30 else None)
    f = flags(obs)
    assert first(f, 0) == 29 + 21          # last fix at 29, alert when gap exceeds 20 min
    assert not f[:49, 0].any()


def test_short_gap_is_tolerated():
    obs = track(100, lambda m: (m * 10.0, 0.0) if not (30 <= m < 45) else None)  # 15 min gap
    assert not flags(obs)[:, 0].any()


def test_r2_still_away_from_stops_over_40_min():
    obs = track(120, lambda m: (1200.0, 0.0) if m >= 10 else (m * 120.0, 0.0))  # parked 1.2 km from stops
    f = flags(obs)
    assert 10 + 40 <= first(f, 1) <= 10 + 42


def test_r2_not_triggered_by_long_stop_at_planned_site():
    obs = track(200, lambda m: (2500.0 + 3 * np.sin(m), 0.0))  # 200 min at a planned stop (not the hotel)
    f = flags(obs)
    # stillness beyond 150 min anywhere but the hotel is flagged by R2's second clause
    assert first(f, 1) is not None and first(f, 1) >= 150
    obs2 = track(100, lambda m: (2500.0, 0.0))
    assert not flags(obs2)[:, 1].any()    # a 100 min stop at a planned site is normal


def test_r2_hotel_never_triggers():
    obs = track(400, lambda m: (0.0, 0.0))
    assert not flags(obs)[:, 1].any()


def test_r3_deviation_over_1km_for_10_min():
    obs = track(60, lambda m: (m * 50.0, 0.0 if m < 20 else 1500.0))
    f = flags(obs)
    assert 29 <= first(f, 2) <= 31         # 10 min after leaving at minute 20
    brief = track(60, lambda m: (m * 50.0, 1500.0 if 20 <= m < 27 else 0.0))   # 7 min excursion
    assert not flags(brief)[:, 2].any()
    detour = track(60, lambda m: (m * 50.0, 800.0 if 20 <= m < 40 else 0.0))   # 800 m detour is benign
    assert not flags(detour)[:, 2].any()


def test_r3_needs_ten_minutes_of_history():
    """A tourist who starts tracking far from the route is not flagged on the very first fix."""
    obs = track(30, lambda m: (m * 10.0, 1800.0))
    f = flags(obs)
    assert first(f, 2) == 9              # earliest possible: ten minutes after tracking began
    assert not f[:9, 2].any()


def test_silent_phone_does_not_trigger_r3():
    obs = track(60, lambda m: (m * 50.0, 1500.0) if m < 5 else None)
    assert not flags(obs)[30:, 2].any()


def test_feature_values():
    obs = track(60, lambda m: (m * 60.0, 20.0))   # 1 m/s, 20 m off route
    raw = features_series(obs, ROUTE_LINE, STOPS)
    assert raw[-1, SINCE] == 0
    assert raw[-1, ROUTE] == pytest.approx(20, abs=1e-6)
    assert raw[-1, SPEED] == pytest.approx(1.0, abs=0.01)
    assert raw[-1, SHARE] == pytest.approx(1.0)
    assert raw[-1, STILL] == 0
    assert raw[-1, STOP] == pytest.approx(np.hypot(60 * 59 - 2500, 20), abs=1)


def test_share_of_expected_fixes_drops_during_gap():
    obs = track(60, lambda m: (m * 10.0, 0.0) if m < 30 else None)
    raw = features_series(obs, ROUTE_LINE, STOPS)
    assert raw[29, SHARE] == pytest.approx(1.0)
    assert raw[49, SHARE] == pytest.approx(10 / 30)   # window 20..49 holds fixes 20..29
    assert raw[59, SHARE] == 0.0                      # window 30..59 holds none


def test_no_fixes_at_all():
    raw = features_series(np.full((30, 2), np.nan), ROUTE_LINE, STOPS)
    assert raw[-1, SINCE] == 29 and raw[-1, SHARE] == 0
    assert flags(np.full((30, 2), np.nan))[:, 0].any()


def test_cooldown_and_persistence():
    a = Alerting(persistence=10)
    assert [a.step(t, True, False) for t in range(3)] == [True, False, False]
    assert a.step(COOLDOWN - 1, True, False) is False
    assert a.step(COOLDOWN, True, False) is True        # 60 min after the previous alert
    b = Alerting(persistence=10)
    hits = [b.step(t, False, True) for t in range(12)]
    assert hits.index(True) == 9                          # needs 10 consecutive anomalous minutes
    c = Alerting(persistence=10)
    assert not any(c.step(t, False, t % 5 != 0) for t in range(60))  # interrupted runs never alert


def test_simulator_properties():
    rng = np.random.default_rng(1)
    pois = make_pois(rng)
    assert pois.shape == (60, 2)
    d = simulate_day(rng, pois, "dropoff")
    assert np.isnan(d.obs[d.onset:, 0]).all() and not np.isnan(d.obs[:d.onset // 2, 0]).all()
    dv = simulate_day(rng, pois, "deviation")
    from app.detect.detectors import _dist_to_polyline
    far = _dist_to_polyline(dv.truth[-1:], dv.route)[0]
    assert far > 2000
    assert 0.25 * dv.day_end <= dv.onset <= 0.75 * dv.day_end
    lost = np.mean([np.isnan(simulate_day(rng, pois).obs[:, 0]).mean() for _ in range(40)])
    assert 0.02 <= lost <= 0.12   # 2 % random loss + occasional signal gaps


@pytest.fixture(scope="module")
def table3():
    return evaluate(n_train=200, n_val=80, n_normal=200, n_each=50, seed=11)


def test_table3_rules_matched(table3):
    r = table3["sets"]["matched"]["rules"]
    assert r["recall"] >= 0.95          # paper limit: recall >= 95 %
    assert r["fa_per_100"] <= 5         # paper limit: <= 5 false alerts / 100 days
    assert r["kinds"]["dropoff"]["recall"] == 1.0 and r["kinds"]["deviation"]["recall"] == 1.0


def test_table3_rules_degrade_when_behaviour_shifts(table3):
    m, s = table3["sets"]["matched"]["rules"], table3["sets"]["shifted"]["rules"]
    assert s["fa_per_100"] > 10 and s["fa_per_100"] > 5 * max(m["fa_per_100"], 1)
    assert s["recall"] >= 0.95          # recall holds, precision collapses (paper finding)


def test_table3_forest_misses_inactivity_but_is_faster_on_dropoff(table3):
    f, r = table3["sets"]["matched"]["forest"], table3["sets"]["matched"]["rules"]
    assert f["kinds"]["inactivity"]["recall"] < 0.2        # paper: 3 %
    assert f["kinds"]["dropoff"]["recall"] == 1.0
    assert f["kinds"]["dropoff"]["median_delay"] < r["kinds"]["dropoff"]["median_delay"]
    assert f["recall"] < r["recall"]


def test_table3_hybrid_inherits_both_false_alert_sets(table3):
    h, r = table3["sets"]["matched"]["hybrid"], table3["sets"]["matched"]["rules"]
    assert h["recall"] >= r["recall"] - 1e-9
    assert h["fa_per_100"] >= r["fa_per_100"]
