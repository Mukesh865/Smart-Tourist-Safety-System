"""Geo-fence engine (paper Sec. III-B, Algorithm 1 OnFix).

* equirectangular projection to metres around a regional origin
* 1 km uniform grid index: ray casting only on zones whose (padded) bounding box overlaps the cell
* entry alert only after k consecutive fixes at least b metres INSIDE a zone
* zones flagged no_entry also get an outer warning ring, tested with the same debounce
"""
import math
from dataclasses import dataclass, field

R_EARTH = 6_371_000.0
CELL_M = 1000.0
SIGMA_M = 5.0              # typical per-axis phone GPS error (paper)
DEFAULT_K = 3              # debounce (paper Sec. V-A)
DEFAULT_B = 4 * SIGMA_M    # buffer = 4 sigma = 20 m
WARN_RING_M = 50.0


class Projection:
    def __init__(self, lat0: float, lon0: float):
        self.lat0, self.lon0 = lat0, lon0
        self.kx = math.radians(1) * R_EARTH * math.cos(math.radians(lat0))
        self.ky = math.radians(1) * R_EARTH

    def to_xy(self, lat: float, lon: float) -> tuple[float, float]:
        return (lon - self.lon0) * self.kx, (lat - self.lat0) * self.ky


def point_in_polygon(x: float, y: float, poly: list[tuple[float, float]]) -> bool:
    """Ray casting (Shimrat 1962)."""
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def dist_to_boundary(x: float, y: float, poly: list[tuple[float, float]]) -> float:
    best = math.inf
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        dx, dy = x2 - x1, y2 - y1
        L2 = dx * dx + dy * dy
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / L2))
        d = math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))
        best = min(best, d)
    return best


@dataclass
class ZoneShape:
    id: int
    name: str
    risk: float
    no_entry: bool
    poly: list[tuple[float, float]]  # projected metres
    bbox: tuple[float, float, float, float] = field(init=False)

    def __post_init__(self):
        xs = [p[0] for p in self.poly]
        ys = [p[1] for p in self.poly]
        self.bbox = (min(xs), min(ys), max(xs), max(ys))

    def depth(self, x: float, y: float) -> float:
        """Signed distance to the boundary in metres: >0 inside, <0 outside."""
        d = dist_to_boundary(x, y, self.poly)
        return d if point_in_polygon(x, y, self.poly) else -d


@dataclass
class Event:
    kind: str  # zone_entry | zone_warning
    zone_id: int
    zone_name: str
    risk: float
    depth: float


class GeoFenceEngine:
    def __init__(self, zones: list[dict], k: int = DEFAULT_K, b: float = DEFAULT_B,
                 warn_ring: float = WARN_RING_M, use_grid: bool = True):
        """zones: [{id, name, polygon: [[lat, lon], ...], risk_weight, no_entry}]"""
        self.k, self.b, self.warn_ring, self.use_grid = k, b, warn_ring, use_grid
        pts = [p for z in zones for p in z["polygon"]]
        if pts:
            self.proj = Projection(sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))
        else:
            self.proj = Projection(0.0, 0.0)
        self.zones = [
            ZoneShape(z["id"], z["name"], float(z["risk_weight"]), bool(z["no_entry"]),
                      [self.proj.to_xy(*p) for p in z["polygon"]])
            for z in zones
        ]
        self.grid: dict[tuple[int, int], list[ZoneShape]] = {}
        pad = self._pad = max(self.b, self.warn_ring) + 1.0
        for z in self.zones:
            x0, y0, x1, y1 = z.bbox
            for cx in range(int((x0 - pad) // CELL_M), int((x1 + pad) // CELL_M) + 1):
                for cy in range(int((y0 - pad) // CELL_M), int((y1 + pad) // CELL_M) + 1):
                    self.grid.setdefault((cx, cy), []).append(z)
        self._count: dict[tuple, int] = {}   # (tourist, zone, 'in'|'ring') -> consecutive fixes

    # ---- lookup ----
    def candidates(self, x: float, y: float) -> list[ZoneShape]:
        """Grid cell lookup, then a cheap padded-bounding-box reject before any polygon maths."""
        zs = self.zones if not self.use_grid else self.grid.get((int(x // CELL_M), int(y // CELL_M)), ())
        p = self._pad
        return [z for z in zs if z.bbox[0] - p <= x <= z.bbox[2] + p and z.bbox[1] - p <= y <= z.bbox[3] + p]

    def nearby_risk(self, lat: float, lon: float, radius: float = 1000.0) -> float:
        """Z in the safety score: highest risk weight of any zone within `radius` m."""
        x, y = self.proj.to_xy(lat, lon)
        z = 0.0
        for zone in self.zones:
            x0, y0, x1, y1 = zone.bbox
            if x0 - radius <= x <= x1 + radius and y0 - radius <= y <= y1 + radius \
                    and zone.depth(x, y) >= -radius:
                z = max(z, zone.risk)
        return z

    # ---- Algorithm 1: OnFix ----
    def on_fix(self, tourist_id: int, lat: float, lon: float, accuracy: float | None = None) -> list[Event]:
        x, y = self.proj.to_xy(lat, lon)
        b = self.b if accuracy is None else max(self.b, 2.6 * accuracy)  # 2.6 x 68% radius ~ 4 sigma
        events: list[Event] = []
        seen: set[int] = set()
        for z in self.candidates(x, y):
            seen.add(z.id)
            d = z.depth(x, y)
            events += self._step(tourist_id, z, "in", d >= b, "zone_entry", d)
            if z.no_entry:
                in_ring = -self.warn_ring <= d < 0
                events += self._step(tourist_id, z, "ring", in_ring, "zone_warning", d)
        # zones not near this fix: reset their counters
        for key in [k for k in self._count if k[0] == tourist_id and k[1] not in seen]:
            self._count[key] = 0
        return events

    def _step(self, tid: int, z: ZoneShape, tag: str, hit: bool, kind: str, d: float) -> list[Event]:
        key = (tid, z.id, tag)
        if hit:
            self._count[key] = self._count.get(key, 0) + 1
            if self._count[key] == self.k:  # fires once per entry
                return [Event(kind, z.id, z.name, z.risk, d)]
        else:
            self._count[key] = 0
        return []
