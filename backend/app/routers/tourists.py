"""Officer-facing tourist management: list with ID status, itinerary editing, renew/extend, printable credential."""
import json
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import func, or_
from sqlmodel import Session, select

from ..db import get_session
from ..geo import manager
from ..ledger import service
from ..models import Itinerary, KycIndex, OffchainPII, RevocationEntry, Role, Tourist, User
from ..security import require_roles
from .dashboard import audit
from .ledger import Stop, _ts

router = APIRouter(prefix="/api/tourists", tags=["tourists"])
staff = require_roles(Role.officer, Role.admin)     # police work from pseudonymous IDs; names stay with issuing staff

EXPIRING = timedelta(hours=48)


def _aware(d: datetime | None) -> datetime | None:
    return d if d is None or d.tzinfo else d.replace(tzinfo=timezone.utc)


def status_of(t: Tourist, revoked: bool, now: datetime | None = None) -> str:
    now = now or datetime.now(timezone.utc)
    if not t.id_code:
        return "no_id"
    if revoked:
        return "revoked"
    end = _aware(t.valid_to)
    if end and end < now:
        return "expired"
    if end and end - now < EXPIRING:
        return "expiring"
    return "active"


def _row(t: Tourist, u: User, revoked: bool) -> dict:
    return {"tourist_id": t.id, "name": u.full_name, "email": u.email, "id_code": t.id_code,
            "valid_from": t.valid_from, "valid_to": t.valid_to, "status": status_of(t, revoked),
            "verification": t.id_verification}


@router.get("")
def list_tourists(q: str = "", status: str | None = None, limit: int = 20, offset: int = 0,
                  _: User = Depends(staff), session: Session = Depends(get_session)):
    """Search by name / email / ID code; filter by status (no_id, active, expiring, expired, revoked)."""
    limit = max(1, min(limit, 100))
    cond = []
    if q.strip():
        like = f"%{q.strip().lower()}%"
        cond.append(or_(func.lower(User.email).like(like), func.lower(User.full_name).like(like),
                        func.lower(Tourist.id_code).like(like)))
    rows = session.exec(select(Tourist, User).join(User, User.id == Tourist.user_id).where(*cond).order_by(Tourist.id)).all()
    revoked = _revoked_set(session)
    items = [_row(t, u, t.id_code in revoked) for t, u in rows]
    if status:
        items = [i for i in items if i["status"] == status]
    return {"total": len(items), "items": items[offset:offset + limit]}


def _revoked_set(session: Session) -> set[str]:
    return {e.id_code for e in session.exec(select(RevocationEntry)).all()}


def _get(session: Session, tourist_id: int) -> tuple[Tourist, User]:
    t = session.get(Tourist, tourist_id)
    u = session.get(User, t.user_id) if t else None
    if not t or not u:
        raise HTTPException(404, "Tourist not found")
    return t, u


@router.get("/{tourist_id}")
def detail(tourist_id: int, _: User = Depends(staff), session: Session = Depends(get_session)):
    t, u = _get(session, tourist_id)
    it = session.exec(select(Itinerary).where(Itinerary.tourist_id == t.id)).first()
    rev = service.revocation_for(session, t.id_code)
    return {**_row(t, u, rev is not None), "revoked_reason": rev.reason if rev else None,
            "itinerary": {"route": json.loads(it.route_json) if it else [], "stops": json.loads(it.stops_json) if it else []}}


@router.get("/{tourist_id}/credential")
def credential(tourist_id: int, user: User = Depends(staff), session: Session = Depends(get_session)):
    """For printing the ID card. Contains the signed credential only; no personal data is returned."""
    t, u = _get(session, tourist_id)
    if not t.id_code:
        raise HTTPException(404, "No ID issued yet")
    rev = service.revocation_for(session, t.id_code)
    return {"id_code": t.id_code, "name": u.full_name, "payload": service.credential_for(session, t.id_code),
            "valid_from": t.valid_from, "valid_to": t.valid_to, "revoked": rev is not None}


class ItineraryIn(BaseModel):
    route: list[tuple[float, float]] = Field(default=[], max_length=500)
    stops: list[Stop] = Field(default=[], max_length=100)

    @model_validator(mode="after")
    def _check(self):
        for lat, lon in self.route:
            if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                raise ValueError("route coordinates out of range")
        return self


@router.put("/{tourist_id}/itinerary")
def update_itinerary(tourist_id: int, data: ItineraryIn, officer: User = Depends(staff),
                     session: Session = Depends(get_session)):
    """Amend the operational itinerary used by detection (route deviation, planned stops).
    The ledger commitment still reflects what was declared at the entry point."""
    t, _ = _get(session, tourist_id)
    it = session.exec(select(Itinerary).where(Itinerary.tourist_id == t.id)).first()
    if not it:
        it = Itinerary(tourist_id=t.id)
    it.route_json = json.dumps(data.route)
    it.stops_json = json.dumps([s.model_dump() for s in data.stops])
    session.add(it)
    audit(session, officer, "update_itinerary", tourist_id=t.id, detail=f"{len(data.route)} route points, {len(data.stops)} stops")
    session.commit()
    return {"route": data.route, "stops": [s.model_dump() for s in data.stops]}


class RenewIn(BaseModel):
    valid_to: datetime
    valid_from: datetime | None = None


@router.post("/{tourist_id}/renew", status_code=201)
def renew(tourist_id: int, data: RenewIn, officer: User = Depends(staff), session: Session = Depends(get_session)):
    """Extend / renew: re-issue the same verified details under a NEW ID code and revoke the old one as superseded.
    Requires the encrypted details to still exist (they are erased after the visit ends)."""
    t, _ = _get(session, tourist_id)
    if not t.id_code:
        raise HTTPException(409, "No ID to renew. Issue one first.")
    start = data.valid_from or datetime.now(timezone.utc)
    if data.valid_to <= start:
        raise HTTPException(422, "valid_to must be after valid_from")
    pii = service.load_pii(session, t.id_code)
    if pii is None:
        raise HTTPException(410, "The original details were erased after the visit ended. Register the visitor again at the entry point.")
    old = t.id_code
    new_code, payload = service.issue(session, kyc=pii["values"]["kyc"], itinerary=pii["values"]["itinerary"],
                                      contacts=pii["values"]["contacts"], t_from=_ts(start), t_to=_ts(data.valid_to))
    if not service.revocation_for(session, old):
        service.revoke(session, old, f"superseded by {new_code}", officer.id)
    service.remember_document(session, new_code, pii["values"]["kyc"])     # the renewed ID keeps the document protected
    idx = session.get(KycIndex, old)
    if idx:
        session.delete(idx)
    row = session.get(OffchainPII, old)     # details moved to the new ID; do not keep two copies
    if row:
        session.delete(row)
    t.id_code, t.valid_from, t.valid_to = new_code, start, data.valid_to
    session.add(t)
    audit(session, officer, "renew_id", tourist_id=t.id, detail=f"{old} -> {new_code}")
    session.commit()
    manager.invalidate()
    return {"id_code": new_code, "payload": payload, "previous": old}


@router.post("/{tourist_id}/verify-in-person")
def verify_in_person(tourist_id: int, officer: User = Depends(staff), session: Session = Depends(get_session)):
    """An officer has now checked the original identity document of a self-declared ID."""
    t, _ = _get(session, tourist_id)
    if not t.id_code:
        raise HTTPException(409, "No ID issued yet")
    t.id_verification = "officer"
    session.add(t)
    audit(session, officer, "verify_id_in_person", tourist_id=t.id, detail=t.id_code)
    session.commit()
    return {"tourist_id": t.id, "verification": t.id_verification}
