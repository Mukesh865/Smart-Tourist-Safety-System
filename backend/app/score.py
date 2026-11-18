"""Tourist safety score (paper Sec. III-E): S = 100 (1 - 0.5 Z - 0.2 N - 0.3 A).
Z: highest risk weight of any zone within 1 km; N: 1 between 20:00 and 05:00 (local), else 0;
A: normalised anomaly score of the last hour (0 until the detection service, Phase 5).
The weights are the paper's starting point, not calibrated values."""
from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))  # India has no DST; avoids needing tzdata on Windows


def is_night(ts: datetime, start: int = 20, end: int = 5) -> int:
    h = ts.astimezone(IST).hour
    wraps_midnight = start > end            # e.g. 20 -> 5; a same-day window (e.g. 1 -> 6) does not wrap
    return int((h >= start or h < end) if wraps_midnight else (start <= h < end))


def safety_score(z: float, night: int, a: float) -> float:
    z, a = min(max(z, 0.0), 1.0), min(max(a, 0.0), 1.0)
    return round(100 * (1 - 0.5 * z - 0.2 * night - 0.3 * a), 1)
