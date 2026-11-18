"""Tunable detection / geo-fence parameters. Defaults are the paper's values; the admin can calibrate them per district
(the paper's own recommendation: thresholds should come from local field data, e.g. the longest normal signal gap)."""
from dataclasses import asdict, dataclass, fields


@dataclass(frozen=True)
class Params:
    r1_minutes: float = 20          # R1: no fix for longer than this
    r2_still_min: float = 40        # R2: still for longer than this ...
    r2_dist_m: float = 200          # ... and farther than this from any planned stop
    r2_anywhere_min: float = 150    # R2: or still this long anywhere except the hotel
    r3_km: float = 1.0              # R3: farther than this from the planned route ...
    r3_minutes: int = 10            # ... for this long
    cooldown_min: float = 60        # minutes between alerts for one tourist
    geo_k: int = 3                  # consecutive fixes required inside a zone
    geo_buffer_m: float = 20        # fix must be this far inside (about 4 sigma of GPS error)
    warn_ring_m: float = 50         # warning ring around no-entry zones
    night_start: int = 20           # hour (IST) night begins
    night_end: int = 5              # hour (IST) night ends


# (min, max) accepted for each field
BOUNDS: dict[str, tuple[float, float]] = {
    "r1_minutes": (5, 240), "r2_still_min": (10, 480), "r2_dist_m": (50, 2000), "r2_anywhere_min": (30, 720),
    "r3_km": (0.2, 20), "r3_minutes": (2, 120), "cooldown_min": (5, 720),
    "geo_k": (1, 10), "geo_buffer_m": (0, 200), "warn_ring_m": (0, 500),
    "night_start": (0, 23), "night_end": (0, 23),
}
INT_FIELDS = {"r3_minutes", "geo_k", "night_start", "night_end"}
DEFAULTS = Params()


def validate(values: dict) -> Params:
    """Merge over defaults; raise ValueError with a readable message for unknown keys, bad types or out-of-range values."""
    known = {f.name for f in fields(Params)}
    unknown = set(values) - known
    if unknown:
        raise ValueError(f"Unknown setting: {', '.join(sorted(unknown))}")
    merged = {**asdict(DEFAULTS), **values}
    for k, v in merged.items():
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            raise ValueError(f"{k} must be a number")
        lo, hi = BOUNDS[k]
        if not lo <= v <= hi:
            raise ValueError(f"{k} must be between {lo:g} and {hi:g}")
        if k in INT_FIELDS:
            if v != int(v):
                raise ValueError(f"{k} must be a whole number")
            merged[k] = int(v)
    if merged["r2_anywhere_min"] < merged["r2_still_min"]:
        raise ValueError("r2_anywhere_min must not be shorter than r2_still_min")
    return Params(**merged)


def to_dict(p: Params) -> dict:
    return asdict(p)
