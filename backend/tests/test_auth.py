def reg(c, email="a@x.com", pw="password123"):
    return c.post("/api/auth/register", json={"email": email, "full_name": "A", "password": pw})


def login(c, email, pw):
    return c.post("/api/auth/login", data={"username": email, "password": pw})


def test_health(client):
    assert client.get("/api/health").json() == {"status": "ok"}


def test_register_login_me(client):
    assert reg(client).status_code == 201
    r = login(client, "a@x.com", "password123")
    assert r.status_code == 200
    tok = r.json()["access_token"]
    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {tok}"})
    assert me.json()["role"] == "tourist"


def test_duplicate_and_bad_password(client):
    reg(client)
    assert reg(client).status_code == 409
    assert login(client, "a@x.com", "wrongpass1").status_code == 401
    assert reg(client, "b@x.com", "short").status_code == 422


def test_me_requires_token(client):
    assert client.get("/api/auth/me").status_code == 401
    assert client.get("/api/auth/me", headers={"Authorization": "Bearer junk"}).status_code == 401


def test_role_guard_staff_creation(client):
    reg(client)
    tok = login(client, "a@x.com", "password123").json()["access_token"]
    body = {"email": "p@x.com", "full_name": "P", "password": "password123", "role": "police"}
    assert client.post("/api/auth/staff", json=body,
                       headers={"Authorization": f"Bearer {tok}"}).status_code == 403
    adm = login(client, "admin@tourist.local", "Admin@12345").json()["access_token"]
    r = client.post("/api/auth/staff", json=body, headers={"Authorization": f"Bearer {adm}"})
    assert r.status_code == 201 and r.json()["role"] == "police"
