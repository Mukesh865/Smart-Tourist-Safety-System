"""Crash finder: call EVERY route as every kind of user with empty, nonsense and oversized input, plus path ids that do not
exist. Whatever the answer (401/403/404/409/422...), it must never be a server error (5xx)."""
import re

import pytest
from fastapi.testclient import TestClient

from app.main import app
from tests.test_ledger_api import H, setup_users, issue_body, token

SKIP = {"/api/evaluation/table5", "/api/admin/settings/whatif", "/api/detection/run"}      # slow by design, covered elsewhere
BODIES = [None, {}, [], {"x": "y"}, {"text": "x" * 5000, "reason": "", "status": "bogus", "ids": [None], "fixes": [{}], "lat": "a"},
          {"lat": 1e308, "lon": -1e308, "accuracy": 1e308}, {"email": "a", "password": ""}, {"enabled": "maybe"}]


def fill(path: str, val: str) -> str:
    return re.sub(r"\{[^}]+\}", val, path)


@pytest.fixture()
def tokens(client):
    off, tour, adm = setup_users(client)
    client.post("/api/ledger/issue", json=issue_body(), headers=H(off))
    client.post("/api/auth/staff", headers=H(adm), json={"email": "p@x.com", "full_name": "P", "password": "password123", "role": "police"})
    return {"none": None, "tourist": tour, "officer": off, "police": token(client, "p@x.com"), "admin": adm}


def test_no_route_returns_a_server_error(client, tokens):
    safe = TestClient(app, raise_server_exceptions=False)         # report 500s instead of re-raising them
    bad = []
    ops = [(p, m.upper()) for p, item in app.openapi()["paths"].items() if p not in SKIP for m in item if m in {"get", "post", "put", "patch", "delete"}]
    assert len(ops) > 60, len(ops)
    for path_t, method in ops:
        for who, tok in tokens.items():
            headers = H(tok) if tok else {}
            for val in (("999999", "x", "0", "-1") if "{" in path_t else ("",)):
                path = fill(path_t, val)
                for body in (BODIES if method in {"POST", "PUT", "PATCH"} else [None]):
                    kw = {"json": body} if body is not None else {}
                    resp = safe.request(method, path, headers=headers, **kw)
                    if resp.status_code >= 500:
                        bad.append(f"{method} {path} as {who} body={str(body)[:40]} -> {resp.status_code} {resp.text[:100]}")
    assert not bad, "\n".join(bad[:15])
