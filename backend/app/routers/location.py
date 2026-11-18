from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from .. import events, ratelimit
from ..db import get_session
from ..geo import manager
from ..models import Alert, Fix, Role, Tourist, User
from ..security import require_roles

router = APIRouter(prefix="/api", tags=["location"])

FAST_S, SLOW_S = 15, 60  # paper: 15 s inside/near risk zones, 60 s elsewhere


class FixIn(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    accuracy: float = Field(default=10.0, ge=0, le=10_000)
    ts: datetime | None = None  # device time (needed for offline replay); server time is used if absent


class AlertOut(BaseModel):
    id: int
    tourist_id: int
    kind: str
    detail: str
    lat: float | None
    lon: float | None
    status: str
    resolution: str | None = None
    created_at: datetime


def _tourist(session: Session, user: User) -> Tourist:
    t = session.exec(select(Tourist).where(Tourist.user_id == user.id)).first()
    if not t or not t.id_code:
        raise HTTPException(403, "A digital ID is required before location tracking")
    from ..ledger import service as ledger_service
    if ledger_service.revocation_for(session, t.id_code):
        raise HTTPException(403, "This ID has been revoked. Contact the tourism office.")
    return t


MAX_AGE = timedelta(hours=48)     # replayed fixes older than this are rejected
MAX_FUTURE = timedelta(minutes=5)  # a phone clock slightly ahead is clamped to "now"


def _device_time(fix: FixIn) -> datetime | None:
    """UTC device timestamp, clamped for clock skew; raises 422 when absurdly old."""
    if not (fix.ts and fix.ts.tzinfo):
        return None
    ts = fix.ts.astimezone(timezone.utc)
    now = datetime.now(timezone.utc)
    if ts > now + MAX_FUTURE:
        return now
    if ts < now - MAX_AGE:
        raise HTTPException(422, "This location is too old to accept")
    return ts


def _is_duplicate(session: Session, tourist_id: int, ts: datetime) -> bool:
    return session.exec(select(Fix.id).where(Fix.tourist_id == tourist_id, Fix.ts == ts)).first() is not None


def process_fix(session: Session, t: Tourist, fix: FixIn) -> tuple[list[Alert], float]:
    """The single ingest path: used by real phones (POST /location) and by the demo simulator."""
    engine = manager.get_engine(session)
    ts = _device_time(fix)
    if ts and _is_duplicate(session, t.id, ts):          # an offline replay that was already received
        return [], engine.nearby_risk(fix.lat, fix.lon)
    row = Fix(tourist_id=t.id, lat=fix.lat, lon=fix.lon, accuracy=fix.accuracy)
    if ts:
        row.ts = ts
    session.add(row)
    created = []
    for ev in engine.on_fix(t.id, fix.lat, fix.lon, fix.accuracy):
        text = (f"Entered {ev.zone_name} (risk {ev.risk:.1f})" if ev.kind == "zone_entry"
                else f"Approaching restricted zone {ev.zone_name}")
        a = Alert(tourist_id=t.id, kind=ev.kind, detail=text, lat=fix.lat, lon=fix.lon, zone_id=ev.zone_id)
        session.add(a)
        created.append(a)
    session.commit()
    for a in created:
        session.refresh(a)
        events.publish(a)
    return created, engine.nearby_risk(fix.lat, fix.lon)


@router.post("/location")
def ingest(fix: FixIn, user: User = Depends(require_roles(Role.tourist)),
           session: Session = Depends(get_session)):
    ratelimit.check("location", str(user.id), 60, 60)   # the app sends at most 4 fixes/minute
    created, risk = process_fix(session, _tourist(session, user), fix)
    return {"alerts": [{"kind": a.kind, "detail": a.detail} for a in created],
            "nearby_risk": risk,
            "next_interval_s": FAST_S if risk > 0 else SLOW_S}


class BatchIn(BaseModel):
    fixes: list[FixIn] = Field(min_length=1, max_length=200)


@router.post("/location/batch")
def ingest_batch(data: BatchIn, user: User = Depends(require_roles(Role.tourist)),
                 session: Session = Depends(get_session)):
    """Replay of fixes recorded while offline. Processed oldest first through the same pipeline as live fixes;
    duplicates (same device timestamp) and fixes older than 48 h are skipped, so retrying a batch is safe."""
    ratelimit.check("location-batch", str(user.id), 10, 60)
    t = _tourist(session, user)
    now = datetime.now(timezone.utc)
    ordered = sorted(data.fixes, key=lambda f: f.ts.astimezone(timezone.utc) if f.ts and f.ts.tzinfo else now)
    accepted = duplicates = rejected = 0
    alerts: list[dict] = []
    risk = 0.0
    for f in ordered:
        try:
            ts = _device_time(f)
        except HTTPException:
            rejected += 1
            continue
        if ts and _is_duplicate(session, t.id, ts):
            duplicates += 1
            continue
        created, risk = process_fix(session, t, f)
        accepted += 1
        alerts += [{"kind": a.kind, "detail": a.detail} for a in created]
    return {"accepted": accepted, "duplicates": duplicates, "rejected": rejected, "alerts": alerts,
            "nearby_risk": risk, "next_interval_s": FAST_S if risk > 0 else SLOW_S}


@router.get("/alerts", response_model=list[AlertOut],
            dependencies=[Depends(require_roles(Role.police, Role.admin))])
def list_alerts(status: str | None = None, kind: str | None = None, limit: int = 200,
                session: Session = Depends(get_session)):
    q = select(Alert).order_by(Alert.created_at.desc()).limit(min(limit, 1000))
    if status:
        q = q.where(Alert.status == status)
    if kind:
        q = q.where(Alert.kind == kind)
    return session.exec(q).all()


@router.get("/alerts/mine", response_model=list[AlertOut])
def my_alerts(user: User = Depends(require_roles(Role.tourist)), session: Session = Depends(get_session)):
    t = session.exec(select(Tourist).where(Tourist.user_id == user.id)).first()
    if not t:
        return []
    return session.exec(select(Alert).where(Alert.tourist_id == t.id)
                        .order_by(Alert.created_at.desc()).limit(100)).all()
