import json
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Literal

import jwt
from fastapi import APIRouter, Depends, HTTPException, Response, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlmodel import Session, select

from .. import csvutil, efir, realtime
from ..config import settings
from ..db import get_session
from ..geo import manager
from ..ledger import service as ledger_service
from ..models import Alert, AuditLog, Fix, Incident, IncidentNote, OffchainPII, Role, Tourist, User
from ..security import require_roles

router = APIRouter(prefix="/api", tags=["dashboard"])
staff = require_roles(Role.police, Role.admin)

NEXT = {"open": {"acknowledged"}, "acknowledged": {"dispatched", "resolved"}, "dispatched": {"resolved"}, "resolved": set()}
KIND_RANK = {"panic": 0, "dropoff": 1, "inactivity": 2, "deviation": 3, "zone_entry": 4, "zone_warning": 5}


def _aware(d):
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def audit(session, user, action, *, tourist_id=None, incident_id=None, detail=""):
    session.add(AuditLog(user_id=user.id, action=action, tourist_id=tourist_id,
                         incident_id=incident_id, detail=detail))


# ---------- live alerts (WebSocket) ----------
@router.websocket("/ws/alerts")
async def ws_alerts(ws: WebSocket, token: str = ""):
    from .. import db
    try:
        data = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
        with Session(db.engine) as s:
            u = s.get(User, int(data["sub"]))
        ok = (u is not None and u.role in (Role.police, Role.admin) and not u.disabled
              and data.get("tv", 0) == (u.token_version or 0))   # same revocation rules as the REST API
    except Exception:
        ok = False
    if not ok:
        await ws.close(code=4401)
        return
    await ws.accept()
    hub = realtime.get_hub()
    entry = hub.add()
    try:
        while True:
            msg = await entry[0].get()
            await ws.send_json(msg)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        hub.remove(entry)


# ---------- queue (filters, pagination, export) ----------
def _alert_rows(session: Session, *, include_resolved=False, kind=None, status=None, rule=None, q="", since=None, until=None):
    st = select(Alert, Tourist).join(Tourist, Tourist.id == Alert.tourist_id)
    if status:
        st = st.where(Alert.status == status)
    elif not include_resolved:
        st = st.where(Alert.status != "resolved")
    if kind:
        st = st.where(Alert.kind == kind)
    if rule:
        st = st.where(Alert.rule == rule)
    if q.strip():
        st = st.where(func.lower(Tourist.id_code).like(f"%{q.strip().lower()}%"))
    if since:
        st = st.where(Alert.created_at >= _aware(since))
    if until:
        st = st.where(Alert.created_at <= _aware(until))
    rows = session.exec(st.order_by(Alert.created_at.desc()).limit(5000)).all()
    names = {u.id: u.full_name for u in session.exec(select(User).where(User.role.in_([Role.police, Role.admin]))).all()}
    out = [{"id": a.id, "tourist_id": a.tourist_id, "id_code": t.id_code, "kind": a.kind, "rule": a.rule,
            "detail": a.detail, "lat": a.lat, "lon": a.lon, "status": a.status, "score": a.score,
            "incident_id": a.incident_id, "resolution": a.resolution, "assigned_to": a.assigned_to,
            "assignee": names.get(a.assigned_to), "created_at": a.created_at} for a, t in rows]
    # control-room order: unresolved first, panic first, then forest priority, newest first (sort is stable)
    out.sort(key=lambda r: (r["status"] == "resolved", KIND_RANK.get(r["kind"], 9), -(r["score"] or 0)))
    return out


@router.get("/dashboard/alerts", dependencies=[Depends(staff)])
def ranked_alerts(include_resolved: bool = False, kind: str | None = None, status: str | None = None,
                  rule: str | None = None, q: str = "", since: datetime | None = None, until: datetime | None = None,
                  limit: int = 500, offset: int = 0, paged: bool = False, session: Session = Depends(get_session)):
    """Control-room queue. Plain list by default (backward compatible); `paged=true` returns {total, items}."""
    out = _alert_rows(session, include_resolved=include_resolved, kind=kind, status=status, rule=rule, q=q, since=since, until=until)
    limit = max(1, min(limit, 500))
    page = out[offset:offset + limit]
    return {"total": len(out), "items": page} if paged else page


@router.get("/dashboard/alerts.csv")
def alerts_csv(include_resolved: bool = True, kind: str | None = None, status: str | None = None, rule: str | None = None,
               q: str = "", since: datetime | None = None, until: datetime | None = None,
               user: User = Depends(staff), session: Session = Depends(get_session)):
    rows = _alert_rows(session, include_resolved=include_resolved, kind=kind, status=status, rule=rule, q=q, since=since, until=until)
    audit(session, user, "export_alerts", detail=f"{len(rows)} rows")
    session.commit()
    body = csvutil.to_csv(["id", "created_at", "id_code", "kind", "rule", "status", "resolution", "priority", "assigned_to", "detail", "lat", "lon"],
                          [[r["id"], r["created_at"], r["id_code"], r["kind"], r["rule"], r["status"], r["resolution"], r["score"],
                            r["assignee"], r["detail"], r["lat"], r["lon"]] for r in rows])
    return Response(body, media_type="text/csv", headers={"Content-Disposition": 'attachment; filename="alerts.csv"'})


@router.get("/dashboard/staff", dependencies=[Depends(staff)])
def staff_list(session: Session = Depends(get_session)):
    """Active control-room staff an alert can be assigned to."""
    users = session.exec(select(User).where(User.role.in_([Role.police, Role.admin]), User.disabled == False).order_by(User.full_name)).all()  # noqa: E712
    return [{"id": u.id, "name": u.full_name, "role": u.role.value} for u in users]


@router.get("/dashboard/trail/{tourist_id}", dependencies=[Depends(staff)])
def trail(tourist_id: int, hours: int = 6, session: Session = Depends(get_session)):
    """Recent track of one visitor (identified by pseudonymous ID only), oldest first, for the map and replay."""
    hours = max(1, min(hours, 48))
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    fixes = session.exec(select(Fix).where(Fix.tourist_id == tourist_id, Fix.ts >= since).order_by(Fix.ts).limit(1500)).all()
    return {"tourist_id": tourist_id, "points": [{"lat": f.lat, "lon": f.lon, "ts": f.ts} for f in fixes]}


@router.get("/dashboard/overview", dependencies=[Depends(staff)])
def overview(session: Session = Depends(get_session)):
    now = datetime.now(timezone.utc)
    since = now - timedelta(hours=24)
    last: dict[int, Fix] = {}
    for f in session.exec(select(Fix).where(Fix.ts >= since).order_by(Fix.ts)).all():
        last[f.tourist_id] = f
    ids = {t.id: t.id_code for t in session.exec(select(Tourist)).all()}
    open_by = defaultdict(int)
    for a in session.exec(select(Alert).where(Alert.status != "resolved")).all():
        open_by[a.tourist_id] += 1
    positions = [{"tourist_id": tid, "id_code": ids.get(tid), "lat": f.lat, "lon": f.lon, "ts": f.ts,
                  "open_alerts": open_by.get(tid, 0)} for tid, f in last.items()]
    cells = defaultdict(list)
    for p in positions:                                        # ~1 km clusters (0.01 deg grid)
        cells[(round(p["lat"] / 0.01), round(p["lon"] / 0.01))].append(p)
    clusters = [{"lat": sum(p["lat"] for p in v) / len(v), "lon": sum(p["lon"] for p in v) / len(v),
                 "count": len(v)} for v in cells.values()]
    heat = [[a.lat, a.lon, 1.0 if a.kind == "panic" else 0.6]
            for a in session.exec(select(Alert).where(Alert.lat != None)).all()]  # noqa: E711
    eng = manager.get_engine(session)
    zone_heat = []
    for z in eng.zones:                                        # risk-weighted zone centroids
        lat, lon = _centroid(eng, z)
        zone_heat.append([lat, lon, z.risk])
    counts = defaultdict(int)
    for a in session.exec(select(Alert)).all():
        counts[a.status] += 1
    return {"positions": positions, "clusters": clusters, "alert_heat": heat, "zone_heat": zone_heat,
            "alerts_by_status": dict(counts), "active_tourists": len(positions)}


def _centroid(engine, z):
    x = sum(p[0] for p in z.poly) / len(z.poly)
    y = sum(p[1] for p in z.poly) / len(z.poly)
    return (engine.proj.lat0 + y / engine.proj.ky, engine.proj.lon0 + x / engine.proj.kx)


# ---------- incident workflow ----------
class Transition(BaseModel):
    status: str | None = None
    resolution: Literal["resolved", "false_alarm"] | None = None   # only with status=resolved
    assignee_id: int | None = None                                  # present (even null) = (un)assign


def _apply_status(session: Session, user: User, a: Alert, new_status: str, resolution: str | None) -> None:
    if new_status not in NEXT.get(a.status, set()):
        raise HTTPException(409, f"Cannot go from {a.status} to {new_status}")
    now_ = datetime.now(timezone.utc)
    if new_status == "acknowledged":
        inc = session.exec(select(Incident).where(Incident.tourist_id == a.tourist_id, Incident.status == "open")).first()
        if not inc:
            inc = Incident(tourist_id=a.tourist_id)
            session.add(inc)
            session.commit()
            session.refresh(inc)
        a.incident_id = inc.id
        a.acknowledged_at = now_
        if a.assigned_to is None:
            a.assigned_to = user.id           # whoever picks it up owns it until reassigned
    if new_status == "resolved":
        a.resolved_at = now_
        a.resolution = resolution or "resolved"
        if a.acknowledged_at is None:
            a.acknowledged_at = now_
    a.status = new_status
    session.add(a)
    session.commit()
    if new_status == "resolved" and a.incident_id:
        pending = session.exec(select(Alert).where(Alert.incident_id == a.incident_id, Alert.status != "resolved")).first()
        if not pending:
            inc = session.get(Incident, a.incident_id)
            inc.status, inc.closed_at = "closed", now_
            session.add(inc)
    audit(session, user, {"acknowledged": "ack", "dispatched": "dispatch", "resolved": "resolve"}[new_status],
          tourist_id=a.tourist_id, incident_id=a.incident_id,
          detail=f"alert {a.id} ({a.kind})" + (f" as {a.resolution}" if new_status == "resolved" else ""))
    session.commit()


@router.patch("/alerts/{alert_id}")
def transition(alert_id: int, data: Transition, user: User = Depends(staff), session: Session = Depends(get_session)):
    a = session.get(Alert, alert_id)
    if not a:
        raise HTTPException(404, "Alert not found")
    if data.resolution and data.status != "resolved":
        raise HTTPException(422, "A resolution can only be given together with status 'resolved'")
    if data.status is None and "assignee_id" not in data.model_fields_set:
        raise HTTPException(422, "Nothing to change")
    if "assignee_id" in data.model_fields_set:
        if data.assignee_id is not None:
            who = session.get(User, data.assignee_id)
            if not who or who.role not in (Role.police, Role.admin) or who.disabled:
                raise HTTPException(422, "Alerts can only be assigned to active control-room staff")
        a.assigned_to = data.assignee_id
        session.add(a)
        audit(session, user, "assign", tourist_id=a.tourist_id, incident_id=a.incident_id,
              detail=f"alert {a.id} -> {data.assignee_id if data.assignee_id else 'nobody'}")
        session.commit()
    if data.status:
        _apply_status(session, user, a, data.status, data.resolution)
    session.refresh(a)
    return {"id": a.id, "status": a.status, "incident_id": a.incident_id, "assigned_to": a.assigned_to, "resolution": a.resolution}


class BulkIn(BaseModel):
    ids: list[int] = Field(min_length=1, max_length=100)
    status: Literal["acknowledged", "dispatched", "resolved"]
    resolution: Literal["resolved", "false_alarm"] | None = None


@router.post("/alerts/bulk")
def bulk(data: BulkIn, user: User = Depends(staff), session: Session = Depends(get_session)):
    """Apply one transition to many alerts. Alerts that cannot make the move are skipped with a reason."""
    updated, skipped = [], []
    for aid in dict.fromkeys(data.ids):
        a = session.get(Alert, aid)
        if not a:
            skipped.append({"id": aid, "reason": "not found"})
            continue
        try:
            _apply_status(session, user, a, data.status, data.resolution)
            updated.append(aid)
        except HTTPException as e:
            skipped.append({"id": aid, "reason": e.detail})
    return {"updated": updated, "skipped": skipped}


class NoteIn(BaseModel):
    text: str = Field(min_length=1, max_length=1000)


@router.post("/incidents/{incident_id}/notes", status_code=201)
def add_note(incident_id: int, data: NoteIn, user: User = Depends(staff), session: Session = Depends(get_session)):
    inc = session.get(Incident, incident_id)
    if not inc:
        raise HTTPException(404, "Incident not found")
    n = IncidentNote(incident_id=incident_id, user_id=user.id, text=data.text.strip())
    session.add(n)
    audit(session, user, "note", tourist_id=inc.tourist_id, incident_id=incident_id, detail=f"{len(n.text)} characters")
    session.commit()
    session.refresh(n)
    return {"id": n.id, "text": n.text, "ts": n.ts, "by": user.full_name}


@router.get("/incidents/{incident_id}/timeline", dependencies=[Depends(staff)])
def timeline(incident_id: int, session: Session = Depends(get_session)):
    """Everything that happened on an incident in time order: alerts, staff actions and notes. No personal data."""
    inc = session.get(Incident, incident_id)
    if not inc:
        raise HTTPException(404, "Incident not found")
    names = {u.id: u.full_name for u in session.exec(select(User)).all()}
    items = [{"kind": "alert", "ts": a.created_at, "text": f"{a.kind.replace('_', ' ')}: {a.detail}", "by": None}
             for a in session.exec(select(Alert).where(Alert.incident_id == incident_id)).all()]
    items += [{"kind": "note", "ts": n.ts, "text": n.text, "by": names.get(n.user_id)}
              for n in session.exec(select(IncidentNote).where(IncidentNote.incident_id == incident_id)).all()]
    items += [{"kind": "action", "ts": x.ts, "text": f"{x.action}{': ' + x.detail if x.detail and x.action != 'note' else ''}", "by": names.get(x.user_id)}
              for x in session.exec(select(AuditLog).where(AuditLog.incident_id == incident_id)).all()]
    items.sort(key=lambda i: _aware(i["ts"]))
    return {"incident": {"id": inc.id, "status": inc.status, "tourist_id": inc.tourist_id, "opened_at": inc.opened_at}, "items": items}


def _active_incident(session, incident_id) -> Incident:
    inc = session.get(Incident, incident_id)
    if not inc:
        raise HTTPException(404, "Incident not found")
    if inc.status != "open":
        raise HTTPException(403, "Personal data is available only for an active (open) incident")
    return inc


def _pii(session, id_code):
    row = session.get(OffchainPII, id_code) if id_code else None
    if not row:
        return None
    return json.loads(ledger_service.fernet().decrypt(row.ciphertext))


@router.post("/incidents/{incident_id}/reveal")
def reveal(incident_id: int, user: User = Depends(staff), session: Session = Depends(get_session)):
    inc = _active_incident(session, incident_id)
    t = session.get(Tourist, inc.tourist_id)
    pii = _pii(session, t.id_code)
    audit(session, user, "reveal_pii", tourist_id=t.id, incident_id=inc.id, detail=t.id_code or "")
    session.commit()
    if pii is None:
        raise HTTPException(410, "Personal data was erased after the visit ended")
    return {"id_code": t.id_code, "name": session.get(User, t.user_id).full_name, **pii["values"]}


def _draft(session, user, inc):
    t = session.get(Tourist, inc.tourist_id)
    fixes = session.exec(select(Fix).where(Fix.tourist_id == t.id).order_by(Fix.ts)).all()
    alerts = session.exec(select(Alert).where(Alert.tourist_id == t.id).order_by(Alert.created_at)).all()
    audit(session, user, "efir", tourist_id=t.id, incident_id=inc.id)
    session.commit()
    return efir.build_draft(incident=inc, tourist_name=session.get(User, t.user_id).full_name,
                            id_code=t.id_code or "-", pii=_pii(session, t.id_code), alerts=alerts, fixes=fixes)


@router.get("/incidents/{incident_id}/efir")
def efir_json(incident_id: int, user: User = Depends(staff), session: Session = Depends(get_session)):
    return _draft(session, user, _active_incident(session, incident_id))


@router.get("/incidents/{incident_id}/efir.pdf")
def efir_pdf(incident_id: int, user: User = Depends(staff), session: Session = Depends(get_session)):
    pdf = efir.render_pdf(_draft(session, user, _active_incident(session, incident_id)))
    return Response(pdf, media_type="application/pdf",
                    headers={"Content-Disposition": f'attachment; filename="draft-efir-{incident_id}.pdf"'})


@router.get("/audit", dependencies=[Depends(require_roles(Role.admin))])
def audit_log(limit: int = 200, session: Session = Depends(get_session)):
    return session.exec(select(AuditLog).order_by(AuditLog.ts.desc()).limit(min(limit, 1000))).all()
