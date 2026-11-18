from fastapi import APIRouter, Depends
from sqlmodel import Session

from .. import benchmarks
from ..db import get_session
from ..models import Role
from ..security import require_roles

router = APIRouter(prefix="/api/evaluation", tags=["evaluation"],
                   dependencies=[Depends(require_roles(Role.police, Role.admin))])


@router.get("/table5")
def table5(detection: bool = False, session: Session = Depends(get_session)):
    """Paper Table V measured live. `detection=true` also reruns the (about 1 min) detector benchmark."""
    return benchmarks.table5(session, detection)
