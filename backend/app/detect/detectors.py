"""Per-minute features, rules R1-R3 and the Isolation Forest (paper Sec. III-C, Algorithm 1)."""
from dataclasses import dataclass

import numpy as np
from sklearn.ensemble import IsolationForest

# raw feature columns
SINCE, ROUTE, STOP, STILL, SPEED, SHARE, HOTEL, ROUTE_MIN10 = range(8)
N_MODEL = 6  # first six columns feed the forest; the last two only support the rules

COOLDOWN = 60   # default; the live value comes from Params.cooldown_min
from .params import DEFAULTS, Params


def _dist_to_polyline(p: np.ndarray, line: np.ndarray) -> np.ndarray:
    """Distance from each of n points to a polyline (k,2)."""
    if len(line) == 1:
        return np.hypot(*(p - line[0]).T)
    a, b = line[:-1][None], line[1:][None]
    ab = b - a
    L2 = (ab ** 2).sum(-1)
    t = np.clip(((p[:, None] - a) * ab).sum(-1) / np.where(L2 == 0, 1, L2), 0, 1)
    proj = a + t[..., None] * ab
    return np.hypot(*(p[:, None] - proj).transpose(2, 0, 1)).min(1)


def features_series(obs: np.ndarray, route: np.ndarray, stops: np.ndarray, n: int | None = None,
                    r3_minutes: int = 10) -> np.ndarray:
    """Raw feature rows for every minute 0..n-1, using only fixes received up to that minute.
    obs: (T,2) with NaN for missing fixes. stops[0] is the hotel."""
    n = len(obs) if n is None else n
    obs = obs[:n]
    have = ~np.isnan(obs[:, 0])
    out = np.zeros((n, 8))
    if not have.any():
        out[:, SINCE] = np.arange(n)
        out[:, SHARE] = 0
        return out
    fx = np.where(have)[0]
    pos = obs[fx]
    r_d = _dist_to_polyline(pos, route)
    s_d = np.hypot(*(pos[:, None] - stops[None]).transpose(2, 0, 1)).min(1)
    h_d = np.hypot(*(pos - stops[0]).T)
    # for each fix, minutes it has been within 60 m of its own position (consecutive received fixes)
    still = np.zeros(len(fx))
    for i in range(len(fx)):
        j = i
        while j > 0 and np.hypot(*(pos[j - 1] - pos[i])) < 60:
            j -= 1
        still[i] = fx[i] - fx[j]
    # speed over last 10 min of fixes
    speed = np.zeros(len(fx))
    for i in range(len(fx)):
        j = np.searchsorted(fx, fx[i] - 10)
        if i - j >= 1:
            speed[i] = np.hypot(*(pos[i] - pos[j])) / max((fx[i] - fx[j]) * 60.0, 1.0)
    # route-distance minimum over fixes in the last 10 min
    rmin = np.zeros(len(fx))
    for i in range(len(fx)):
        j = np.searchsorted(fx, fx[i] - (r3_minutes - 1))
        rmin[i] = r_d[j:i + 1].min()
    csum = np.concatenate([[0], np.cumsum(have)])
    for m in range(n):
        k = np.searchsorted(fx, m, side="right") - 1   # last fix at or before minute m
        if k < 0:
            out[m, SINCE] = m + 1
            continue
        lo = max(0, m - 29)
        out[m] = [m - fx[k], r_d[k], s_d[k], still[k], speed[k],
                  (csum[m + 1] - csum[lo]) / 30.0, h_d[k],
                  # R3 needs a recent fix (a silent phone is R1's job) and 10 min of tracking history
                  rmin[k] if (m - fx[k] < r3_minutes and m >= r3_minutes - 1) else 0.0]
    return out


def model_view(raw: np.ndarray) -> np.ndarray:
    """Log-scale distances and times (paper)."""
    x = raw[:, :N_MODEL].copy()
    for c in (SINCE, ROUTE, STOP, STILL):
        x[:, c] = np.log1p(x[:, c])
    return x


def rule_flags(raw: np.ndarray, p: Params = DEFAULTS) -> np.ndarray:
    """(n,3) boolean: R1 drop-off, R2 inactivity, R3 deviation."""
    r1 = raw[:, SINCE] > p.r1_minutes
    r2 = ((raw[:, STILL] > p.r2_still_min) & (raw[:, STOP] > p.r2_dist_m)) | ((raw[:, STILL] > p.r2_anywhere_min) & (raw[:, HOTEL] > p.r2_dist_m))
    r3 = raw[:, ROUTE_MIN10] > p.r3_km * 1000
    return np.stack([r1, r2, r3], axis=1)


class Forest:
    """Isolation Forest: 200 trees x 512 rows, trained on normal-day minutes only."""

    def __init__(self, seed: int = 0):
        self.model = IsolationForest(n_estimators=200, max_samples=512, random_state=seed)
        self.threshold = np.inf

    def fit(self, normal_raw: np.ndarray, val_raw: np.ndarray | None = None, pct: float = 99.5):
        self.model.fit(model_view(normal_raw))
        ref = model_view(val_raw if val_raw is not None else normal_raw)
        self.threshold = float(np.percentile(self.score(ref, prepared=True), pct))
        return self

    def score(self, x: np.ndarray, prepared: bool = False) -> np.ndarray:
        return -self.model.score_samples(x if prepared else model_view(x))


@dataclass
class Alerting:
    """Algorithm 1 EveryMinute for one tourist (state: run length m, last alert l)."""
    persistence: int = 10
    m: int = 0
    last: float = -1e9
    cooldown: float = COOLDOWN

    def step(self, t: float, rules_hit: bool, forest_hit: bool) -> bool:
        self.m = (self.m + 1) if forest_hit else 0
        if (rules_hit or self.m >= self.persistence) and t - self.last >= self.cooldown:
            self.last = t
            return True
        return False


def run_day(raw: np.ndarray, mode: str, forest: Forest | None, persistence: int = 10,
            start: int = 0, params: Params = DEFAULTS) -> list[tuple[int, str]]:
    """Alerts as (minute, which-rule) for a whole day. mode: rules | forest | hybrid."""
    flags = rule_flags(raw, params)
    fh = np.zeros(len(raw), bool)
    if mode in ("forest", "hybrid"):
        fh = forest.score(raw) > forest.threshold
    a, alerts = Alerting(persistence, cooldown=params.cooldown_min), []
    for t in range(start, len(raw)):
        rh = bool(flags[t].any()) and mode in ("rules", "hybrid")
        if a.step(t, rh, bool(fh[t])):
            name = "R1" if flags[t, 0] else "R2" if flags[t, 1] else "R3" if flags[t, 2] else "IF"
            alerts.append((t, name if rh else "IF"))
    return alerts
