"""Holds the 'A' term (normalised anomaly score of the last hour) for the safety score.
Filled by the detection service in Phase 5; 0.0 until then."""
_recent: dict[int, float] = {}


def set_recent_anomaly(tourist_id: int, value: float) -> None:
    _recent[tourist_id] = min(max(value, 0.0), 1.0)


def recent_anomaly(tourist_id: int) -> float:
    return _recent.get(tourist_id, 0.0)
