"""Ledger-anchored digital ID primitives (paper Section III-D).

Record  r_u = (id, issuer, H(s1||v1), H(s2||v2), H(s3||v3), t_from, t_to)
Blocks  hold B records; header = (height, prev header hash, Merkle root, time) and is
        signed with ECDSA P-256 / SHA-256 by the issuing authority.
Credential (QR) = record + Merkle path + signed header, verifiable offline.
No personal value is ever written to the ledger, only salted SHA-256 commitments.
"""
import base64
import hashlib
import json
import os
import time
from dataclasses import dataclass
from pathlib import Path

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

ZERO_HASH = b"\x00" * 32
PRIVATE_FIELDS = ("kyc", "itinerary", "contacts")


# ---------- encoding helpers ----------
def b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def canonical(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()


def sha256(b: bytes) -> bytes:
    return hashlib.sha256(b).digest()


# ---------- salted commitments ----------
def new_salt() -> bytes:
    return os.urandom(16)


def commit(salt: bytes, value) -> bytes:
    """H(salt || canonical(value))."""
    return sha256(salt + canonical(value))


def check_reveal(commitment_b64: str, salt_b64: str, value) -> bool:
    """Police reveal check: hash the handed-over value and salt and compare."""
    return commit(unb64(salt_b64), value) == unb64(commitment_b64)


# ---------- record ----------
def make_record(id_code: str, issuer: str, commitments: list[bytes], t_from: int, t_to: int) -> dict:
    return {"i": id_code, "s": issuer, "c": [b64(c) for c in commitments], "f": t_from, "t": t_to}


def leaf_hash(record: dict) -> bytes:
    return sha256(b"\x00" + canonical(record))


# ---------- Merkle tree ----------
def _node(l: bytes, r: bytes) -> bytes:
    return sha256(b"\x01" + l + r)


def merkle_root(leaves: list[bytes]) -> bytes:
    if not leaves:
        return ZERO_HASH
    level = list(leaves)
    while len(level) > 1:
        if len(level) % 2:
            level.append(level[-1])
        level = [_node(level[i], level[i + 1]) for i in range(0, len(level), 2)]
    return level[0]


def merkle_path(leaves: list[bytes], index: int) -> list[tuple[bytes, int]]:
    """Sibling hashes bottom-up; flag 1 = sibling is on the right."""
    path, level, i = [], list(leaves), index
    while len(level) > 1:
        if len(level) % 2:
            level.append(level[-1])
        sib = i ^ 1
        path.append((level[sib], 1 if sib > i else 0))
        level = [_node(level[j], level[j + 1]) for j in range(0, len(level), 2)]
        i //= 2
    return path


def root_from_path(leaf: bytes, path: list[tuple[bytes, int]]) -> bytes:
    h = leaf
    for sib, right in path:
        h = _node(h, sib) if right else _node(sib, h)
    return h


# ---------- authority keys / headers ----------
class Authority:
    """The issuing authority (tourism dept + police). One signing key, ECDSA P-256."""

    def __init__(self, key: ec.EllipticCurvePrivateKey):
        self._key = key
        self.public_key = key.public_key()

    @classmethod
    def load_or_create(cls, path: Path) -> "Authority":
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            key = serialization.load_pem_private_key(path.read_bytes(), password=None)
        else:
            key = ec.generate_private_key(ec.SECP256R1())
            path.write_bytes(key.private_bytes(
                serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,
                serialization.NoEncryption()))
        return cls(key)

    def public_pem(self) -> str:
        return self.public_key.public_bytes(
            serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()

    def sign_header(self, header: dict) -> bytes:
        return self._key.sign(canonical(header), ec.ECDSA(hashes.SHA256()))


def make_header(height: int, prev_hash: bytes, root: bytes, ts: int) -> dict:
    return {"h": height, "p": b64(prev_hash), "r": b64(root), "t": ts}


def header_hash(header: dict) -> bytes:
    return sha256(canonical(header))


def verify_signature(public_key, header: dict, sig: bytes) -> bool:
    try:
        public_key.verify(sig, canonical(header), ec.ECDSA(hashes.SHA256()))
        return True
    except InvalidSignature:
        return False


# ---------- credential (QR payload) ----------
def build_credential(record: dict, path: list[tuple[bytes, int]], header: dict, sig: bytes) -> str:
    cred = {"v": 1, "r": record, "m": [[b64(s), d] for s, d in path], "H": header, "g": b64(sig)}
    return json.dumps(cred, separators=(",", ":"))


@dataclass
class VerifyResult:
    valid: bool
    merkle_ok: bool = False
    signature_ok: bool = False
    in_validity: bool = False
    reason: str = ""
    record: dict | None = None


def verify_credential(payload: str, public_key, now: int | None = None) -> VerifyResult:
    """Offline verification: recompute root from path, check signature, check dates."""
    now = int(time.time()) if now is None else now
    try:
        cred = json.loads(payload)
        record, header = cred["r"], cred["H"]
        path = [(unb64(s), int(d)) for s, d in cred["m"]]
        sig = unb64(cred["g"])
        root = root_from_path(leaf_hash(record), path)
        merkle_ok = b64(root) == header["r"]
        signature_ok = verify_signature(public_key, header, sig)
        in_validity = record["f"] <= now <= record["t"]
    except Exception:
        return VerifyResult(False, reason="Malformed credential")
    reasons = []
    if not merkle_ok:
        reasons.append("Merkle proof does not match block root")
    if not signature_ok:
        reasons.append("Block header signature invalid")
    if not in_validity:
        reasons.append("Outside validity period")
    return VerifyResult(merkle_ok and signature_ok and in_validity, merkle_ok, signature_ok,
                        in_validity, "; ".join(reasons), record)
