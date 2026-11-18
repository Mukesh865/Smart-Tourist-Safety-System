"""In-process alert pub/sub. Phase 6 attaches WebSocket subscribers; until then it only
records the publish time so panic-to-dashboard latency can be tested."""
import time
from typing import Callable

_subscribers: list[Callable[[dict], None]] = []


def subscribe(fn: Callable[[dict], None]) -> None:
    _subscribers.append(fn)


def clear() -> None:
    _subscribers.clear()


def publish(alert) -> None:
    msg = {"id": alert.id, "tourist_id": alert.tourist_id, "kind": alert.kind, "detail": alert.detail,
           "lat": alert.lat, "lon": alert.lon, "status": alert.status,
           "created_at": alert.created_at.isoformat(), "published_at": time.time()}
    for fn in list(_subscribers):
        try:
            fn(msg)
        except Exception:
            pass  # one broken subscriber must not block panic delivery
