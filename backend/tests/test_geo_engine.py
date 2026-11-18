"""Reproduces the paper's geo-fence measurements (Table II, Fig. 4, alert delay) as tests."""
import math
import random
import statistics
import time

import pytest
from shapely.geometry import Point, Polygon

from app.geo.engine import GeoFenceEngine, Projection

LAT0, LON0 = 25.5788, 91.8933  # Shillong
M_PER_DEG_LAT = 111_194.9


def ll(x_m, y_m):
    """Metres east/north of origin -> (lat, lon)."""
    return (LAT0 + y_m / M_PER_DEG_LAT,
            LON0 + x_m / (M_PER_DEG_LAT * math.cos(math.radians(LAT0))))


def square(cx, cy, half):
    return [ll(cx - half, cy - half), ll(cx + half, cy - half), ll(cx + half, cy + half), ll(cx - half, cy + half)]


def random_zones(n, seed=0, region=20_000):
    rng = random.Random(seed)
    zs = []
    for i in range(n):
        cx, cy = rng.uniform(-region / 2, region / 2), rng.uniform(-region / 2, region / 2)
        r, nv = rng.uniform(150, 800), rng.randint(6, 16)
        angs = sorted(rng.uniform(0, 2 * math.pi) for _ in range(nv))
        pts = [ll(cx + r * rng.uniform(0.6, 1) * math.cos(a), cy + r * rng.uniform(0.6, 1) * math.sin(a)) for a in angs]
        zs.append({"id": i, "name": f"z{i}", "polygon": pts, "risk_weight": rng.random(), "no_entry": False})
    return zs


def test_projection_error_below_0_08_percent():
    p = Projection(LAT0, LON0)
    rng = random.Random(1)
    worst = 0.0
    for _ in range(500):
        a = (LAT0 + rng.uniform(-0.09, 0.09), LON0 + rng.uniform(-0.09, 0.09))  # ~20 km box
        b = (LAT0 + rng.uniform(-0.09, 0.09), LON0 + rng.uniform(-0.09, 0.09))
        (x1, y1), (x2, y2) = p.to_xy(*a), p.to_xy(*b)
        la1, lo1, la2, lo2 = map(math.radians, (*a, *b))
        h = 2 * 6371000 * math.asin(math.sqrt(math.sin((la2 - la1) / 2) ** 2 +
                                              math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2))
        if h > 1000:
            worst = max(worst, abs(math.hypot(x2 - x1, y2 - y1) - h) / h)
    assert worst < 0.0008, worst


@pytest.mark.parametrize("n", [10, 100, 1000, 5000])
def test_grid_matches_full_scan_and_shapely(n):
    zs = random_zones(n)
    grid = GeoFenceEngine(zs, use_grid=True)
    scan = GeoFenceEngine(zs, use_grid=False)
    polys = {z.id: Polygon(z.poly) for z in grid.zones}
    rng = random.Random(7)
    for _ in range(500 if n >= 1000 else 5000):
        x, y = rng.uniform(-10_000, 10_000), rng.uniform(-10_000, 10_000)
        inside_grid = {z.id for z in grid.candidates(x, y) if z.depth(x, y) > 0}
        inside_scan = {z.id for z in scan.candidates(x, y) if z.depth(x, y) > 0}
        oracle = {i for i, p in polys.items() if p.contains(Point(x, y))}
        assert inside_grid == inside_scan == oracle


def test_lookup_time_under_100us_with_5000_zones():
    """Paper Table V limit: < 100 us per fix (paper: 8.0 us on M2)."""
    eng = GeoFenceEngine(random_zones(5000))
    rng = random.Random(3)
    pts = [(rng.uniform(-10_000, 10_000), rng.uniform(-10_000, 10_000)) for _ in range(5000)]
    runs = []
    for _ in range(3):   # best of three: a busy machine slows single runs, the minimum is the true cost
        t0 = time.perf_counter()
        for x, y in pts:
            for z in eng.candidates(x, y):
                z.depth(x, y)
        runs.append((time.perf_counter() - t0) / len(pts) * 1e6)
    us = min(runs)
    print(f"grid lookup: {us:.1f} us/fix")
    assert us < 100


def gm_error(rng, n, sigma=5.0, dt=15.0, tau=60.0):
    """First-order Gauss-Markov GPS error, per axis."""
    rho = math.exp(-dt / tau)
    s = math.sqrt(1 - rho * rho) * sigma
    e = rng.gauss(0, sigma)
    for _ in range(n):
        yield e
        e = rho * e + s * rng.gauss(0, 1)


def edge_walk_false_alerts(offset_m, k, b, km=40, sigma=5.0, seed=0):
    """Walk along the east edge of a big square, offset_m outside it; count false entry alerts."""
    half = 5000
    eng = GeoFenceEngine([{"id": 1, "name": "Z", "polygon": square(0, 0, half), "risk_weight": .8,
                           "no_entry": False}], k=k, b=b)
    rng = random.Random(seed)
    n = int(km * 1000 / (1.3 * 15))
    ex, ey = gm_error(rng, n, sigma), gm_error(rng, n, sigma)
    alerts, y = 0, -half
    for _ in range(n):
        y += 1.3 * 15
        if y > half:
            y = -half
        lat, lon = ll(half + offset_m + next(ex), y + next(ey))
        alerts += len(eng.on_fix(1, lat, lon))
    return alerts / km


def test_buffer_removes_false_alerts_but_debounce_alone_does_not():
    on_edge_k1 = edge_walk_false_alerts(0, k=1, b=0)
    on_edge_k4 = edge_walk_false_alerts(0, k=4, b=0)
    assert on_edge_k1 > 1                      # paper: ~5.6/km at the edge
    assert on_edge_k4 > 0.3 * on_edge_k1       # correlated error: debounce alone helps only partly
    # paper limit: < 0.01 false alerts/km with b = 4 sigma and walker 20 m outside
    assert edge_walk_false_alerts(20, k=3, b=20) < 0.01
    assert edge_walk_false_alerts(0, k=3, b=20) < 0.01  # even right on the edge, the buffer holds


def test_entry_delay_under_one_minute():
    delays = []
    for seed in range(60):
        rng = random.Random(seed)
        eng = GeoFenceEngine([{"id": 1, "name": "Z", "polygon": square(0, 0, 2000), "risk_weight": .8,
                               "no_entry": False}], k=3, b=20)
        n = 60
        ex, ey = gm_error(rng, n), gm_error(rng, n)
        x = 2000 + 100 - rng.uniform(0, 19.5)  # start ~100 m outside the east edge, walk in at 1.3 m/s
        t_cross = (x - 2000) / 1.3
        for step in range(n):
            t = step * 15
            pos = x - 1.3 * t
            ev = eng.on_fix(1, *ll(pos + next(ex), next(ey) + 0.0))
            if ev:
                delays.append(t - t_cross)
                break
    med = statistics.median(delays)
    print("median entry delay (s):", med)
    assert len(delays) == 60 and med < 60


def test_alert_fires_once_per_entry_and_rearms():
    eng = GeoFenceEngine([{"id": 1, "name": "Z", "polygon": square(0, 0, 500), "risk_weight": .5, "no_entry": False}])
    inside, outside = ll(0, 0), ll(2000, 0)
    fired = [bool(eng.on_fix(1, *inside)) for _ in range(6)]
    assert fired == [False, False, True, False, False, False]
    eng.on_fix(1, *outside)
    fired = [bool(eng.on_fix(1, *inside)) for _ in range(3)]
    assert fired == [False, False, True]


def test_buffer_blocks_shallow_entry():
    eng = GeoFenceEngine([{"id": 1, "name": "Z", "polygon": square(0, 0, 500), "risk_weight": .5, "no_entry": False}])
    shallow = ll(490, 0)   # 10 m inside the edge, less than b = 20 m
    assert not any(eng.on_fix(1, *shallow) for _ in range(10))
    deep = ll(470, 0)      # 30 m inside
    assert any([bool(eng.on_fix(1, *deep)) for _ in range(3)])


def test_no_entry_warning_ring():
    eng = GeoFenceEngine([{"id": 1, "name": "Border", "polygon": square(0, 0, 500), "risk_weight": 1,
                           "no_entry": True}])
    ring = ll(520, 0)  # 20 m outside
    evs = [e for _ in range(3) for e in eng.on_fix(1, *ring)]
    assert [e.kind for e in evs] == ["zone_warning"]
    far = ll(700, 0)  # 200 m outside: no warning
    assert not any(eng.on_fix(2, *far) for _ in range(5))


def test_per_tourist_counters_are_independent():
    eng = GeoFenceEngine([{"id": 1, "name": "Z", "polygon": square(0, 0, 500), "risk_weight": .5, "no_entry": False}])
    for _ in range(2):
        eng.on_fix(1, *ll(0, 0))
        eng.on_fix(2, *ll(0, 0))
    assert eng.on_fix(1, *ll(0, 0)) and eng.on_fix(2, *ll(0, 0))


def test_accuracy_widens_buffer():
    eng = GeoFenceEngine([{"id": 1, "name": "Z", "polygon": square(0, 0, 500), "risk_weight": .5, "no_entry": False}])
    p = ll(465, 0)  # 35 m inside
    assert any(bool(eng.on_fix(1, *p, accuracy=5)) for _ in range(3))
    eng2 = GeoFenceEngine([{"id": 1, "name": "Z", "polygon": square(0, 0, 500), "risk_weight": .5, "no_entry": False}])
    assert not any(eng2.on_fix(1, *p, accuracy=20) for _ in range(5))  # needs 52 m


def test_nearby_risk():
    eng = GeoFenceEngine([{"id": 1, "name": "Z", "polygon": square(0, 0, 500), "risk_weight": .7, "no_entry": False}])
    assert eng.nearby_risk(*ll(0, 0)) == .7
    assert eng.nearby_risk(*ll(1400, 0)) == .7   # 900 m from edge
    assert eng.nearby_risk(*ll(5000, 0)) == 0.0
