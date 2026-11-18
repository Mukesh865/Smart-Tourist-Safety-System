import time

import jwt
import pytest
from sqlmodel import Session, select

from app import db as appdb
from app.config import settings
from app.models import AuditLog
from tests.test_ledger_api import H, issue_body, setup_users, token


def login(c, email, pw="password123"):
    return c.post("/api/auth/login", data={"username": email, "password": pw})


def admin(c):
    return token(c, "admin@tourist.local", "Admin@12345")


def make_user(c, email, role=None, name="Pat"):
    if role is None:
        return c.post("/api/auth/register", json={"email": email, "full_name": name, "password": "password123"}).json()
    return c.post("/api/auth/staff", headers=H(admin(c)),
                  json={"email": email, "full_name": name, "password": "password123", "role": role}).json()


def test_admin_endpoints_require_admin(client):
    make_user(client, "o@x.com", "officer")
    make_user(client, "p@x.com", "police")
    make_user(client, "t@x.com")
    for who in ("o@x.com", "p@x.com", "t@x.com"):
        tok = token(client, who)
        for method, path in (("get", "/api/admin/users"), ("get", "/api/admin/stats"), ("get", "/api/admin/audit"),
                             ("post", "/api/admin/users/1/reset-password")):
            assert getattr(client, method)(path, headers=H(tok)).status_code == 403, (who, path)
    assert client.get("/api/admin/users").status_code == 401


def test_user_list_search_filter_paginate(client):
    for i in range(5):
        make_user(client, f"user{i}@x.com", name=f"Tourist {i}")
    make_user(client, "boss@x.com", "police", name="Chief Boss")
    a = H(admin(client))
    r = client.get("/api/admin/users", headers=a).json()
    assert r["total"] == 7 and len(r["items"]) == 7
    assert [u["email"] for u in client.get("/api/admin/users?q=chief", headers=a).json()["items"]] == ["boss@x.com"]
    assert client.get("/api/admin/users?q=USER3", headers=a).json()["total"] == 1          # case-insensitive
    assert client.get("/api/admin/users?role=police", headers=a).json()["total"] == 1
    page = client.get("/api/admin/users?limit=3&offset=3", headers=a).json()
    assert page["total"] == 7 and len(page["items"]) == 3
    assert "password" not in str(r).lower()


def test_disable_blocks_login_and_kills_existing_token(client):
    u = make_user(client, "t@x.com")
    tok = token(client, "t@x.com")
    assert client.get("/api/auth/me", headers=H(tok)).status_code == 200
    r = client.patch(f"/api/admin/users/{u['id']}", json={"disabled": True}, headers=H(admin(client)))
    assert r.status_code == 200 and r.json()["disabled"] is True
    assert client.get("/api/auth/me", headers=H(tok)).status_code == 401          # old token dead at once
    lr = login(client, "t@x.com")
    assert lr.status_code == 403 and "disabled" in lr.json()["detail"]
    assert login(client, "t@x.com", "wrong-password").status_code == 401          # no hint for a wrong password
    client.patch(f"/api/admin/users/{u['id']}", json={"disabled": False}, headers=H(admin(client)))
    assert login(client, "t@x.com").status_code == 200


def test_role_change_ends_sessions_and_applies(client):
    u = make_user(client, "t@x.com")
    old = token(client, "t@x.com")
    r = client.patch(f"/api/admin/users/{u['id']}", json={"role": "police"}, headers=H(admin(client)))
    assert r.json()["role"] == "police"
    assert client.get("/api/auth/me", headers=H(old)).status_code == 401
    new = token(client, "t@x.com")
    assert client.get("/api/dashboard/alerts", headers=H(new)).status_code == 200  # now has police access


def test_cannot_lock_out_the_last_admin_or_yourself(client):
    a = H(admin(client))
    me = client.get("/api/auth/me", headers=a).json()["id"]
    assert client.patch(f"/api/admin/users/{me}", json={"disabled": True}, headers=a).status_code == 409
    assert client.patch(f"/api/admin/users/{me}", json={"role": "police"}, headers=a).status_code == 409
    second = make_user(client, "a2@x.com", "admin")
    t2 = H(token(client, "a2@x.com"))
    assert client.patch(f"/api/admin/users/{me}", json={"role": "officer"}, headers=t2).status_code == 200
    assert client.patch(f"/api/admin/users/{second['id']}", json={"disabled": True}, headers=t2).status_code == 409
    assert client.patch("/api/admin/users/999", json={"disabled": True}, headers=t2).status_code == 404


def test_reset_password_returns_temp_once_and_ends_sessions(client):
    u = make_user(client, "t@x.com")
    old = token(client, "t@x.com")
    r = client.post(f"/api/admin/users/{u['id']}/reset-password", headers=H(admin(client)))
    temp = r.json()["temporary_password"]
    assert len(temp) >= 10
    assert client.get("/api/auth/me", headers=H(old)).status_code == 401
    assert login(client, "t@x.com", "password123").status_code == 401
    assert login(client, "t@x.com", temp).status_code == 200
    assert client.post("/api/admin/users/999/reset-password", headers=H(admin(client))).status_code == 404
    with Session(appdb.engine) as s:
        assert temp not in " ".join(a.detail for a in s.exec(select(AuditLog)).all())      # never written to the log


def test_change_password_flow(client):
    make_user(client, "t@x.com")
    tok = token(client, "t@x.com")
    other_device = token(client, "t@x.com")
    h = H(tok)
    body = lambda cur, new: {"current_password": cur, "new_password": new}
    assert client.post("/api/auth/change-password", json=body("wrong-pass", "newpassword1"), headers=h).status_code == 400
    assert client.post("/api/auth/change-password", json=body("password123", "password123"), headers=h).status_code == 400
    assert client.post("/api/auth/change-password", json=body("password123", "short"), headers=h).status_code == 422
    r = client.post("/api/auth/change-password", json=body("password123", "newpassword1"), headers=h)
    assert r.status_code == 200
    fresh = r.json()["access_token"]
    assert client.get("/api/auth/me", headers=H(fresh)).status_code == 200          # the returned token works
    assert client.get("/api/auth/me", headers=H(other_device)).status_code == 401   # every other session ended
    assert login(client, "t@x.com", "password123").status_code == 401
    assert login(client, "t@x.com", "newpassword1").status_code == 200


def test_logout_all(client):
    make_user(client, "t@x.com")
    a, b = token(client, "t@x.com"), token(client, "t@x.com")
    assert client.post("/api/auth/logout-all", headers=H(a)).status_code == 200
    assert client.get("/api/auth/me", headers=H(a)).status_code == 401
    assert client.get("/api/auth/me", headers=H(b)).status_code == 401
    assert client.post("/api/auth/logout-all").status_code == 401


def test_old_tokens_without_version_claim_still_work_until_first_bump(client):
    """Tokens issued before token versioning existed carry no 'tv' claim and count as version 0."""
    u = make_user(client, "t@x.com")
    legacy = jwt.encode({"sub": str(u["id"]), "exp": int(time.time()) + 600}, settings.secret_key, algorithm="HS256")
    assert client.get("/api/auth/me", headers=H(legacy)).status_code == 200
    client.post("/api/auth/logout-all", headers=H(token(client, "t@x.com")))
    assert client.get("/api/auth/me", headers=H(legacy)).status_code == 401


def test_websocket_refuses_revoked_staff_token(client):
    from starlette.websockets import WebSocketDisconnect
    u = make_user(client, "p@x.com", "police")
    tok = token(client, "p@x.com")
    with client.websocket_connect(f"/api/ws/alerts?token={tok}"):
        pass                                                         # a valid token connects
    client.patch(f"/api/admin/users/{u['id']}", json={"disabled": True}, headers=H(admin(client)))
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(f"/api/ws/alerts?token={tok}") as ws:
            ws.receive_json()


def test_admin_actions_are_audited_with_actor_names_and_filters(client):
    u = make_user(client, "t@x.com")
    a = H(admin(client))
    client.patch(f"/api/admin/users/{u['id']}", json={"role": "officer"}, headers=a)
    client.patch(f"/api/admin/users/{u['id']}", json={"disabled": True}, headers=a)
    client.post(f"/api/admin/users/{u['id']}/reset-password", headers=a)
    r = client.get("/api/admin/audit", headers=a).json()
    assert r["total"] == 3 and r["items"][0]["actor"] == "System Admin"
    details = [i["detail"] for i in r["items"]]
    assert any("role tourist->officer" in d for d in details) and any("disabled" in d for d in details)
    only = client.get("/api/admin/audit?action=admin_reset_password", headers=a).json()
    assert only["total"] == 1 and only["items"][0]["action"] == "admin_reset_password"
    assert client.get("/api/admin/audit?limit=1&offset=1", headers=a).json()["items"][0]["id"] != r["items"][0]["id"]


def test_stats_overview(client):
    off, tour, adm = setup_users(client)
    client.post("/api/ledger/issue", json=issue_body(), headers=H(off))
    s = client.get("/api/admin/stats", headers=H(adm)).json()
    assert s["users_by_role"]["tourist"] == 1 and s["users_by_role"]["officer"] == 1 and s["users_by_role"]["admin"] == 1
    assert s["ids_issued"] == 1 and s["ledger_blocks"] == 1 and s["open_incidents"] == 0
    assert s["system"]["demo_enabled"] is True and s["system"]["forest_model_loaded"] is False
    assert "secret" not in str(s).lower() and "password" not in str(s).lower()


def test_demoting_to_tourist_creates_profile(client):
    u = make_user(client, "o@x.com", "officer")
    client.patch(f"/api/admin/users/{u['id']}", json={"role": "tourist"}, headers=H(admin(client)))
    tok = token(client, "o@x.com")
    assert client.get("/api/me/profile", headers=H(tok)).status_code == 200


def test_patch_validation_and_noop(client):
    u = make_user(client, "t@x.com")
    a = H(admin(client))
    assert client.patch(f"/api/admin/users/{u['id']}", json={"role": "superuser"}, headers=a).status_code == 422
    assert client.patch(f"/api/admin/users/{u['id']}", json={"full_name": ""}, headers=a).status_code == 422
    tok = token(client, "t@x.com")
    client.patch(f"/api/admin/users/{u['id']}", json={}, headers=a)                       # no change
    assert client.get("/api/auth/me", headers=H(tok)).status_code == 200                   # session survives a no-op
