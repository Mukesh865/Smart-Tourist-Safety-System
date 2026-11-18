import json
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from .. import ratelimit, settings_store
from ..db import get_session
from ..geo import manager
from ..ledger import service as ledger_service
from ..models import Alert, Fix, Itinerary, OffchainPII, Role, Tourist, User
from ..score import is_night, safety_score
from ..security import require_roles

router = APIRouter(prefix="/api", tags=["tourist"])
tourist_only = require_roles(Role.tourist)

LANGS = {"en", "hi"}


def _tourist(session: Session, user: User) -> Tourist:
    t = session.exec(select(Tourist).where(Tourist.user_id == user.id)).first()
    if not t:
        raise HTTPException(404, "Tourist profile not found")
    return t


def _last_fix(session: Session, tid: int) -> Fix | None:
    return session.exec(select(Fix).where(Fix.tourist_id == tid).order_by(Fix.ts.desc())).first()


def _contacts(session: Session, id_code: str | None) -> list[dict]:
    """The tourist's own emergency contacts (decrypted for them only); empty if erased."""
    row = session.get(OffchainPII, id_code) if id_code else None
    if not row:
        return []
    return json.loads(ledger_service.fernet().decrypt(row.ciphertext))["values"]["contacts"]


class PanicIn(BaseModel):
    lat: float | None = Field(default=None, ge=-90, le=90)
    lon: float | None = Field(default=None, ge=-180, le=180)
    ts: datetime | None = None   # when the button was pressed on the phone (set when sent late after being offline)


@router.post("/panic", status_code=201)
def panic(data: PanicIn, user: User = Depends(tourist_only), session: Session = Depends(get_session)):
    ratelimit.check("panic", str(user.id), 20, 60)
    t = _tourist(session, user)
    lat, lon = data.lat, data.lon
    if lat is None or lon is None:
        f = _last_fix(session, t.id)
        lat, lon = (f.lat, f.lon) if f else (None, None)
    detail = f"Panic button pressed by {user.full_name}"
    if data.ts and data.ts.tzinfo:
        late = datetime.now(timezone.utc) - data.ts.astimezone(timezone.utc)
        if timedelta(seconds=60) < late < timedelta(hours=48):
            detail += f" (pressed {data.ts.astimezone(timezone.utc):%H:%M} UTC, delivered late after being offline)"
    a = Alert(tourist_id=t.id, kind="panic", detail=detail, lat=lat, lon=lon)
    session.add(a)
    session.commit()
    session.refresh(a)
    from .. import events
    events.publish(a)
    return {"alert_id": a.id, "lat": lat, "lon": lon, "contacts": _contacts(session, t.id_code)}


@router.get("/me/score")
def my_score(user: User = Depends(tourist_only), session: Session = Depends(get_session)):
    t = _tourist(session, user)
    f = _last_fix(session, t.id)
    z = manager.get_engine(session).nearby_risk(f.lat, f.lon) if f else 0.0
    from .. import anomaly_state
    a = anomaly_state.recent_anomaly(t.id)
    p = settings_store.get(session)
    n = is_night(datetime.now(timezone.utc), p.night_start, p.night_end)
    return {"score": safety_score(z, n, a), "z": z, "night": n, "a": a, "has_fix": f is not None}


@router.get("/me/profile")
def profile(user: User = Depends(tourist_only), session: Session = Depends(get_session)):
    t = _tourist(session, user)
    return {"has_id": bool(t.id_code), "share_with_family": t.share_with_family,
            "share_token": t.share_token if t.share_with_family else None, "language": user.language}


class ShareIn(BaseModel):
    enabled: bool


@router.post("/me/share")
def set_share(data: ShareIn, user: User = Depends(tourist_only), session: Session = Depends(get_session)):
    t = _tourist(session, user)
    t.share_with_family = data.enabled
    if data.enabled and not t.share_token:
        t.share_token = secrets.token_urlsafe(16)
    session.add(t)
    session.commit()
    return {"share_with_family": t.share_with_family,
            "share_token": t.share_token if t.share_with_family else None}


@router.get("/share/{token}")
def public_share(token: str, session: Session = Depends(get_session)):
    """Family live view. Only works while the tourist has opted in; first name + last fix only."""
    t = session.exec(select(Tourist).where(Tourist.share_token == token)).first()
    if not t or not t.share_with_family:
        raise HTTPException(404, "Link is not active")
    f = _last_fix(session, t.id)
    u = session.get(User, t.user_id)
    return {"name": u.full_name.split()[0], "lat": f.lat if f else None, "lon": f.lon if f else None,
            "updated": f.ts if f else None}


class LangIn(BaseModel):
    language: str


@router.put("/me/language")
def set_language(data: LangIn, user: User = Depends(require_roles(Role.tourist, Role.officer, Role.police, Role.admin)),
                 session: Session = Depends(get_session)):
    if data.language not in LANGS:
        raise HTTPException(422, "Unsupported language")
    u = session.get(User, user.id)
    u.language = data.language
    session.add(u)
    session.commit()
    return {"language": u.language}


CANCEL_WINDOW = timedelta(minutes=10)


@router.post("/panic/{alert_id}/cancel")
def cancel_panic(alert_id: int, user: User = Depends(tourist_only), session: Session = Depends(get_session)):
    """The tourist pressed by accident. Allowed only while the control room has not acknowledged it."""
    t = _tourist(session, user)
    a = session.get(Alert, alert_id)
    if not a or a.tourist_id != t.id or a.kind != "panic":
        raise HTTPException(404, "Alert not found")
    created = a.created_at if a.created_at.tzinfo else a.created_at.replace(tzinfo=timezone.utc)
    if a.status != "open":
        raise HTTPException(409, "The control room has already handled this alert. Please speak to them directly.")
    if datetime.now(timezone.utc) - created > CANCEL_WINDOW:
        raise HTTPException(409, "It is too late to cancel this alert")
    a.status, a.resolution = "resolved", "cancelled_by_user"
    a.detail += " [cancelled by the tourist: accidental press]"
    session.add(a)
    session.commit()
    session.refresh(a)
    from .. import events
    events.publish(a)
    return {"alert_id": a.id, "status": a.status}


@router.get("/me/trip")
def my_trip(user: User = Depends(tourist_only), session: Session = Depends(get_session)):
    t = _tourist(session, user)
    it = session.exec(select(Itinerary).where(Itinerary.tourist_id == t.id)).first()
    return {"route": json.loads(it.route_json) if it else [], "stops": json.loads(it.stops_json) if it else [],
            "valid_from": t.valid_from, "valid_to": t.valid_to}


@router.get("/me/contacts")
def my_contacts(user: User = Depends(tourist_only), session: Session = Depends(get_session)):
    """The tourist's own emergency contacts (decrypted for them only); empty once erased after the visit."""
    t = _tourist(session, user)
    return {"contacts": _contacts(session, t.id_code)}
