import json
import time
from datetime import datetime, timedelta, timezone

from sqlmodel import Session, select

from app import db as appdb
from app.ledger import core, service
from app.models import AuditLog, LedgerRecord, OffchainPII, RevocationEntry, Tourist
from tests.test_detection_service import BASE, put, run
from tests.test_ledger_api import H, KYC, PHONE, issue_body, setup_users, token
from tests.test_zones_location_api import ll, send


def world(client):
    """officer, tourist (with ID), police, admin tokens + the tourist's id_code and payload."""
    off, tour, adm = setup_users(client)
    client.post("/api/auth/staff", headers=H(adm), json={"email": "p@x.com", "full_name": "Pol", "password": "password123", "role": "police"})
    pol = token(client, "p@x.com")
    r = client.post("/api/ledger/issue", json=issue_body(), headers=H(off)).json()
    return dict(off=off, tour=tour, adm=adm, pol=pol, code=r["id_code"], payload=r["payload"])


def verify(client, payload):
    return client.post("/api/ledger/verify", json={"payload": payload}).json()


# ------------------------------------------------------------------ revocation
def test_revoked_id_fails_verification_even_though_signature_and_dates_are_fine(client):
    w = world(client)
    assert verify(client, w["payload"])["valid"] is True
    r = client.post(f"/api/ledger/{w['code']}/revoke", json={"reason": "Reported lost"}, headers=H(w["pol"]))
    assert r.status_code == 201 and r.json()["id_code"] == w["code"]
    v = verify(client, w["payload"])
    assert v["valid"] is False and v["revoked"] is True
    assert v["merkle_ok"] and v["signature_ok"] and v["in_validity"]         # crypto is still fine; only the list says no
    assert "Reported lost" in v["reason"]


def test_revoke_guards_and_validation(client):
    w = world(client)
    url = f"/api/ledger/{w['code']}/revoke"
    for who in ("off", "tour"):
        assert client.post(url, json={"reason": "abuse"}, headers=H(w[who])).status_code == 403
    assert client.post(url, json={"reason": "abuse"}).status_code == 401
    assert client.post(url, json={"reason": "x"}, headers=H(w["pol"])).status_code == 422
    assert client.post("/api/ledger/TID-NOPE/revoke", json={"reason": "abuse"}, headers=H(w["pol"])).status_code == 404
    assert client.post(url, json={"reason": "abuse"}, headers=H(w["adm"])).status_code == 201
    assert client.post(url, json={"reason": "again"}, headers=H(w["pol"])).status_code == 409


def test_revoked_tourist_is_refused_tracking_and_not_monitored(client):
    w = world(client)
    assert send(client, w["tour"], 0, 0).status_code == 200
    client.post(f"/api/ledger/{w['code']}/revoke", json={"reason": "Visa cancelled"}, headers=H(w["pol"]))
    r = send(client, w["tour"], 0, 0)
    assert r.status_code == 403 and "revoked" in r.json()["detail"]
    with Session(appdb.engine) as s:
        tid = s.exec(select(Tourist)).first().id
    put(tid, [(m, m * 20.0, 0.0) for m in range(30)])                           # would normally raise a drop-off alert
    assert run(55) == []


def test_tourist_sees_revoked_state_in_their_app(client):
    w = world(client)
    client.post(f"/api/ledger/{w['code']}/revoke", json={"reason": "Visa cancelled"}, headers=H(w["pol"]))
    c = client.get("/api/ledger/my-credential", headers=H(w["tour"])).json()
    assert c["revoked"] is True and c["revoked_reason"] == "Visa cancelled"


def test_public_revocation_list_is_a_verifiable_chain(client):
    w = world(client)
    assert client.get("/api/ledger/revocations").json()["entries"] == []         # public, no login
    client.post(f"/api/ledger/{w['code']}/revoke", json={"reason": "first"}, headers=H(w["pol"]))
    off2 = client.post("/api/auth/register", json={"email": "u2@x.com", "full_name": "U2", "password": "password123"})
    c2 = client.post("/api/ledger/issue", json=issue_body(tourist_email="u2@x.com"), headers=H(w["off"])).json()["id_code"]
    client.post(f"/api/ledger/{c2}/revoke", json={"reason": "second"}, headers=H(w["pol"]))
    lst = client.get("/api/ledger/revocations").json()
    assert [e["reason"] for e in lst["entries"]] == ["first", "second"]
    assert lst["entries"][1]["prev_hash"] == lst["entries"][0]["entry_hash"] and lst["head"] == lst["entries"][1]["entry_hash"]
    assert client.get("/api/ledger/revocations/audit", headers=H(w["pol"])).json() == {"ok": True, "entries": 2, "broken_at": None}
    assert client.get("/api/ledger/revocations/audit", headers=H(w["tour"])).status_code == 403
    assert "kyc" not in json.dumps(lst).lower() and KYC not in json.dumps(lst)


def test_tampering_with_the_revocation_list_is_detected(client):
    w = world(client)
    client.post(f"/api/ledger/{w['code']}/revoke", json={"reason": "legit reason"}, headers=H(w["pol"]))
    with Session(appdb.engine) as s:
        e = s.exec(select(RevocationEntry)).one()
        e.reason = "edited later"                                              # someone rewrites history in the DB
        s.add(e)
        s.commit()
    assert client.get("/api/ledger/revocations/audit", headers=H(w["pol"])).json()["ok"] is False


# ------------------------------------------------------------------ renew / extend
def test_renew_issues_new_id_and_supersedes_the_old_one(client):
    w = world(client)
    tid = client.get("/api/tourists", headers=H(w["off"])).json()["items"][0]["tourist_id"]
    new_end = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()
    r = client.post(f"/api/tourists/{tid}/renew", json={"valid_to": new_end}, headers=H(w["off"]))
    assert r.status_code == 201
    new = r.json()
    assert new["id_code"] != w["code"] and new["previous"] == w["code"]
    assert verify(client, new["payload"])["valid"] is True
    old = verify(client, w["payload"])
    assert old["valid"] is False and "superseded by " + new["id_code"] in old["reason"]
    mine = client.get("/api/ledger/my-credential", headers=H(w["tour"])).json()
    assert mine["id_code"] == new["id_code"] and mine["revoked"] is False
    # same verified details carried over, old copy removed
    with Session(appdb.engine) as s:
        pii = service.load_pii(s, new["id_code"])
        assert pii["values"]["kyc"] == KYC and pii["values"]["contacts"][0]["phone"] == PHONE
        assert s.get(OffchainPII, w["code"]) is None
        assert "renew_id" in [a.action for a in s.exec(select(AuditLog)).all()]


def test_renew_validation_and_guards(client):
    w = world(client)
    tid = client.get("/api/tourists", headers=H(w["off"])).json()["items"][0]["tourist_id"]
    past = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    future = (datetime.now(timezone.utc) + timedelta(days=5)).isoformat()
    assert client.post(f"/api/tourists/{tid}/renew", json={"valid_to": past}, headers=H(w["off"])).status_code == 422
    assert client.post(f"/api/tourists/{tid}/renew", json={"valid_to": future}, headers=H(w["pol"])).status_code == 403
    assert client.post(f"/api/tourists/{tid}/renew", json={"valid_to": future}, headers=H(w["tour"])).status_code == 403
    assert client.post("/api/tourists/999/renew", json={"valid_to": future}, headers=H(w["off"])).status_code == 404


def test_renew_after_personal_data_was_erased_is_refused(client):
    w = world(client)
    tid = client.get("/api/tourists", headers=H(w["off"])).json()["items"][0]["tourist_id"]
    with Session(appdb.engine) as s:
        for r in s.exec(select(OffchainPII)).all():
            s.delete(r)
        s.commit()
    future = (datetime.now(timezone.utc) + timedelta(days=5)).isoformat()
    r = client.post(f"/api/tourists/{tid}/renew", json={"valid_to": future}, headers=H(w["off"]))
    assert r.status_code == 410 and "entry point" in r.json()["detail"]
    assert verify(client, w["payload"])["valid"] is True                     # nothing was changed by the failed attempt


def test_renew_without_an_id(client):
    off, tour, adm = setup_users(client)
    tid = client.get("/api/tourists", headers=H(off)).json()["items"][0]["tourist_id"]
    future = (datetime.now(timezone.utc) + timedelta(days=5)).isoformat()
    assert client.post(f"/api/tourists/{tid}/renew", json={"valid_to": future}, headers=H(off)).status_code == 409


# ------------------------------------------------------------------ tourists list / detail
def test_tourist_list_search_status_and_roles(client):
    w = world(client)
    for i in range(3):
        client.post("/api/auth/register", json={"email": f"extra{i}@x.com", "full_name": f"Extra {i}", "password": "password123"})
    items = client.get("/api/tourists", headers=H(w["off"])).json()
    assert items["total"] == 4
    by = {i["email"]: i for i in items["items"]}
    assert by["t@x.com"]["status"] == "active" and by["extra0@x.com"]["status"] == "no_id"
    assert client.get("/api/tourists?q=EXTRA1", headers=H(w["off"])).json()["total"] == 1
    assert client.get(f"/api/tourists?q={w['code'][:8]}", headers=H(w["off"])).json()["total"] == 1     # search by ID code
    assert client.get("/api/tourists?status=no_id", headers=H(w["off"])).json()["total"] == 3
    assert len(client.get("/api/tourists?limit=2&offset=2", headers=H(w["adm"])).json()["items"]) == 2
    for who in ("pol", "tour"):
        assert client.get("/api/tourists", headers=H(w[who])).status_code == 403      # police see pseudonymous IDs only


def test_status_expiring_expired_revoked(client):
    w = world(client)
    code = lambda: client.get("/api/tourists", headers=H(w["off"])).json()["items"][0]["status"]
    with Session(appdb.engine) as s:
        t = s.exec(select(Tourist)).first()
        t.valid_to = datetime.now(timezone.utc) + timedelta(hours=10)
        s.add(t)
        s.commit()
    assert code() == "expiring"
    with Session(appdb.engine) as s:
        t = s.exec(select(Tourist)).first()
        t.valid_to = datetime.now(timezone.utc) - timedelta(hours=1)
        s.add(t)
        s.commit()
    assert code() == "expired"
    client.post(f"/api/ledger/{w['code']}/revoke", json={"reason": "fraud"}, headers=H(w["pol"]))
    assert code() == "revoked"                                                 # revoked wins over expired


def test_tourist_detail_and_credential_for_id_card(client):
    w = world(client)
    tid = client.get("/api/tourists", headers=H(w["off"])).json()["items"][0]["tourist_id"]
    d = client.get(f"/api/tourists/{tid}", headers=H(w["off"])).json()
    assert d["id_code"] == w["code"] and d["status"] == "active" and len(d["itinerary"]["stops"]) == 1
    card = client.get(f"/api/tourists/{tid}/credential", headers=H(w["off"])).json()
    assert card["payload"] == w["payload"] and card["name"] == "Tess"
    assert KYC not in json.dumps(card) and PHONE not in json.dumps(card)
    assert client.get("/api/tourists/999", headers=H(w["off"])).status_code == 404


# ------------------------------------------------------------------ itinerary editing
def test_itinerary_update_changes_what_detection_considers_off_route(client):
    w = world(client)                                  # issued with a short route near the old default coordinates
    with Session(appdb.engine) as s:
        tid = s.exec(select(Tourist)).first().id
    far = [(m, 4000.0, 3000.0) for m in range(30)]     # the tourist stands 3 km from the declared route
    put(tid, far)
    assert [a.kind for a in run(29)] == ["deviation"]  # R3: more than 1 km from the route for 10+ minutes
    from app.detect import service as detect
    detect._state.clear()
    body = {"route": [list(ll(4000, 3000)), list(ll(4500, 3000))], "stops": [
        {"name": "Hotel", "lat": ll(4000, 3000)[0], "lon": ll(4000, 3000)[1], "hotel": True}]}
    r = client.put(f"/api/tourists/{tid}/itinerary", json=body, headers=H(w["off"]))
    assert r.status_code == 200
    assert run(35) == []                               # with the corrected route the same position is on-route


def test_itinerary_validation_roles_and_audit(client):
    w = world(client)
    tid = client.get("/api/tourists", headers=H(w["off"])).json()["items"][0]["tourist_id"]
    bad = {"route": [[95.0, 10.0]], "stops": []}
    assert client.put(f"/api/tourists/{tid}/itinerary", json=bad, headers=H(w["off"])).status_code == 422
    assert client.put(f"/api/tourists/{tid}/itinerary", json={"route": [], "stops": [{"name": "", "lat": 1, "lon": 1}]}, headers=H(w["off"])).status_code == 422
    ok = {"route": [[25.5, 91.8], [25.6, 91.9]], "stops": []}
    assert client.put(f"/api/tourists/{tid}/itinerary", json=ok, headers=H(w["pol"])).status_code == 403
    assert client.put(f"/api/tourists/{tid}/itinerary", json=ok, headers=H(w["off"])).status_code == 200
    assert client.get(f"/api/tourists/{tid}", headers=H(w["off"])).json()["itinerary"]["route"] == ok["route"]
    with Session(appdb.engine) as s:
        assert "update_itinerary" in [a.action for a in s.exec(select(AuditLog)).all()]


# ------------------------------------------------------------------ explorer + batch blocks
def test_explorer_lists_blocks_without_personal_data(client):
    w = world(client)
    r = client.get("/api/ledger/blocks", headers=H(w["pol"])).json()
    assert r["total"] == 1 and r["items"][0]["signature_ok"] and r["items"][0]["root_ok"] and r["items"][0]["records"] == 1
    d = client.get("/api/ledger/blocks/0", headers=H(w["pol"]))
    body = d.json()
    assert body["records"][0]["id_code"] == w["code"] and len(body["records"][0]["commitments"]) == 3
    assert KYC not in d.text and PHONE not in d.text and "Tess" not in d.text
    assert client.get("/api/ledger/blocks/99", headers=H(w["pol"])).status_code == 404
    for who in ("off", "tour"):
        assert client.get("/api/ledger/blocks", headers=H(w[who])).status_code == 403


def test_explorer_flags_a_tampered_block_and_marks_revoked_records(client):
    w = world(client)
    client.post(f"/api/ledger/{w['code']}/revoke", json={"reason": "fraud"}, headers=H(w["pol"]))
    assert client.get("/api/ledger/blocks/0", headers=H(w["pol"])).json()["records"][0]["revoked"] is True
    with Session(appdb.engine) as s:
        rec = s.exec(select(LedgerRecord)).one()
        d = json.loads(rec.record_json)
        d["t"] += 5
        rec.record_json = json.dumps(d)
        s.add(rec)
        s.commit()
    assert client.get("/api/ledger/blocks", headers=H(w["pol"])).json()["items"][0]["root_ok"] is False


def test_batch_of_256_ids_in_one_block_matches_the_papers_numbers(client, tmp_path):
    """Paper Table IV: B = 256 gives a Merkle path of 8 hashes and a QR payload far below the 2,953-byte limit."""
    with Session(appdb.engine) as s:
        items = [{"kyc": f"KYC-{i:04d}", "itinerary": {"route": [], "stops": []}, "contacts": [{"name": "C", "phone": "+9100000"}],
                  "t_from": 0, "t_to": 2_000_000_000} for i in range(256)]
        t0 = time.perf_counter()
        issued = service.issue_many(s, items)
        elapsed = time.perf_counter() - t0
        assert len(issued) == 256 and len({c for c, _ in issued}) == 256
        pub = service.authority().public_key
        code, payload = issued[200]
        cred = json.loads(payload)
        assert len(cred["m"]) == 8                                            # log2(256) sibling hashes
        assert len(payload.encode()) < 2953
        assert all(core.verify_credential(p, pub).valid for _, p in issued[::17])
        assert service.verify_chain(s) == {"ok": True, "blocks": 1, "broken_at": None}
        print(f"256 IDs issued in one block in {elapsed:.2f}s, payload {len(payload)} bytes")


def test_issue_many_empty_and_two_batches_chain_together(client):
    with Session(appdb.engine) as s:
        assert service.issue_many(s, []) == []
        mk = lambda n: [{"kyc": f"K{n}{i}", "itinerary": {}, "contacts": [], "t_from": 0, "t_to": 2_000_000_000} for i in range(3)]
        service.issue_many(s, mk(1))
        service.issue_many(s, mk(2))
        assert service.verify_chain(s) == {"ok": True, "blocks": 2, "broken_at": None}


def test_lifecycle_actions_are_audited(client):
    w = world(client)
    tid = client.get("/api/tourists", headers=H(w["off"])).json()["items"][0]["tourist_id"]
    client.put(f"/api/tourists/{tid}/itinerary", json={"route": [], "stops": []}, headers=H(w["off"]))
    client.post(f"/api/ledger/{w['code']}/revoke", json={"reason": "fraud"}, headers=H(w["pol"]))
    log = client.get("/api/admin/audit", headers=H(w["adm"])).json()["items"]
    actions = {a["action"] for a in log}
    assert {"issue_id", "update_itinerary", "revoke_id"} <= actions
    assert any("fraud" in a["detail"] for a in log if a["action"] == "revoke_id")
