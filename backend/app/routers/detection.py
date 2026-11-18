from fastapi import APIRouter, Depends
from sqlmodel import Session

from ..db import get_session
from ..detect import service
from ..models import Role
from ..security import require_roles

router = APIRouter(prefix="/api/detection", tags=["detection"])
staff = require_roles(Role.police, Role.admin)


@router.get("/status", dependencies=[Depends(staff)])
def status():
    m = service._model
    return {"model_loaded": m is not None, "threshold": m.threshold if m else None,
            "mode": "rules raise alerts; Isolation Forest ranks them"}


@router.post("/run", dependencies=[Depends(staff)])
def run(session: Session = Depends(get_session)):
    created = service.run_once(session)
    return {"created": [{"id": a.id, "tourist_id": a.tourist_id, "kind": a.kind, "rule": a.rule,
                         "detail": a.detail, "score": a.score} for a in created]}
