"""Control-room analytics: how many alerts, how fast they are handled, and how trustworthy each detector is.
The false-alarm ratio per rule (resolved as false_alarm vs genuine) is the real-world precision signal the paper says
is needed to calibrate thresholds per district."""
import statistics
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends
from sqlmodel import Session, select

from ..db import get_session
from ..models import Alert, Fix, Role, Zone
from ..security import require_roles

router = APIRouter(prefix="/api/analytics", tags=["analytics"], dependencies=[Depends(require_roles(Role.police, Role.admin))])

MOVEMENT = ("dropoff", "inactivity", "deviation")
ZONE = ("zone_entry", "zone_warning")


def _aware(d: datetime) -> datetime:
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _median(xs: list[float]) -> float | None:
    return round(statistics.median(xs), 1) if xs else None


@router.get("/summary")
def summary(days: int = 14, session: Session = Depends(get_session)):
    days = max(1, min(days, 90))
    today = datetime.now(timezone.utc).date()
    start = today - timedelta(days=days - 1)
    since = datetime(start.year, start.month, start.day, tzinfo=timezone.utc)
    alerts = [a for a in session.exec(select(Alert).where(Alert.created_at >= since)).all()]

    labels = [(start + timedelta(days=i)) for i in range(days)]
    per_day: dict[date, Counter] = {d: Counter() for d in labels}
    for a in alerts:
        d = _aware(a.created_at).date()
        group = "panic" if a.kind == "panic" else "movement" if a.kind in MOVEMENT else "zone"
        if d in per_day:
            per_day[d][group] += 1
    per_day_out = [{"date": d.isoformat(), "panic": c["panic"], "movement": c["movement"], "zone": c["zone"]} for d, c in per_day.items()]

    ack = [(_aware(a.acknowledged_at) - _aware(a.created_at)).total_seconds() for a in alerts if a.acknowledged_at]
    res = [(_aware(a.resolved_at) - _aware(a.created_at)).total_seconds() for a in alerts if a.resolved_at and a.resolution != "cancelled_by_user"]

    # per detector: how many real vs false alarms
    by_kind: dict[str, Counter] = defaultdict(Counter)
    for a in alerts:
        c = by_kind[a.kind]
        c["total"] += 1
        if a.status != "resolved":
            c["open"] += 1
        elif a.resolution == "false_alarm":
            c["false_alarm"] += 1
        elif a.resolution == "cancelled_by_user":
            c["cancelled"] += 1
        else:
            c["genuine"] += 1
    rules = []
    for kind, c in sorted(by_kind.items()):
        judged = c["false_alarm"] + c["genuine"]
        rules.append({"kind": kind, "total": c["total"], "open": c["open"], "genuine": c["genuine"], "false_alarm": c["false_alarm"],
                      "cancelled": c["cancelled"], "judged": judged,
                      "false_alarm_ratio": round(c["false_alarm"] / judged, 3) if judged else None})

    zone_names = {z.id: z.name for z in session.exec(select(Zone)).all()}
    zones = Counter(a.zone_id for a in alerts if a.zone_id is not None and a.kind == "zone_entry")
    zones_out = [{"zone_id": zid, "name": zone_names.get(zid, f"Zone {zid}"), "count": n} for zid, n in zones.most_common(8)]

    active: dict[date, set] = defaultdict(set)
    for f in session.exec(select(Fix.tourist_id, Fix.ts).where(Fix.ts >= since)).all():
        active[_aware(f[1]).date()].add(f[0])
    active_out = [{"date": d.isoformat(), "count": len(active.get(d, ()))} for d in labels]

    return {"days": days, "per_day": per_day_out, "total_alerts": len(alerts),
            "response": {"median_ack_s": _median(ack), "median_resolve_s": _median(res), "n_ack": len(ack), "n_resolved": len(res)},
            "rules": rules, "zones": zones_out, "active_tourists": active_out}
