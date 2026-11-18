"""Small in-memory sliding-window rate limiter (single process). For several workers use a shared store."""
import time
from collections import defaultdict, deque

from fastapi import HTTPException, Request

from .config import settings

_hits: dict[tuple[str, str], deque] = defaultdict(deque)


def reset() -> None:
    _hits.clear()


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def check(bucket: str, key: str, limit: int, window_s: int) -> None:
    """Raise 429 when `key` made more than `limit` calls to `bucket` within `window_s` seconds."""
    if not settings.rate_limit_enabled:
        return
    now = time.monotonic()
    q = _hits[(bucket, key)]
    while q and now - q[0] > window_s:
        q.popleft()
    if len(q) >= limit:
        retry = max(1, int(window_s - (now - q[0])))
        raise HTTPException(429, "Too many requests. Try again later.", headers={"Retry-After": str(retry)})
    q.append(now)
