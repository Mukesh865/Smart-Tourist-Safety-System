"""Reproduces the paper's ledger measurements (Table IV) as automated tests."""
import json
import random
import time
from pathlib import Path

import pytest

from app.ledger import core as L

B = 256


@pytest.fixture(scope="module")
def authority(tmp_path_factory):
    return L.Authority.load_or_create(Path(tmp_path_factory.mktemp("k")) / "a.pem")


def build_block(authority, n=B, height=0, prev=L.ZERO_HASH, t_from=0, t_to=2_000_000_000):
    records, salts = [], []
    for k in range(n):
        s = [L.new_salt() for _ in range(3)]
        vals = [f"KYC{k}", {"stops": [k]}, ["+91-9000000000"]]
        c = [L.commit(si, v) for si, v in zip(s, vals)]
        records.append(L.make_record(f"T{height}-{k}", "TOURISM-DEPT", c, t_from, t_to))
        salts.append(s)
    leaves = [L.leaf_hash(r) for r in records]
    header = L.make_header(height, prev, L.merkle_root(leaves), int(time.time()))
    sig = authority.sign_header(header)
    return records, leaves, header, sig


def cred(records, leaves, header, sig, i):
    return L.build_credential(records[i], L.merkle_path(leaves, i), header, sig)


def test_valid_credential_every_record(authority):
    records, leaves, header, sig = build_block(authority, 37)  # odd size exercises duplication
    for i in range(len(records)):
        r = L.verify_credential(cred(records, leaves, header, sig, i), authority.public_key)
        assert r.valid, r.reason


def test_merkle_path_length_is_log2(authority):
    _, leaves, _, _ = build_block(authority)
    assert len(L.merkle_path(leaves, 5)) == 8  # paper: 8 hashes for B=256


def test_qr_payload_fits_largest_qr(authority):
    records, leaves, header, sig = build_block(authority)
    payload = cred(records, leaves, header, sig, 100)
    assert len(payload.encode()) < 2953  # ISO/IEC 18004 max (paper)
    print("QR payload bytes:", len(payload.encode()))


def test_no_personal_data_in_record(authority):
    records, *_ = build_block(authority, 1)
    blob = json.dumps(records[0])
    assert "KYC0" not in blob and "9000000000" not in blob


def test_commitment_reveal(authority):
    salt = L.new_salt()
    c = L.b64(L.commit(salt, "AADHAAR-1234"))
    assert L.check_reveal(c, L.b64(salt), "AADHAAR-1234")
    assert not L.check_reveal(c, L.b64(salt), "AADHAAR-9999")


def test_validity_window(authority):
    records, leaves, header, sig = build_block(authority, 4, t_from=1000, t_to=2000)
    p = cred(records, leaves, header, sig, 0)
    assert L.verify_credential(p, authority.public_key, now=1500).valid
    r = L.verify_credential(p, authority.public_key, now=2500)
    assert not r.valid and not r.in_validity and r.merkle_ok and r.signature_ok
    assert not L.verify_credential(p, authority.public_key, now=500).valid


TRIALS = 300  # paper used 3,000; same logic, quicker test run


def test_tampered_record_detected(authority):
    records, leaves, header, sig = build_block(authority)
    rng = random.Random(1)
    for _ in range(TRIALS):
        i = rng.randrange(B)
        cred_obj = json.loads(cred(records, leaves, header, sig, i))
        field = rng.choice(["i", "s", "f", "t", "c"])
        if field == "c":
            cred_obj["r"]["c"][rng.randrange(3)] = L.b64(rng.randbytes(32))
        elif field in ("f", "t"):
            cred_obj["r"][field] += rng.randrange(1, 10**6)
        else:
            cred_obj["r"][field] += "x"
        assert not L.verify_credential(json.dumps(cred_obj), authority.public_key).valid


def test_tampered_header_detected(authority):
    records, leaves, header, sig = build_block(authority)
    rng = random.Random(2)
    for _ in range(TRIALS):
        cred_obj = json.loads(cred(records, leaves, header, sig, rng.randrange(B)))
        raw = bytearray(L.unb64(cred_obj["H"]["r"]))
        raw[rng.randrange(32)] ^= 1 << rng.randrange(8)  # flip one bit
        cred_obj["H"]["r"] = L.b64(bytes(raw))
        assert not L.verify_credential(json.dumps(cred_obj), authority.public_key).valid


def test_forged_rerooted_block_detected(authority):
    """Attacker forges a record, rebuilds the tree + root, reuses the old signature."""
    records, leaves, header, sig = build_block(authority)
    rng = random.Random(3)
    for _ in range(TRIALS):
        i = rng.randrange(B)
        forged = dict(records[i], i="FORGED-%d" % rng.randrange(10**9))
        new_leaves = list(leaves)
        new_leaves[i] = L.leaf_hash(forged)
        new_header = dict(header, r=L.b64(L.merkle_root(new_leaves)))
        p = L.build_credential(forged, L.merkle_path(new_leaves, i), new_header, sig)
        r = L.verify_credential(p, authority.public_key)
        assert r.merkle_ok and not r.signature_ok and not r.valid


def test_wrong_authority_key_rejected(authority, tmp_path):
    other = L.Authority.load_or_create(tmp_path / "other.pem")
    records, leaves, header, sig = build_block(authority, 4)
    assert not L.verify_credential(cred(records, leaves, header, sig, 0), other.public_key).valid


def test_malformed_payload():
    auth = L.Authority.load_or_create(Path(__file__).parent / "_tmp_key.pem")
    try:
        assert not L.verify_credential("not json", auth.public_key).valid
        assert not L.verify_credential("{}", auth.public_key).valid
    finally:
        (Path(__file__).parent / "_tmp_key.pem").unlink(missing_ok=True)


def test_verify_time_under_1ms(authority):
    """Paper Table V limit: ID check < 1,000 us (paper measured 54 us)."""
    records, leaves, header, sig = build_block(authority)
    payload = cred(records, leaves, header, sig, 10)
    n = 200
    t0 = time.perf_counter()
    for _ in range(n):
        L.verify_credential(payload, authority.public_key)
    us = (time.perf_counter() - t0) / n * 1e6
    print(f"verify: {us:.1f} us")
    assert us < 1000


def test_chain_linkage(authority):
    prev = L.ZERO_HASH
    headers = []
    for h in range(3):
        _, _, header, _ = build_block(authority, 4, height=h, prev=prev)
        headers.append(header)
        prev = L.header_hash(header)
    for a, b in zip(headers, headers[1:]):
        assert b["p"] == L.b64(L.header_hash(a))
