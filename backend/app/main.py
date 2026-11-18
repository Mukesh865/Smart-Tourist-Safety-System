import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlmodel import Session, select

from . import db
from .config import production_problems, settings
from .models import Role, User
from .routers import admin, analytics, auth, dashboard, demo, detection, evaluation, ledger, location, tourist, tourists, zones
from .security import hash_password


def seed_admin() -> None:
    with Session(db.engine) as s:
        if not s.exec(select(User).where(User.role == Role.admin)).first():
            s.add(User(email="admin@tourist.local", full_name="System Admin",
                       password_hash=hash_password(settings.admin_password), role=Role.admin))
            s.commit()


async def _detection_loop():
    """Per-minute detection. Trains the ranking forest in the background on first start."""
    from .detect import service
    if service.load_model() is None:
        await asyncio.to_thread(service.train_and_save)

    def tick():
        with Session(db.engine) as s:
            service.run_once(s)

    while True:
        await asyncio.sleep(settings.detection_interval_s)
        try:
            await asyncio.to_thread(tick)
        except Exception:
            logging.exception("detection tick failed")


@asynccontextmanager
async def lifespan(app: FastAPI):
    problems = production_problems(settings)
    if problems:
        raise RuntimeError("Refusing to start in production: " + "; ".join(problems))
    db.init_db()
    seed_admin()
    task = asyncio.create_task(_detection_loop()) if settings.detection_interval_s > 0 else None
    yield
    if task:
        task.cancel()


app = FastAPI(title="Smart Tourist Safety System", lifespan=lifespan)
@app.middleware("http")
async def security_headers(request, call_next):
    resp = await call_next(request)
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Referrer-Policy", "no-referrer")
    resp.headers.setdefault("Permissions-Policy", "geolocation=(self), camera=(self)")
    if request.url.path.startswith("/api/"):
        resp.headers.setdefault("Cache-Control", "no-store")  # never cache personal or alert data
    return resp


app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins,
                   allow_methods=["*"], allow_headers=["*"], allow_credentials=True)
app.include_router(auth.router)
app.include_router(admin.router)
app.include_router(analytics.router)
app.include_router(ledger.router)
app.include_router(tourists.router)
app.include_router(zones.router)
app.include_router(location.router)
app.include_router(tourist.router)
app.include_router(detection.router)
app.include_router(dashboard.router)
app.include_router(demo.router)
app.include_router(evaluation.router)


@app.get("/api/health")
def health():
    return {"status": "ok"}
