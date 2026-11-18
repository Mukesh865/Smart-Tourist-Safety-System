"""Automated version of the paper's Table V ("limits set before testing and status today").
Every number is measured on THIS machine with synthetic data, so it shows whether the implementation
meets the limits, not how a real deployment performs. Field-trial rows stay "next stage"."""
import json
import math
import random
import statistics
import time
from pathlib import Path

from sqlmodel import Session, select

from . import events
from .detect.evaluate import evaluate as evaluate_detection
from .geo.engine import GeoFenceEngine
from .ledger import core
from .models import LedgerRecord

M_LAT = 111_194.9
LAT0, LON0 = 25.5788, 91.8933


def _ll(x, y):
    return LAT0 + y / M_LAT, LON0 + x / (M_LAT * math.cos(math.radians(LAT0)))


def _square(cx, cy, half):
    return [_ll(cx + dx, cy + dy) for dx, dy in ((-half, -half), (half, -half), (half, half), (-half, half))]


def _gm(rng, n, sigma=5.0, dt=15.0, tau=60.0):
    rho = math.exp(-dt / tau)
    s = math.sqrt(1 - rho * rho) * sigma
    e = rng.gauss(0, sigma)
    for _ in range(n):
        yield e
        e = rho * e + s * rng.gauss(0, 1)


def ledger_check_us(n_ids: int = 256, trials: int = 200) -> float:
    auth = core.Authority.load_or_create(Path(".") / "keys" / "authority.pem")
    recs, leaves = [], []
    for k in range(n_ids):
        salts = [core.new_salt() for _ in range(3)]
        c = [core.commit(s, f"v{k}-{i}") for i, s in enumerate(salts)]
        r = core.make_record(f"B-{k}", "BENCH", c, 0, 2_000_000_000)
        recs.append(r)
        leaves.append(core.leaf_hash(r))
    header = core.make_header(0, core.ZERO_HASH, core.merkle_root(leaves), int(time.time()))
    payload = core.build_credential(recs[7], core.merkle_path(leaves, 7), header, auth.sign_header(header))
    t0 = time.perf_counter()
    for _ in range(trials):
        core.verify_credential(payload, auth.public_key)
    return (time.perf_counter() - t0) / trials * 1e6


def geo_lookup_us(n_zones: int = 5000, n_fixes: int = 3000) -> float:
    rng = random.Random(3)
    zones = []
    for i in range(n_zones):
        cx, cy, r = rng.uniform(-10000, 10000), rng.uniform(-10000, 10000), rng.uniform(150, 800)
        angs = sorted(rng.uniform(0, 2 * math.pi) for _ in range(rng.randint(6, 16)))
        pts = [_ll(cx + r * rng.uniform(.6, 1) * math.cos(a), cy + r * rng.uniform(.6, 1) * math.sin(a)) for a in angs]
        zones.append({"id": i, "name": f"z{i}", "polygon": pts, "risk_weight": rng.random(), "no_entry": False})
    eng = GeoFenceEngine(zones)
    pts = [(rng.uniform(-10000, 10000), rng.uniform(-10000, 10000)) for _ in range(n_fixes)]
    runs = []
    for _ in range(3):      # best of three: a busy machine slows single runs, the minimum is the true cost
        t0 = time.perf_counter()
        for x, y in pts:
            for z in eng.candidates(x, y):
                z.depth(x, y)
        runs.append((time.perf_counter() - t0) / n_fixes * 1e6)
    return min(runs)


def false_geo_alerts_per_km(km: float = 20.0, offset_m: float = 20.0, k: int = 3, b: float = 20.0) -> float:
    half = 5000
    eng = GeoFenceEngine([{"id": 1, "name": "Z", "polygon": _square(0, 0, half), "risk_weight": .8, "no_entry": False}], k=k, b=b)
    rng = random.Random(0)
    n = int(km * 1000 / (1.3 * 15))
    ex, ey = _gm(rng, n), _gm(rng, n)
    y, alerts = -half, 0
    for _ in range(n):
        y += 1.3 * 15
        if y > half:
            y = -half
        alerts += len(eng.on_fix(1, *_ll(half + offset_m + next(ex), y + next(ey))))
    return alerts / km


def entry_delay_median_s(trials: int = 40) -> float:
    delays = []
    for seed in range(trials):
        rng = random.Random(seed)
        eng = GeoFenceEngine([{"id": 1, "name": "Z", "polygon": _square(0, 0, 2000), "risk_weight": .8, "no_entry": False}])
        ex, ey = _gm(rng, 60), _gm(rng, 60)
        x0 = 2000 + 100 - rng.uniform(0, 19.5)
        t_cross = (x0 - 2000) / 1.3
        for step in range(60):
            if eng.on_fix(1, *_ll(x0 - 1.3 * step * 15 + next(ex), next(ey))):
                delays.append(step * 15 - t_cross)
                break
    return statistics.median(delays)


def panic_publish_s() -> float:
    """Server-side part only: time from creating a panic alert to a dashboard subscriber receiving it."""
    class _A:
        id, tourist_id, kind, detail, lat, lon, status = 0, 0, "panic", "bench", None, None, "open"
        from datetime import datetime, timezone
        created_at = datetime.now(timezone.utc)
    got = []
    events.subscribe(got.append)
    try:
        t0 = time.perf_counter()
        events.publish(_A())
        return time.perf_counter() - t0 if got else float("inf")
    finally:
        events._subscribers.remove(got.append) if got.append in events._subscribers else None


def ledger_has_no_personal_data(session: Session) -> bool:
    allowed = {"i", "s", "c", "f", "t"}
    for r in session.exec(select(LedgerRecord)).all():
        d = json.loads(r.record_json)
        if set(d) != allowed or len(d["c"]) != 3 or any(len(x) != 43 for x in d["c"]):
            return False
    return True


def _row(measure, limit, value, ok, unit="", note=""):
    return {"measure": measure, "limit": limit, "measured": value, "unit": unit,
            "status": "met" if ok else "NOT MET", "note": note}


_detection_cache: dict | None = None


def table5(session: Session, detection: bool = False) -> dict:
    global _detection_cache
    ledger_us, lookup_us = ledger_check_us(), geo_lookup_us()
    fa_km, delay, panic_s = false_geo_alerts_per_km(), entry_delay_median_s(), panic_publish_s()
    rows = [
        _row("Personal data on the ledger", "none", "none" if ledger_has_no_personal_data(session) else "FOUND",
             ledger_has_no_personal_data(session), note="checked on this database's ledger records"),
        _row("ID check time", "< 1,000 us", round(ledger_us, 1), ledger_us < 1000, "us", "256-ID block, this machine"),
        _row("Geo-fence lookup per fix", "< 100 us", round(lookup_us, 1), lookup_us < 100, "us", "5,000 zones, this machine"),
        _row("False geo-fence alerts per km", "< 0.01", round(fa_km, 4), fa_km < 0.01, "/km",
             "simulated 20 km edge walk, b = 4 sigma, k = 3"),
        _row("Entry alert delay (median)", "< 60 s", round(delay, 1), delay < 60, "s", "simulated walker at 1.3 m/s"),
        _row("Panic alert to dashboard", "< 10 s", round(panic_s, 4), panic_s < 10, "s", "server side only; real network not measured"),
    ]
    det = None
    if detection:
        det = _detection_cache = evaluate_detection(n_train=200, n_val=80, n_normal=200, n_each=50, seed=11)
    det = det or _detection_cache
    if det:
        m = det["sets"]["matched"]["rules"]
        rows.append(_row("False anomaly alerts / 100 days", "<= 5", round(m["fa_per_100"], 1), m["fa_per_100"] <= 5,
                         note="rules, matched simulated days. On shifted days: "
                              f"{det['sets']['shifted']['rules']['fa_per_100']:.1f} (limit missed, as in the paper)"))
        rows.append(_row("Recall of injected anomalies", ">= 95 %", round(100 * m["recall"], 1), m["recall"] >= .95, "%",
                         "rules, matched simulated days"))
    else:
        rows.append({"measure": "Anomaly false alerts / recall", "limit": "<= 5 / >= 95 %", "measured": "not run",
                     "unit": "", "status": "not run", "note": "run the detection benchmark (about a minute)"})
    for name, lim in (("Battery use per 8 h day", "< 10 %"), ("SUS usability score", ">= 71.4"),
                      ("Panic alert over 4G / 2G / SMS", "< 10 s")):
        rows.append({"measure": name, "limit": lim, "measured": "-", "unit": "", "status": "next stage",
                     "note": "needs the real phone app and volunteer visitors (field trial)"})
    return {"rows": rows, "detection_detail": det, "generated_at": time.time()}
