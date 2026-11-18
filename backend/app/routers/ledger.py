import json
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr, Field, model_validator
from sqlmodel import Session, select

from .. import ratelimit
from ..db import get_session
from ..ledger import core, service
from ..models import Itinerary, LedgerBlock, LedgerRecord, RevocationEntry, Role, Tourist, User
from ..security import require_roles
from .dashboard import audit

router = APIRouter(prefix="/api/ledger", tags=["ledger"])


class Stop(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    hotel: bool = False


class Contact(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    phone: str = Field(min_length=5, max_length=20)


class IssueIn(BaseModel):
    tourist_email: EmailStr
    kyc_number: str = Field(min_length=4, max_length=40)  # passport / Aadhaar (verified by officer)
    route: list[tuple[float, float]] = Field(default=[], max_length=500)
    stops: list[Stop] = Field(default=[], max_length=100)
    contacts: list[Contact] = Field(min_length=1, max_length=5)
    valid_from: datetime
    valid_to: datetime

    @model_validator(mode="after")
    def _dates(self):
        if self.valid_to <= self.valid_from:
            raise ValueError("valid_to must be after valid_from")
        return self


class VerifyIn(BaseModel):
    payload: str = Field(max_length=8000)


def _ts(d: datetime) -> int:
    return int((d if d.tzinfo else d.replace(tzinfo=timezone.utc)).timestamp())


def _entry_out(e: RevocationEntry) -> dict:
    return {"id_code": e.id_code, "reason": e.reason, "ts": e.ts, "prev_hash": e.prev_hash,
            "entry_hash": e.entry_hash, "signature": e.signature}


@router.get("/pubkey")
def pubkey():
    return {"algorithm": "ECDSA-P256-SHA256", "pem": service.authority().public_pem()}


def _can_get_new_id(session: Session, tourist: Tourist) -> bool:
    """A visitor may receive a (new) ID when they have none, or their previous one is revoked or expired."""
    if not tourist.id_code:
        return True
    if service.revocation_for(session, tourist.id_code):
        return True
    end = tourist.valid_to
    return bool(end and (end if end.tzinfo else end.replace(tzinfo=timezone.utc)) < datetime.now(timezone.utc))


def _issue_for(session: Session, tourist: Tourist, data, actor: User, verification: str, action: str) -> dict:
    if not _can_get_new_id(session, tourist):
        raise HTTPException(409, "You already have a valid digital ID. Extend it instead of creating a new one.")
    clash = service.active_id_for_document(session, data.kyc_number)
    if clash and clash != tourist.id_code:
        raise HTTPException(409, "A valid digital ID already exists for this identity document. If it is yours, sign in to that account or visit the tourism office.")
    itinerary = {"route": data.route, "stops": [s.model_dump() for s in data.stops]}
    id_code, payload = service.issue(
        session, kyc=data.kyc_number, itinerary=itinerary, contacts=[c.model_dump() for c in data.contacts],
        t_from=_ts(data.valid_from), t_to=_ts(data.valid_to))
    service.remember_document(session, id_code, data.kyc_number)
    tourist.id_code, tourist.id_verification = id_code, verification
    tourist.valid_from, tourist.valid_to = data.valid_from, data.valid_to
    session.add(tourist)
    old = session.exec(select(Itinerary).where(Itinerary.tourist_id == tourist.id)).first()
    if old:
        session.delete(old)                      # a new ID starts with its own itinerary
    session.add(Itinerary(tourist_id=tourist.id, route_json=json.dumps(data.route),
                          stops_json=json.dumps([s.model_dump() for s in data.stops])))
    audit(session, actor, action, tourist_id=tourist.id, detail=f"{id_code} ({verification})")
    session.commit()
    from ..geo import manager
    manager.invalidate()
    return {"id_code": id_code, "payload": payload, "verification": verification}


@router.post("/issue", status_code=201)
def issue(data: IssueIn, officer: User = Depends(require_roles(Role.officer, Role.admin)),
          session: Session = Depends(get_session)):
    user = session.exec(select(User).where(User.email == data.tourist_email.lower())).first()
    tourist = session.exec(select(Tourist).where(Tourist.user_id == user.id)).first() if user else None
    if not tourist:
        raise HTTPException(404, "No tourist account with that email")
    return _issue_for(session, tourist, data, officer, "officer", "issue_id")


class ApplyIn(BaseModel):
    kyc_number: str = Field(min_length=4, max_length=40)
    route: list[tuple[float, float]] = Field(default=[], max_length=500)
    stops: list[Stop] = Field(min_length=1, max_length=100)
    contacts: list[Contact] = Field(min_length=1, max_length=5)
    valid_from: datetime
    valid_to: datetime
    declaration: bool = False

    @model_validator(mode="after")
    def _check(self):
        if not self.declaration:
            raise ValueError("You must confirm that the details are true")
        if self.valid_to <= self.valid_from:
            raise ValueError("valid_to must be after valid_from")
        if (self.valid_to - self.valid_from).days > 90:
            raise ValueError("A digital ID can be issued for at most 90 days at a time")
        for lat, lon in self.route:
            if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                raise ValueError("route coordinates out of range")
        return self


@router.post("/apply", status_code=201)
def apply(data: ApplyIn, request: Request, user: User = Depends(require_roles(Role.tourist)),
          session: Session = Depends(get_session)):
    """Self-service: a visitor creates their own digital ID online, with no visit to an office. The ID is marked
    'self_declared' (the identity document was not checked by an officer) until an officer verifies it in person."""
    ratelimit.check("apply", str(user.id), 5, 3600)
    now = datetime.now(timezone.utc)
    end = data.valid_to if data.valid_to.tzinfo else data.valid_to.replace(tzinfo=timezone.utc)
    if end <= now:
        raise HTTPException(422, "The end date must be in the future")
    start = data.valid_from if data.valid_from.tzinfo else data.valid_from.replace(tzinfo=timezone.utc)
    if start < now - timedelta(days=2):          # allows for 'today' being a day behind UTC in the visitor's time zone
        raise HTTPException(422, "The start date cannot be in the past")
    tourist = session.exec(select(Tourist).where(Tourist.user_id == user.id)).first()
    if not tourist:
        tourist = Tourist(user_id=user.id)
        session.add(tourist)
        session.commit()
        session.refresh(tourist)
    return _issue_for(session, tourist, data, user, "self_declared", "self_issue_id")


@router.get("/my-credential")
def my_credential(user: User = Depends(require_roles(Role.tourist)), session: Session = Depends(get_session)):
    tourist = session.exec(select(Tourist).where(Tourist.user_id == user.id)).first()
    if not tourist or not tourist.id_code:
        raise HTTPException(404, "No digital ID yet. You can create one online from your home screen.")
    rev = service.revocation_for(session, tourist.id_code)
    return {"id_code": tourist.id_code, "payload": service.credential_for(session, tourist.id_code),
            "valid_from": tourist.valid_from, "valid_to": tourist.valid_to,
            "revoked": rev is not None, "revoked_reason": rev.reason if rev else None,
            "verification": tourist.id_verification}


@router.post("/verify")
def verify(data: VerifyIn, request: Request, session: Session = Depends(get_session)):
    """Public: any check-post can verify. Returns no personal data. A revoked ID is invalid even if its
    signature and dates are fine (offline verifiers can fetch /revocations to do the same check)."""
    ratelimit.check("verify", ratelimit.client_ip(request), 120, 60)
    r = core.verify_credential(data.payload, service.authority().public_key)
    id_code = r.record["i"] if r.record else None
    rev = service.revocation_for(session, id_code) if r.merkle_ok and r.signature_ok else None
    reason = r.reason
    if rev:
        reason = "; ".join(x for x in (reason, f"ID revoked: {rev.reason}") if x)
    owner = session.exec(select(Tourist).where(Tourist.id_code == id_code)).first() if id_code and r.merkle_ok and r.signature_ok else None
    return {"valid": r.valid and rev is None, "verification": owner.id_verification if owner else None, "merkle_ok": r.merkle_ok, "signature_ok": r.signature_ok,
            "in_validity": r.in_validity, "reason": reason, "revoked": rev is not None,
            "revoked_at": rev.ts if rev else None,
            "id_code": id_code,
            "valid_from": r.record["f"] if r.record else None,
            "valid_to": r.record["t"] if r.record else None}


class RevokeIn(BaseModel):
    reason: str = Field(min_length=3, max_length=200)


@router.post("/{id_code}/revoke", status_code=201)
def revoke(id_code: str, data: RevokeIn, user: User = Depends(require_roles(Role.police, Role.admin)),
           session: Session = Depends(get_session)):
    if not session.get(LedgerRecord, id_code):
        raise HTTPException(404, "Unknown ID")
    if service.revocation_for(session, id_code):
        raise HTTPException(409, "This ID is already revoked")
    e = service.revoke(session, id_code, data.reason.strip(), user.id)
    t = session.exec(select(Tourist).where(Tourist.id_code == id_code)).first()
    audit(session, user, "revoke_id", tourist_id=t.id if t else None, detail=f"{id_code}: {data.reason.strip()}")
    session.commit()
    return _entry_out(e)


@router.get("/revocations")
def revocations(session: Session = Depends(get_session)):
    """Public signed revocation list (id codes are pseudonymous). Check-posts can mirror it for offline use."""
    rows = session.exec(select(RevocationEntry).order_by(RevocationEntry.id)).all()
    return {"head": rows[-1].entry_hash if rows else core.b64(core.ZERO_HASH), "entries": [_entry_out(e) for e in rows]}


@router.get("/chain", dependencies=[Depends(require_roles(Role.admin, Role.police))])
def chain(session: Session = Depends(get_session)):
    return service.verify_chain(session)


@router.get("/revocations/audit", dependencies=[Depends(require_roles(Role.admin, Role.police))])
def revocations_audit(session: Session = Depends(get_session)):
    return service.verify_revocation_chain(session)


@router.get("/blocks", dependencies=[Depends(require_roles(Role.admin, Role.police))])
def blocks(limit: int = 20, offset: int = 0, session: Session = Depends(get_session)):
    """Explorer: newest first. Hashes and counts only, never personal data."""
    limit = max(1, min(limit, 100))
    total = len(session.exec(select(LedgerBlock.height)).all())
    rows = session.exec(select(LedgerBlock).order_by(LedgerBlock.height.desc()).offset(offset).limit(limit)).all()
    out = []
    for b in rows:
        s = service.block_summary(session, b)
        s.pop("id_codes")
        out.append(s)
    return {"total": total, "items": out}


@router.get("/blocks/{height}", dependencies=[Depends(require_roles(Role.admin, Role.police))])
def block_detail(height: int, session: Session = Depends(get_session)):
    b = session.get(LedgerBlock, height)
    if not b:
        raise HTTPException(404, "Block not found")
    s = service.block_summary(session, b)
    recs = session.exec(select(LedgerRecord).where(LedgerRecord.block_height == height).order_by(LedgerRecord.idx)).all()
    revoked = {e.id_code for e in session.exec(select(RevocationEntry)).all()}
    s["records"] = [{"id_code": r.id_code, "index": r.idx, "leaf_hash": core.b64(core.leaf_hash(json.loads(r.record_json))),
                     "commitments": json.loads(r.record_json)["c"], "valid_from": json.loads(r.record_json)["f"],
                     "valid_to": json.loads(r.record_json)["t"], "revoked": r.id_code in revoked} for r in recs]
    s.pop("id_codes")
    return s


@router.post("/erase-expired", dependencies=[Depends(require_roles(Role.admin))])
def erase_expired(session: Session = Depends(get_session)):
    return {"erased": service.erase_expired(session)}
