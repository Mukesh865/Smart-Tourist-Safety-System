import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, create_engine

from app import db as appdb
from app.config import settings
from app.main import app


@pytest.fixture()
def client(monkeypatch, tmp_path):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    # Point the app (lifespan init + seeding) and request sessions at an in-memory DB,
    # and keep test keys out of the real keys directory.
    monkeypatch.setattr(appdb, "engine", engine)
    monkeypatch.setattr(settings, "keys_dir", str(tmp_path / "keys"))
    monkeypatch.setattr(settings, "rate_limit_enabled", False)  # enabled explicitly in the hardening tests
    from app import ratelimit
    ratelimit.reset()
    monkeypatch.setattr(settings, "detection_interval_s", 0)       # no background scheduler in tests
    monkeypatch.setattr(settings, "models_dir", str(tmp_path / "models"))
    from app import anomaly_state, events
    from app.detect import service as detect_service
    from app.geo import manager
    from app import settings_store
    settings_store.invalidate()
    manager.invalidate()  # engine is process-global; start every test fresh
    detect_service.reset_state()
    anomaly_state._recent.clear()
    events.clear()

    def override():
        with Session(engine) as s:
            yield s

    app.dependency_overrides[appdb.get_session] = override
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()
