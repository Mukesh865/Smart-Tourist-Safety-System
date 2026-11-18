import json

from sqlmodel import Session, select

from app import db as appdb
from app.models import LedgerRecord, OffchainPII

KYC = "AADHAAR-123412341234"
PHONE = "+91-9876543210"


def token(c, email, pw="password123"):
    return c.post("/api/auth/login", data={"username": email, "password": pw}).json()["access_token"]


def H(tok):
    return {"Authorization": f"Bearer {tok}"}


def setup_users(c):
    c.post("/api/auth/register", json={"email": "t@x.com", "full_name": "Tess", "password": "password123"})
    adm = token(c, "admin@tourist.local", "Admin@12345")
    c.post("/api/auth/staff", headers=H(adm), json={"email": "o@x.com", "full_name": "Off",
           "password": "password123", "role": "officer"})
    return token(c, "o@x.com"), token(c, "t@x.com"), adm


def issue_body(**kw):
    b = {"tourist_email": "t@x.com", "kyc_number": KYC,
         "route": [[25.57, 91.88], [25.6, 91.9]],
         "stops": [{"name": "Hotel", "lat": 25.57, "lon": 91.88, "hotel": True}],
         "contacts": [{"name": "Mom", "phone": PHONE}],
         "valid_from": "2020-01-01T00:00:00Z", "valid_to": "2099-01-01T00:00:00Z"}
    b.update(kw)
    return b


def test_full_issue_verify_flow(client):
    off, tour, _ = setup_users(client)
    r = client.post("/api/ledger/issue", json=issue_body(), headers=H(off))
    assert r.status_code == 201, r.text
    payload = r.json()["payload"]

    my = client.get("/api/ledger/my-credential", headers=H(tour)).json()
    assert my["payload"] == payload and my["id_code"] == r.json()["id_code"]

    v = client.post("/api/ledger/verify", json={"payload": payload}).json()  # public, no auth
    assert v["valid"] and v["id_code"] == my["id_code"]
    # verification response and payload carry no personal data
    assert KYC not in json.dumps(v) and KYC not in payload and PHONE not in payload


def test_second_issue_and_unknown_tourist(client):
    off, _, _ = setup_users(client)
    assert client.post("/api/ledger/issue", json=issue_body(), headers=H(off)).status_code == 201
    assert client.post("/api/ledger/issue", json=issue_body(), headers=H(off)).status_code == 409
    assert client.post("/api/ledger/issue", json=issue_body(tourist_email="no@x.com"),
                       headers=H(off)).status_code == 404


def test_role_guards(client):
    off, tour, _ = setup_users(client)
    assert client.post("/api/ledger/issue", json=issue_body(), headers=H(tour)).status_code == 403
    assert client.post("/api/ledger/issue", json=issue_body()).status_code == 401
    assert client.get("/api/ledger/my-credential", headers=H(tour)).status_code == 404  # none yet
    assert client.get("/api/ledger/my-credential", headers=H(off)).status_code == 403
    assert client.post("/api/ledger/erase-expired", headers=H(off)).status_code == 403


def test_validation(client):
    off, _, _ = setup_users(client)
    bad = issue_body(valid_to="2019-01-01T00:00:00Z")
    assert client.post("/api/ledger/issue", json=bad, headers=H(off)).status_code == 422
    assert client.post("/api/ledger/issue", json=issue_body(contacts=[]), headers=H(off)).status_code == 422


def test_expired_and_tampered_rejected(client):
    off, _, _ = setup_users(client)
    payload = client.post("/api/ledger/issue", headers=H(off), json=issue_body(
        valid_from="2020-01-01T00:00:00Z", valid_to="2020-02-01T00:00:00Z")).json()["payload"]
    v = client.post("/api/ledger/verify", json={"payload": payload}).json()
    assert not v["valid"] and not v["in_validity"] and v["signature_ok"]

    cred = json.loads(payload)
    cred["r"]["t"] = 4_000_000_000  # extend validity
    v = client.post("/api/ledger/verify", json={"payload": json.dumps(cred)}).json()
    assert not v["valid"] and not v["merkle_ok"]
    assert not client.post("/api/ledger/verify", json={"payload": "garbage"}).json()["valid"]


def test_chain_links_and_audit(client):
    off, _, adm = setup_users(client)
    for n in range(3):
        client.post("/api/auth/register", json={"email": f"u{n}@x.com", "full_name": "U", "password": "password123"})
        r = client.post("/api/ledger/issue", headers=H(off), json=issue_body(tourist_email=f"u{n}@x.com", kyc_number=f"PASSPORT-{n}00"))
        assert r.status_code == 201
    assert client.get("/api/ledger/chain", headers=H(adm)).json() == {"ok": True, "blocks": 3, "broken_at": None}

    # corrupt one on-chain record directly in the DB -> audit must flag it
    with Session(appdb.engine) as s:
        rec = s.exec(select(LedgerRecord)).all()[1]
        d = json.loads(rec.record_json)
        d["t"] += 1
        rec.record_json = json.dumps(d)
        s.add(rec)
        s.commit()
    audit = client.get("/api/ledger/chain", headers=H(adm)).json()
    assert audit["ok"] is False and audit["broken_at"] == 1


def test_pii_encrypted_and_erased_after_expiry(client):
    off, _, adm = setup_users(client)
    client.post("/api/ledger/issue", headers=H(off), json=issue_body(
        valid_from="2020-01-01T00:00:00Z", valid_to="2020-02-01T00:00:00Z"))
    with Session(appdb.engine) as s:
        row = s.exec(select(OffchainPII)).one()
        assert KYC.encode() not in row.ciphertext and b"Mom" not in row.ciphertext
        rec = s.exec(select(LedgerRecord)).one()
        assert KYC not in rec.record_json
    assert client.post("/api/ledger/erase-expired", headers=H(adm)).json() == {"erased": 1}
    with Session(appdb.engine) as s:
        assert s.exec(select(OffchainPII)).first() is None
        assert s.exec(select(LedgerRecord)).first() is not None  # hashes remain on chain
    # credential still verifies structurally (hashes remain) but is out of validity
    assert client.get("/api/ledger/pubkey").json()["algorithm"] == "ECDSA-P256-SHA256"
