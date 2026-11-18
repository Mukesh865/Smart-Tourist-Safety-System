from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from .. import demo
from ..config import settings
from ..db import get_session
from ..models import Role, Tourist, User
from ..security import require_roles


def _enabled():
    if not settings.demo_enabled:
        raise HTTPException(404, "Demo mode is disabled")


router = APIRouter(prefix="/api/demo", tags=["demo"],
                   dependencies=[Depends(_enabled), Depends(require_roles(Role.police, Role.admin))])


class ScenarioIn(BaseModel):
    scenario: str
    email: str = "demo1@tourist.local"


@router.get("/scenarios")
def scenarios():
    return {"scenarios": list(demo.SCENARIOS)}


@router.post("/seed")
def seed(session: Session = Depends(get_session)):
    return demo.seed(session)


@router.post("/scenario")
def scenario(data: ScenarioIn, session: Session = Depends(get_session)):
    if data.scenario not in demo.SCENARIOS:
        raise HTTPException(422, f"Unknown scenario. Choose one of {', '.join(demo.SCENARIOS)}")
    if data.email not in [e for e, _ in demo.DEMO_USERS]:
        raise HTTPException(422, "Scenarios can only run for the demo tourists")
    user = session.exec(select(User).where(User.email == data.email)).first()
    tourist = session.exec(select(Tourist).where(Tourist.user_id == user.id)).first() if user else None
    if not tourist:
        raise HTTPException(409, "Demo tourists not seeded yet. Call /api/demo/seed first.")
    return demo.run_scenario(session, tourist, data.scenario)


@router.post("/reset")
def reset(session: Session = Depends(get_session)):
    return demo.reset(session)
