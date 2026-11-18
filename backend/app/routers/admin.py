import secrets
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, or_
from sqlmodel import Session, select

from ..config import settings
from ..db import get_session
from ..detect import service as detect_service
from ..models import Alert, AuditLog, Incident, LedgerBlock, Role, Tourist, User
from ..security import hash_password, require_roles
from .dashboard import audit

router = APIRouter(prefix="/api/admin", tags=["admin"])
admin_only = require_roles(Role.admin)


class UserRow(BaseModel):
    id: int
    email: str
    full_name: str
    role: Role
    disabled: bool
    language: str
    created_at: datetime
    id_code: str | None = None


def _row(u: User, id_code: str | None) -> UserRow:
    return UserRow(id=u.id, email=u.email, full_name=u.full_name, role=u.role, disabled=bool(u.disabled),
                   language=u.language, created_at=u.created_at, id_code=id_code)


@router.get("/users")
def list_users(q: str = "", role: Role | None = None, disabled: bool | None = None, limit: int = 50, offset: int = 0,
               _: User = Depends(admin_only), session: Session = Depends(get_session)):
    """Search by name/email, filter by role/disabled, paginated. Returns {total, items}."""
    limit = max(1, min(limit, 200))
    cond = []
    if q.strip():
        like = f"%{q.strip().lower()}%"
        cond.append(or_(func.lower(User.email).like(like), func.lower(User.full_name).like(like)))
    if role:
        cond.append(User.role == role)
    if disabled is not None:
        cond.append(User.disabled == disabled)
    total = session.exec(select(func.count()).select_from(User).where(*cond)).one()
    users = session.exec(select(User).where(*cond).order_by(User.id).offset(offset).limit(limit)).all()
    codes = {t.user_id: t.id_code for t in session.exec(select(Tourist).where(Tourist.user_id.in_([u.id for u in users]))).all()}
    return {"total": total, "items": [_row(u, codes.get(u.id)) for u in users]}


class UserPatch(BaseModel):
    role: Role | None = None
    disabled: bool | None = None
    full_name: str | None = Field(default=None, min_length=1, max_length=100)


def _active_admins(session: Session) -> int:
    return session.exec(select(func.count()).select_from(User).where(User.role == Role.admin, User.disabled == False)).one()  # noqa: E712


@router.patch("/users/{user_id}")
def patch_user(user_id: int, data: UserPatch, me: User = Depends(admin_only), session: Session = Depends(get_session)):
    u = session.get(User, user_id)
    if not u:
        raise HTTPException(404, "User not found")
    changes = []
    if u.id == me.id and (data.disabled or (data.role and data.role != Role.admin)):
        raise HTTPException(409, "You cannot disable or demote your own account")
    losing_admin = u.role == Role.admin and not u.disabled and (data.disabled is True or (data.role and data.role != Role.admin))
    if losing_admin and _active_admins(session) <= 1:
        raise HTTPException(409, "At least one active administrator must remain")
    if data.role and data.role != u.role:
        changes.append(f"role {u.role.value}->{data.role.value}")
        u.role = data.role
        if data.role == Role.tourist and not session.exec(select(Tourist).where(Tourist.user_id == u.id)).first():
            session.add(Tourist(user_id=u.id))
    if data.disabled is not None and data.disabled != bool(u.disabled):
        changes.append("disabled" if data.disabled else "enabled")
        u.disabled = data.disabled
    if data.full_name and data.full_name != u.full_name:
        changes.append("name")
        u.full_name = data.full_name
    if changes:
        u.token_version = (u.token_version or 0) + 1       # existing sessions end immediately
        session.add(u)
        audit(session, me, "admin_update_user", detail=f"user {u.id}: {', '.join(changes)}")
        session.commit()
    tid = session.exec(select(Tourist.id_code).where(Tourist.user_id == u.id)).first()
    return _row(u, tid)


@router.post("/users/{user_id}/reset-password")
def reset_password(user_id: int, me: User = Depends(admin_only), session: Session = Depends(get_session)):
    """Sets a random temporary password, shown once. The user's existing sessions end."""
    u = session.get(User, user_id)
    if not u:
        raise HTTPException(404, "User not found")
    temp = secrets.token_urlsafe(9)
    u.password_hash = hash_password(temp)
    u.token_version = (u.token_version or 0) + 1
    session.add(u)
    audit(session, me, "admin_reset_password", detail=f"user {u.id}")
    session.commit()
    return {"temporary_password": temp}


@router.get("/stats")
def stats(_: User = Depends(admin_only), session: Session = Depends(get_session)):
    by_role = {r.value: 0 for r in Role}
    for role, n in session.exec(select(User.role, func.count()).group_by(User.role)).all():
        by_role[role.value if hasattr(role, "value") else role] = n
    alerts = {s: n for s, n in session.exec(select(Alert.status, func.count()).group_by(Alert.status)).all()}
    return {
        "users_by_role": by_role,
        "disabled_users": session.exec(select(func.count()).select_from(User).where(User.disabled == True)).one(),  # noqa: E712
        "alerts_by_status": alerts,
        "open_incidents": session.exec(select(func.count()).select_from(Incident).where(Incident.status == "open")).one(),
        "ledger_blocks": session.exec(select(func.count()).select_from(LedgerBlock)).one(),
        "ids_issued": session.exec(select(func.count()).select_from(Tourist).where(Tourist.id_code != None)).one(),  # noqa: E711
        "system": {"env": settings.env, "demo_enabled": settings.demo_enabled, "rate_limit_enabled": settings.rate_limit_enabled,
                   "detection_interval_s": settings.detection_interval_s,
                   "forest_model_loaded": detect_service._model is not None},
    }


@router.get("/audit")
def audit_log(action: str | None = None, user_id: int | None = None, limit: int = 100, offset: int = 0,
              _: User = Depends(admin_only), session: Session = Depends(get_session)):
    """Filterable audit trail with actor names. Returns {total, items}."""
    cond = []
    if action:
        cond.append(AuditLog.action == action)
    if user_id:
        cond.append(AuditLog.user_id == user_id)
    total = session.exec(select(func.count()).select_from(AuditLog).where(*cond)).one()
    rows = session.exec(select(AuditLog, User).join(User, User.id == AuditLog.user_id, isouter=True).where(*cond)
                        .order_by(AuditLog.ts.desc()).offset(offset).limit(max(1, min(limit, 500)))).all()
    return {"total": total, "items": [{"id": a.id, "ts": a.ts, "action": a.action, "actor": u.full_name if u else None,
                                       "actor_email": u.email if u else None, "tourist_id": a.tourist_id,
                                       "incident_id": a.incident_id, "detail": a.detail} for a, u in rows]}


@router.get("/audit.csv")
def audit_csv(action: str | None = None, user_id: int | None = None, me: User = Depends(admin_only),
              session: Session = Depends(get_session)):
    from fastapi import Response
    from .. import csvutil
    cond = []
    if action:
        cond.append(AuditLog.action == action)
    if user_id:
        cond.append(AuditLog.user_id == user_id)
    rows = session.exec(select(AuditLog, User).join(User, User.id == AuditLog.user_id, isouter=True).where(*cond)
                        .order_by(AuditLog.ts.desc()).limit(10000)).all()
    audit(session, me, "export_audit", detail=f"{len(rows)} rows")
    session.commit()
    body = csvutil.to_csv(["id", "time", "action", "actor", "actor_email", "tourist_id", "incident_id", "detail"],
                          [[a.id, a.ts, a.action, u.full_name if u else "", u.email if u else "", a.tourist_id, a.incident_id, a.detail] for a, u in rows])
    return Response(body, media_type="text/csv", headers={"Content-Disposition": 'attachment; filename="audit-log.csv"'})


# ---------------------------------------------------------------- calibration settings
from .. import settings_store          # noqa: E402
from ..detect import evaluate as detect_eval     # noqa: E402
from ..detect.params import BOUNDS, DEFAULTS, to_dict, validate    # noqa: E402

_baseline: dict | None = None


def _settings_payload(session: Session) -> dict:
    return {"values": to_dict(settings_store.get(session)), "defaults": to_dict(DEFAULTS),
            "bounds": {k: {"min": lo, "max": hi} for k, (lo, hi) in BOUNDS.items()}}


@router.get("/settings")
def get_settings(_: User = Depends(admin_only), session: Session = Depends(get_session)):
    return _settings_payload(session)


@router.put("/settings")
def put_settings(values: dict, me: User = Depends(admin_only), session: Session = Depends(get_session)):
    try:
        validate(values)
    except ValueError as e:
        raise HTTPException(422, str(e))
    before = to_dict(settings_store.get(session))
    p = settings_store.save(session, values, me.id)
    diff = ", ".join(f"{k} {before[k]:g}->{v:g}" for k, v in to_dict(p).items() if before[k] != v) or "no change"
    audit(session, me, "admin_update_settings", detail=diff)
    session.commit()
    from ..detect import service as detect_service
    detect_service._state.clear()          # cool-down state follows the new rules
    return _settings_payload(session)


@router.post("/settings/reset")
def reset_settings(me: User = Depends(admin_only), session: Session = Depends(get_session)):
    settings_store.save(session, {}, me.id)
    audit(session, me, "admin_update_settings", detail="reset to the paper's defaults")
    session.commit()
    return _settings_payload(session)


@router.post("/settings/whatif")
def whatif(values: dict, _: User = Depends(admin_only), session: Session = Depends(get_session)):
    """Dry run: how would the rules have performed on the same simulated days with these settings, versus the paper's
    defaults? Simulated data only; nothing is saved. Takes roughly 10-20 s."""
    global _baseline
    try:
        cand = validate(values)
    except ValueError as e:
        raise HTTPException(422, str(e))
    if _baseline is None:
        _baseline = detect_eval.evaluate_rules(DEFAULTS)
    return {"candidate": detect_eval.evaluate_rules(cand), "defaults": _baseline,
            "geo": {"candidate": _geo_false_alerts(cand), "defaults": _geo_false_alerts(DEFAULTS)},
            "note": "Simulated tourist-days with benign behaviour; real districts differ. Use the shifted set to see the effect of wider behaviour."}


def _geo_false_alerts(p) -> float:
    from .. import benchmarks
    return benchmarks.false_geo_alerts_per_km(km=8, offset_m=0, k=p.geo_k, b=p.geo_buffer_m)
