"""Reproduces paper Table III: rules vs Isolation Forest vs hybrid on matched and shifted test days.
Run at paper scale:  python -m app.detect.evaluate --full"""
import argparse
import time

import numpy as np

from .detectors import Forest, features_series, run_day
from .params import DEFAULTS
from .simulator import make_pois, simulate_day

WINDOW = 180  # an alert counts as a detection if within 180 min after onset
KINDS = ("dropoff", "inactivity", "deviation")


def _days(rng, pois, n_normal, n_each, shifted):
    days = [simulate_day(rng, pois, "normal", shifted) for _ in range(n_normal)]
    for k in KINDS:
        days += [simulate_day(rng, pois, k, shifted) for _ in range(n_each)]
    return days


def _raw(day, r3_minutes: int = 10):
    return features_series(day.obs, day.route, day.stops, r3_minutes=r3_minutes)


def train_forest(rng, pois, n_train, n_val, seed=0):
    train = np.vstack([_raw(simulate_day(rng, pois)) for _ in range(n_train)])
    val = np.vstack([_raw(simulate_day(rng, pois)) for _ in range(n_val)])
    return Forest(seed).fit(train, val), len(train)


def score(days, raws, mode, forest, params=DEFAULTS):
    tp = fp = 0
    per_kind = {k: {"n": 0, "hit": 0, "delays": []} for k in KINDS}
    for d, raw in zip(days, raws):
        alerts = run_day(raw, mode, forest, params=params)
        if d.kind == "normal":
            fp += len(alerts)
            continue
        pk = per_kind[d.kind]
        pk["n"] += 1
        inw = [t for t, _ in alerts if d.onset <= t <= d.onset + WINDOW]
        # Once the anomaly is caught the incident is open, so later repeat alerts are not false.
        # Before the onset (or when the anomaly is missed) every alert is false.
        fp += sum(1 for t, _ in alerts if t < d.onset) if inw else len(alerts)
        if inw:
            tp += 1
            pk["hit"] += 1
            pk["delays"].append(inw[0] - d.onset)
    n_anom = sum(v["n"] for v in per_kind.values())
    prec = tp / (tp + fp) if tp + fp else 1.0
    rec = tp / n_anom if n_anom else 0.0
    f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
    return {"precision": prec, "recall": rec, "f1": f1, "fa_per_100": 100 * fp / len(days),
            "kinds": {k: {"recall": v["hit"] / max(v["n"], 1),
                          "median_delay": float(np.median(v["delays"])) if v["delays"] else None}
                      for k, v in per_kind.items()}}


def evaluate_rules(params, n_normal=40, n_each=15, seed=5):
    """Rules-only what-if on freshly simulated matched and shifted days (same seed -> same days for every candidate)."""
    out = {}
    for name, shifted in (("matched", False), ("shifted", True)):
        rng = np.random.default_rng(seed + (1 if shifted else 0))
        pois = make_pois(rng)
        days = _days(rng, pois, n_normal, n_each, shifted)
        raws = [_raw(d, params.r3_minutes) for d in days]
        r = score(days, raws, "rules", None, params)
        out[name] = {"recall": round(r["recall"], 3), "precision": round(r["precision"], 3), "fa_per_100": round(r["fa_per_100"], 1),
                     "kinds": {k: {"recall": round(v["recall"], 3), "median_delay": v["median_delay"]} for k, v in r["kinds"].items()}}
    return out


def evaluate(n_train=400, n_val=150, n_normal=400, n_each=100, seed=0):
    rng = np.random.default_rng(seed)
    pois = make_pois(rng)
    t0 = time.time()
    forest, rows = train_forest(rng, pois, n_train, n_val, seed)
    out = {"train_rows": rows, "threshold": forest.threshold, "sets": {}}
    for name, shifted in (("matched", False), ("shifted", True)):
        days = _days(rng, pois, n_normal, n_each, shifted)
        raws = [_raw(d) for d in days]
        out["sets"][name] = {m: score(days, raws, m, forest) for m in ("rules", "forest", "hybrid")}
    out["seconds"] = time.time() - t0
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--full", action="store_true", help="paper scale: 1200 train, 400 val, 1000+3x200 test")
    a = ap.parse_args()
    r = evaluate(1200, 400, 1000, 200) if a.full else evaluate()
    for s, ms in r["sets"].items():
        print(f"== {s} ==")
        for m, v in ms.items():
            print(f"{m:7s} P={v['precision']:.3f} R={v['recall']:.3f} F1={v['f1']:.3f} FA/100d={v['fa_per_100']:.1f}  "
                  + " ".join(f"{k}:{x['recall']:.0%}/{x['median_delay']}" for k, x in v["kinds"].items()))
    print(f"{r['seconds']:.0f}s")


if __name__ == "__main__":
    main()
