import json
from datetime import datetime, timedelta, timezone

from sqlmodel import Session, select

from app import db as appdb
from app.config import settings
from app.ledger import service
from app.models import AuditLog, KycIndex, OffchainPII, Tourist
from tests.test_ledger_api import H, KYC, PHONE, issue_body, token

NOW = datetime.now(timezone.utc)


def iso(d):
    return d.isoformat().replace("+00:00", "Z")


def body(**kw):
    b = {"kyc_number": "P-1234567", "route": [[25.57, 91.88], [25.6, 91.9]],
         "stops": [{"name": "Hotel", "lat": 25.57, "lon": 91.88, "hotel": True}],
         "contacts": [{"name": "Mum", "phone": PHONE}], "valid_from": iso(NOW), "valid_to": iso(NOW + timedelta(days=7)), "declaration": True}
    b.update(kw)
    return b


def user(c, email="t@x.com", name="Tess"):
    c.post("/api/auth/register", json={"email": email, "full_name": name, "password": "password123"})
    return H(token(c, email))


def staff(c, email, role):
    adm = token(c, "admin@tourist.local", "Admin@12345")
    c.post("/api/auth/staff", headers=H(adm), json={"email": email, "full_name": role, "password": "password123", "role": role})
    return H(token(c, email))


def test_tourist_creates_their_own_id_online_and_it_verifies(client):
    t = user(client)
    assert client.get("/api/ledger/my-credential", headers=t).status_code == 404
    r = client.post("/api/ledger/apply", json=body(), headers=t)
    assert r.status_code == 201 and r.json()["verification"] == "self_declared"
    mine = client.get("/api/ledger/my-credential", headers=t).json()
    assert mine["id_code"] == r.json()["id_code"] and mine["verification"] == "self_declared"
    v = client.post("/api/ledger/verify", json={"payload": mine["payload"]}).json()
    assert v["valid"] and v["verification"] == "self_declared"
    assert "P-1234567" not in mine["payload"] and PHONE not in mine["payload"]            # still no personal data in the QR
    # tracking works straight away, with the itinerary the visitor entered
    assert client.post("/api/location", json={"lat": 25.57, "lon": 91.88}, headers=t).status_code == 200
    assert client.get("/api/me/trip", headers=t).json()["stops"][0]["name"] == "Hotel"
    assert client.get("/api/me/contacts", headers=t).json()["contacts"][0]["phone"] == PHONE


def test_personal_data_is_encrypted_and_audited(client):
    t = user(client)
    client.post("/api/ledger/apply", json=body(), headers=t)
    with Session(appdb.engine) as s:
        assert b"P-1234567" not in s.exec(select(OffchainPII)).one().ciphertext
        assert "self_issue_id" in [a.action for a in s.exec(select(AuditLog)).all()]


def test_validation(client):
    t = user(client)
    post = lambda **kw: client.post("/api/ledger/apply", json=body(**kw), headers=t).status_code
    assert post(declaration=False) == 422
    assert post(kyc_number="12") == 422
    assert post(contacts=[]) == 422
    assert post(stops=[]) == 422
    assert post(valid_to=iso(NOW - timedelta(days=1)), valid_from=iso(NOW - timedelta(days=3))) == 422     # already ended
    assert post(valid_from=iso(NOW - timedelta(days=5)), valid_to=iso(NOW + timedelta(days=2))) == 422      # starts in the past
    assert post(valid_to=iso(NOW + timedelta(days=120))) == 422                                              # more than 90 days
    assert post(valid_to=iso(NOW - timedelta(minutes=1)), valid_from=iso(NOW)) == 422                        # end before start
    assert post(route=[[95, 10]]) == 422
    assert post(stops=[{"name": "", "lat": 1, "lon": 1}]) == 422
    assert client.get("/api/ledger/my-credential", headers=t).status_code == 404                              # nothing was created


def test_roles_and_auth(client):
    off = staff(client, "o@x.com", "officer")
    assert client.post("/api/ledger/apply", json=body(), headers=off).status_code == 403
    assert client.post("/api/ledger/apply", json=body()).status_code == 401


def test_cannot_apply_twice_while_the_id_is_valid(client):
    t = user(client)
    assert client.post("/api/ledger/apply", json=body(), headers=t).status_code == 201
    r = client.post("/api/ledger/apply", json=body(kyc_number="OTHER-9999"), headers=t)
    assert r.status_code == 409 and "already have a valid" in r.json()["detail"]


def test_one_document_cannot_hold_two_active_ids(client):
    a, b = user(client, "a@x.com", "Ann"), user(client, "b@x.com", "Bob")
    assert client.post("/api/ledger/apply", json=body(kyc_number="aadhaar 1111-2222"), headers=a).status_code == 201
    r = client.post("/api/ledger/apply", json=body(kyc_number="AADHAAR11112222"), headers=b)           # same number, different formatting
    assert r.status_code == 409 and "identity document" in r.json()["detail"]
    off = staff(client, "o@x.com", "officer")
    assert client.post("/api/ledger/issue", json=issue_body(tourist_email="b@x.com", kyc_number="Aadhaar-1111-2222"), headers=off).status_code == 409   # officers too


def test_document_becomes_reusable_after_revocation_or_expiry(client):
    a, b = user(client, "a@x.com", "Ann"), user(client, "b@x.com", "Bob")
    code = client.post("/api/ledger/apply", json=body(), headers=a).json()["id_code"]
    pol = staff(client, "p@x.com", "police")
    client.post(f"/api/ledger/{code}/revoke", json={"reason": "lost phone"}, headers=pol)
    assert client.post("/api/ledger/apply", json=body(), headers=b).status_code == 201


def test_expired_or_revoked_visitor_can_get_a_new_id_without_visiting_anyone(client):
    """Regression: a visitor whose first ID ended could never receive another one (409 'already has an ID')."""
    t = user(client)
    first = client.post("/api/ledger/apply", json=body(), headers=t).json()["id_code"]
    with Session(appdb.engine) as s:                                                  # the visit ended yesterday; data erased
        tr = s.exec(select(Tourist)).one()
        tr.valid_to = NOW - timedelta(days=1)
        s.add(tr)
        s.commit()
        service.erase_expired(s, now=int(NOW.timestamp()) + 10**7)
        assert s.exec(select(KycIndex)).all() == []                                   # the document hash was erased with the data
    second = client.post("/api/ledger/apply", json=body(), headers=t)
    assert second.status_code == 201 and second.json()["id_code"] != first
    cur = client.get("/api/ledger/my-credential", headers=t).json()
    assert cur["id_code"] == second.json()["id_code"] and cur["revoked"] is False
    assert client.get("/api/me/trip", headers=t).json()["stops"][0]["name"] == "Hotel"     # old itinerary replaced, not duplicated


def test_revoked_visitor_gets_a_new_id(client):
    t = user(client)
    code = client.post("/api/ledger/apply", json=body(), headers=t).json()["id_code"]
    client.post(f"/api/ledger/{code}/revoke", json={"reason": "fraud suspected"}, headers=staff(client, "p@x.com", "police"))
    assert client.post("/api/ledger/apply", json=body(kyc_number="NEW-7654321"), headers=t).status_code == 201


def test_officer_can_verify_in_person_and_verification_shows_everywhere(client):
    t = user(client)
    payload = client.post("/api/ledger/apply", json=body(), headers=t).json()["payload"]
    off = staff(client, "o@x.com", "officer")
    row = client.get("/api/tourists", headers=off).json()["items"][0]
    assert row["verification"] == "self_declared"
    assert client.post(f"/api/tourists/{row['tourist_id']}/verify-in-person", headers=off).json()["verification"] == "officer"
    assert client.post("/api/ledger/verify", json={"payload": payload}).json()["verification"] == "officer"
    assert client.get("/api/ledger/my-credential", headers=t).json()["verification"] == "officer"
    assert client.post(f"/api/tourists/{row['tourist_id']}/verify-in-person", headers=t).status_code == 403
    assert client.post("/api/tourists/999/verify-in-person", headers=off).status_code == 404
    with Session(appdb.engine) as s:
        assert "verify_id_in_person" in [a.action for a in s.exec(select(AuditLog)).all()]


def test_officer_issued_ids_are_officer_verified(client):
    user(client)
    off = staff(client, "o@x.com", "officer")
    payload = client.post("/api/ledger/issue", json=issue_body(), headers=off).json()["payload"]
    assert client.post("/api/ledger/verify", json={"payload": payload}).json()["verification"] == "officer"


def test_apply_is_rate_limited(client, monkeypatch):
    t = user(client)
    monkeypatch.setattr(settings, "rate_limit_enabled", True)
    codes = [client.post("/api/ledger/apply", json=body(), headers=t).status_code for _ in range(7)]
    assert codes == [201, 409, 409, 409, 409, 429, 429]               # attempts, not just successes, are counted


def test_renewal_keeps_the_verification_level_and_document_index(client):
    t = user(client)
    client.post("/api/ledger/apply", json=body(), headers=t)
    off = staff(client, "o@x.com", "officer")
    tid = client.get("/api/tourists", headers=off).json()["items"][0]["tourist_id"]
    r = client.post(f"/api/tourists/{tid}/renew", json={"valid_to": iso(NOW + timedelta(days=30))}, headers=off)
    assert r.status_code == 201
    assert client.post("/api/ledger/apply", json=body(), headers=t).status_code == 409           # still has a valid ID
    other = user(client, "z@x.com", "Zed")
    assert client.post("/api/ledger/apply", json=body(), headers=other).status_code == 409        # document still taken after renewal


def test_start_date_one_day_behind_utc_is_accepted(client):
    """Regression: a visitor in India just after midnight sends yesterday's UTC date and was told 'start date in the past'."""
    t = user(client)
    yesterday = NOW.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=1)
    r = client.post("/api/ledger/apply", json=body(valid_from=iso(yesterday), valid_to=iso(NOW + timedelta(days=5))), headers=t)
    assert r.status_code == 201
