"""Bridges the synchronous alert pub/sub (events.py) to asyncio WebSocket clients."""
import asyncio

from . import events


class Hub:
    def __init__(self):
        self.clients: set[tuple[asyncio.Queue, asyncio.AbstractEventLoop]] = set()
        events.subscribe(self._on_alert)

    def _on_alert(self, msg: dict) -> None:
        # called from worker threads or the event loop; hand over thread-safely
        for q, loop in list(self.clients):
            try:
                loop.call_soon_threadsafe(q.put_nowait, msg)
            except RuntimeError:
                self.clients.discard((q, loop))  # loop already closed

    def add(self) -> tuple[asyncio.Queue, asyncio.AbstractEventLoop]:
        entry = (asyncio.Queue(maxsize=1000), asyncio.get_running_loop())
        self.clients.add(entry)
        return entry

    def remove(self, entry) -> None:
        self.clients.discard(entry)


hub: Hub | None = None


def get_hub() -> Hub:
    """(Re)attach to events; tests clear subscribers between runs."""
    global hub
    if hub is None or hub._on_alert not in events._subscribers:
        hub = Hub()
    return hub
