"""Synthetic tourist-day simulator (paper Sec. IV). All coordinates are metres in a local frame.

A day: leave the hotel 08:00-09:30, visit 3-6 of 60 POIs nearest-first, return. Legs < 2 km are walked
(1.0-1.5 m/s), longer legs driven (20-35 km/h). Stops 20-90 min, one lunch stop 45-100 min. Phone reports
once a minute; GPS error is Gauss-Markov (sigma per axis, 1 min correlation); 2 % of fixes lost; 30 % of days
have a 3-15 min signal gap; some legs have a 10-25 min unplanned stop or a 200-600 m shopping detour.
`shifted=True` widens benign behaviour: 10 m error, 3-30 min gaps on 40 % of days, unplanned stops up to
60 min, detours up to 1.5 km. Anomalies start at 25-75 % of the day: drop-off, inactivity (90-240 min),
deviation (3-6 km away from the route, stays).
"""
from dataclasses import dataclass

import numpy as np

REGION = 20_000.0
N_POI = 60


@dataclass
class Day:
    t: np.ndarray          # minute index 0..T-1
    obs: np.ndarray        # (T, 2) observed fixes, NaN where no fix received
    truth: np.ndarray      # (T, 2) true positions
    route: np.ndarray      # planned route polyline (k, 2)
    stops: np.ndarray      # planned stops incl. hotel (m, 2); stops[0] is the hotel
    kind: str              # normal | dropoff | inactivity | deviation
    onset: int | None      # anomaly start minute
    day_end: int           # minute the tourist is back at the hotel / planned end


def make_pois(rng: np.random.Generator) -> np.ndarray:
    return rng.uniform(-REGION / 2, REGION / 2, size=(N_POI, 2))


def _legs(rng, pts, shifted):
    """Breakpoints (time, pos) for the true path, minutes from the day's start."""
    T, P = [0.0], [pts[0]]

    def go(dest, speed):
        d = float(np.hypot(*(dest - P[-1])))
        T.append(T[-1] + d / speed / 60.0 + 1e-6)
        P.append(dest)

    def dwell(mins):
        T.append(T[-1] + mins)
        P.append(P[-1])

    lunch_after = rng.integers(1, max(2, len(pts) - 1))
    for i in range(1, len(pts)):
        a, b = P[-1], pts[i]
        leg = float(np.hypot(*(b - a)))
        speed = rng.uniform(1.0, 1.5) if leg < 2000 else rng.uniform(20, 35) / 3.6
        r = rng.random()
        if leg > 600 and r < 0.15:       # unplanned stop mid-leg
            mid = a + (b - a) * rng.uniform(0.3, 0.7)
            go(mid, speed)
            dwell(rng.uniform(10, 60 if shifted else 25))
        elif leg > 600 and r < 0.30:     # shopping detour
            mid = a + (b - a) * rng.uniform(0.3, 0.7)
            nrm = np.array([-(b - a)[1], (b - a)[0]]) / max(leg, 1.0)
            off = rng.uniform(200, 1500 if shifted else 600) * rng.choice([-1, 1])
            go(mid + nrm * off, speed)
            dwell(rng.uniform(5, 20))
        go(b, speed)
        if i < len(pts) - 1:
            dwell(rng.uniform(45, 100) if i == lunch_after else rng.uniform(20, 90))
    return np.array(T), np.array(P)


def _gm(rng, n, sigma):
    rho = np.exp(-1.0 / 1.0)  # 1 min step, 1 min correlation time
    s = np.sqrt(1 - rho * rho) * sigma
    e = np.empty((n, 2))
    e[0] = rng.normal(0, sigma, 2)
    w = rng.normal(0, 1, (n, 2))
    for i in range(1, n):
        e[i] = rho * e[i - 1] + s * w[i]
    return e


def simulate_day(rng: np.random.Generator, pois: np.ndarray, anomaly: str = "normal",
                 shifted: bool = False) -> Day:
    sigma = 10.0 if shifted else 5.0
    idx = rng.choice(len(pois), size=rng.integers(4, 8), replace=False)
    hotel, chosen = pois[idx[0]], list(pois[idx[1:]])
    order, cur = [], hotel
    while chosen:                                   # nearest-first
        j = int(np.argmin([np.hypot(*(c - cur)) for c in chosen]))
        cur = chosen.pop(j)
        order.append(cur)
    pts = np.array([hotel, *order, hotel])
    T, P = _legs(rng, pts, shifted)
    day_end = int(np.ceil(T[-1]))

    onset = None
    if anomaly != "normal":
        onset = int(rng.uniform(0.25, 0.75) * day_end)

    n = day_end + 1
    horizon = n
    if anomaly in ("dropoff", "inactivity", "deviation"):
        horizon = max(n, onset + 181)
        if anomaly == "inactivity":
            horizon = max(horizon, onset + int(240) + 30)
    t = np.arange(horizon)
    truth = np.stack([np.interp(t, T, P[:, 0]), np.interp(t, T, P[:, 1])], axis=1)

    if anomaly == "inactivity":
        d = int(rng.integers(90, 241))
        p = truth[onset].copy()
        new = truth.copy()
        new[onset:onset + d] = p
        rest = truth[onset: horizon - d]
        new[onset + d:] = rest[: horizon - onset - d]
        truth = new
    elif anomaly == "deviation":
        ang = rng.uniform(0, 2 * np.pi)
        far = truth[onset] + rng.uniform(3000, 6000) * np.array([np.cos(ang), np.sin(ang)])
        mins = np.hypot(*(far - truth[onset])) / (25 / 3.6) / 60
        k = np.arange(horizon - onset)
        f = np.clip(k / max(mins, 1), 0, 1)[:, None]
        truth[onset:] = truth[onset] + (far - truth[onset]) * f

    obs = truth + _gm(rng, len(t), sigma)
    lost = rng.random(len(t)) < 0.02
    obs[lost] = np.nan
    if rng.random() < (0.40 if shifted else 0.30):    # signal gap on the way
        g = int(rng.integers(3, 31 if shifted else 16))
        s0 = int(rng.integers(0, max(1, day_end - g)))
        obs[s0:s0 + g] = np.nan
    if anomaly == "dropoff":
        obs[onset:] = np.nan
    return Day(t, obs, truth, pts, np.vstack([hotel, pts[1:-1]]), anomaly, onset, day_end)
