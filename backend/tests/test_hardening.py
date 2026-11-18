import time

import jwt
import pytest
from sqlmodel import Session, select

from app import db as appdb
from app.config import DEFAULT_ADMIN_PASSWORD, Settings, production_problems, settings
from app.models import User
from tests.test_ledger_api import H, issue_body, setup_users
from tests.test_zones_location_api import full_setup, send

GOOD_PROD = dict(env="production", secret_key="x" * 40, admin_password="Different#Pass9", demo_enabled=False,
                 database_url="postgresql://u:p@h/db")


def reg(c, email, pw="password123"):
    return c.post("/api/auth/register", json={"email": email, "full_name": "A", "password": pw})


def test_login_brute_force_is_throttled(client, monkeypatch):
    monkeypatch.setattr(settings, "rate_limit_enabled", True)
    reg(client, "a@x.com")
    codes = [client.post("/api/auth/login", data={"username": "a@x.com", "password": "wrongwrong"}).status_code
             for _ in range(10)]
    assert codes[:8] == [401] * 8 and codes[8:] == [429, 429]
    r = client.post("/api/auth/login", data={"username": "a@x.com", "password": "password123"})
    assert r.status_code == 429 and int(r.headers["Retry-After"]) >= 1     # even the right password must wait
    reg(client, "b@x.com")   # another account from the same address is not blocked by that counter
    assert client.post("/api/auth/login", data={"username": "b@x.com", "password": "password123"}).status_code == 200


def test_registration_spam_is_throttled(client, monkeypatch):
    monkeypatch.setattr(settings, "rate_limit_enabled", True)
    codes = [reg(client, f"u{i}@x.com").status_code for i in range(12)]
    assert codes[:10] == [201] * 10 and codes[10:] == [429, 429]


def test_public_verify_is_throttled(client, monkeypatch):
    monkeypatch.setattr(settings, "rate_limit_enabled", True)
    codes = [client.post("/api/ledger/verify", json={"payload": "x"}).status_code for _ in range(122)]
    assert codes[:120] == [200] * 120 and codes[120:] == [429, 429]


def test_panic_and_location_are_throttled_per_user(client, monkeypatch):
    tour, _, _ = full_setup(client)
    monkeypatch.setattr(settings, "rate_limit_enabled", True)
    panics = [client.post("/api/panic", json={}, headers=H(tour)).status_code for _ in range(22)]
    assert panics[:20] == [201] * 20 and panics[20:] == [429, 429]
    locs = [send(client, tour, 0, 0).status_code for _ in range(62)]
    assert locs[:60] == [200] * 60 and locs[60:] == [429, 429]


def test_security_headers_and_no_store_on_api(client):
    r = client.get("/api/health")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["x-frame-options"] == "DENY"
    assert r.headers["referrer-policy"] == "no-referrer"
    assert r.headers["cache-control"] == "no-store"


def test_cors_only_allows_configured_origins(client):
    ok = client.options("/api/health", headers={"Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET"})
    assert ok.headers.get("access-control-allow-origin") == "http://localhost:5173"
    bad = client.options("/api/health", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"})
    assert "access-control-allow-origin" not in bad.headers


def test_production_safety_checks():
    assert production_problems(Settings(env="dev")) == []
    problems = production_problems(Settings(env="production"))
    assert len(problems) == 4
    assert any("SECRET_KEY" in p for p in problems) and any("ADMIN_PASSWORD" in p for p in problems)
    assert production_problems(Settings(**GOOD_PROD)) == []
    short = production_problems(Settings(**{**GOOD_PROD, "secret_key": "short"}))
    assert len(short) == 1 and "SECRET_KEY" in short[0]
    assert any("DEMO" in p for p in production_problems(Settings(**{**GOOD_PROD, "demo_enabled": True})))


def test_app_refuses_to_start_in_production_with_defaults(monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import app
    monkeypatch.setattr(settings, "env", "production")
    monkeypatch.setattr(settings, "detection_interval_s", 0)
    with pytest.raises(RuntimeError, match="Refusing to start in production"):
        with TestClient(app):
            pass


def test_admin_password_is_stored_hashed(client):
    with Session(appdb.engine) as s:
        admin = s.exec(select(User).where(User.email == "admin@tourist.local")).one()
    assert admin.password_hash != DEFAULT_ADMIN_PASSWORD and admin.password_hash.startswith("$2")


def test_expired_forged_and_unsigned_tokens_are_rejected(client):
    reg(client, "a@x.com")
    uid = client.post("/api/auth/login", data={"username": "a@x.com", "password": "password123"}).json()["user"]["id"]
    expired = jwt.encode({"sub": str(uid), "exp": int(time.time()) - 10}, settings.secret_key, algorithm="HS256")
    forged = jwt.encode({"sub": str(uid), "exp": int(time.time()) + 600}, "wrong-key" * 5, algorithm="HS256")
    unsigned = jwt.encode({"sub": str(uid)}, None, algorithm="none")
    for t in (expired, forged, unsigned):
        assert client.get("/api/auth/me", headers=H(t)).status_code == 401


def test_role_claim_in_token_is_ignored(client):
    """Authorisation uses the role stored in the database, not what a token claims."""
    reg(client, "a@x.com")
    uid = client.post("/api/auth/login", data={"username": "a@x.com", "password": "password123"}).json()["user"]["id"]
    tok = jwt.encode({"sub": str(uid), "role": "admin", "exp": int(time.time()) + 600}, settings.secret_key, algorithm="HS256")
    assert client.get("/api/zones", headers=H(tok)).status_code == 200
    body = {"name": "x", "polygon": [[1, 1], [2, 2], [3, 3]], "risk_weight": 0.5}
    assert client.post("/api/zones", headers=H(tok), json=body).status_code == 403


def test_public_key_endpoint_never_leaks_private_material(client):
    off, _, _ = setup_users(client)
    client.post("/api/ledger/issue", json=issue_body(), headers=H(off))
    body = client.get("/api/ledger/pubkey").text
    assert "PRIVATE" not in body and "BEGIN PUBLIC KEY" in body
