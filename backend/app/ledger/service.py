"""DB-backed ledger: issuing (single or batched blocks), credentials, revocation list, chain audit, DPDP erasure."""
import json
import secrets
import time
from functools import lru_cache
from pathlib import Path

from cryptography.fernet import Fernet
from sqlmodel import Session, select

from ..config import settings
import hashlib
import hmac
import re

from ..models import KycIndex, LedgerBlock, LedgerRecord, OffchainPII, RevocationEntry
from . import core

ISSUER = "TOURISM-DEPT"


@lru_cache(maxsize=4)
def _authority(keys_dir: str) -> core.Authority:
    return core.Authority.load_or_create(Path(keys_dir) / "authority.pem")


@lru_cache(maxsize=4)
def _fernet(keys_dir: str) -> Fernet:
    p = Path(keys_dir) / "pii.key"
    p.parent.mkdir(parents=True, exist_ok=True)
    if not p.exists():
        p.write_bytes(Fernet.generate_key())
    return Fernet(p.read_bytes())


def authority() -> core.Authority:
    return _authority(settings.keys_dir)


def fernet() -> Fernet:
    return _fernet(settings.keys_dir)


def _header_of(b: LedgerBlock) -> dict:
    return {"h": b.height, "p": b.prev_hash, "r": b.merkle_root, "t": b.ts}


# ---------------------------------------------------------------- issuing
def issue_many(session: Session, items: list[dict]) -> list[tuple[str, str]]:
    """Issue several IDs in ONE signed block (paper: blocks of B records; Merkle path length ~ log2 B).
    items: [{kyc, itinerary, contacts, t_from, t_to}]. Personal values are encrypted off-chain; only salted
    commitments go into the records. Returns [(id_code, credential_payload)]."""
    if not items:
        return []
    records, secrets_by_id, codes = [], {}, []
    for it in items:
        id_code = "TID-" + secrets.token_hex(5).upper()
        values = {"kyc": it["kyc"], "itinerary": it["itinerary"], "contacts": it["contacts"]}
        salts = {f: core.new_salt() for f in core.PRIVATE_FIELDS}
        commitments = [core.commit(salts[f], values[f]) for f in core.PRIVATE_FIELDS]
        records.append(core.make_record(id_code, ISSUER, commitments, it["t_from"], it["t_to"]))
        secrets_by_id[id_code] = ({"values": values, "salts": {f: core.b64(s) for f, s in salts.items()}}, it["t_to"])
        codes.append(id_code)

    last = session.exec(select(LedgerBlock).order_by(LedgerBlock.height.desc())).first()
    height = 0 if last is None else last.height + 1
    prev = core.ZERO_HASH if last is None else core.header_hash(_header_of(last))
    leaves = [core.leaf_hash(r) for r in records]
    header = core.make_header(height, prev, core.merkle_root(leaves), int(time.time()))
    sig = authority().sign_header(header)

    session.add(LedgerBlock(height=height, prev_hash=header["p"], merkle_root=header["r"], ts=header["t"],
                            signature=core.b64(sig)))
    session.flush()   # the block must exist before records reference it
    for idx, (rec, code) in enumerate(zip(records, codes)):
        session.add(LedgerRecord(id_code=code, block_height=height, idx=idx, record_json=json.dumps(rec)))
        secret, t_to = secrets_by_id[code]
        session.add(OffchainPII(id_code=code, ciphertext=fernet().encrypt(json.dumps(secret).encode()), valid_to=t_to))
    session.commit()
    return [(c, credential_for(session, c)) for c in codes]


def issue(session: Session, *, kyc: str, itinerary: dict, contacts: list, t_from: int, t_to: int) -> tuple[str, str]:
    """One ID, sealed in its own block so the credential is available immediately."""
    return issue_many(session, [{"kyc": kyc, "itinerary": itinerary, "contacts": contacts, "t_from": t_from, "t_to": t_to}])[0]


def credential_for(session: Session, id_code: str) -> str | None:
    rec = session.get(LedgerRecord, id_code)
    if rec is None:
        return None
    block = session.get(LedgerBlock, rec.block_height)
    siblings = session.exec(select(LedgerRecord).where(LedgerRecord.block_height == rec.block_height)
                            .order_by(LedgerRecord.idx)).all()
    leaves = [core.leaf_hash(json.loads(r.record_json)) for r in siblings]
    return core.build_credential(json.loads(rec.record_json), core.merkle_path(leaves, rec.idx),
                                 _header_of(block), core.unb64(block.signature))


def load_pii(session: Session, id_code: str | None) -> dict | None:
    row = session.get(OffchainPII, id_code) if id_code else None
    return json.loads(fernet().decrypt(row.ciphertext)) if row else None


# ---------------------------------------------------------------- revocation list
def _entry_hash(prev: str, id_code: str, reason: str, ts: int) -> str:
    return core.b64(core.sha256(core.canonical({"p": prev, "i": id_code, "r": reason, "t": ts})))


def revocation_for(session: Session, id_code: str | None) -> RevocationEntry | None:
    if not id_code:
        return None
    return session.exec(select(RevocationEntry).where(RevocationEntry.id_code == id_code)).first()


def revoke(session: Session, id_code: str, reason: str, by_user_id: int) -> RevocationEntry:
    """Append a signed, hash-chained revocation entry. Revoked IDs fail verification even before expiry."""
    last = session.exec(select(RevocationEntry).order_by(RevocationEntry.id.desc())).first()
    prev = last.entry_hash if last else core.b64(core.ZERO_HASH)
    ts = int(time.time())
    h = _entry_hash(prev, id_code, reason, ts)
    sig = authority().sign_header({"entry": h})
    e = RevocationEntry(id_code=id_code, reason=reason, revoked_by=by_user_id, ts=ts, prev_hash=prev,
                        entry_hash=h, signature=core.b64(sig))
    session.add(e)
    session.commit()
    session.refresh(e)
    return e


def verify_revocation_chain(session: Session) -> dict:
    prev = core.b64(core.ZERO_HASH)
    entries = session.exec(select(RevocationEntry).order_by(RevocationEntry.id)).all()
    for e in entries:
        ok = (e.prev_hash == prev and e.entry_hash == _entry_hash(prev, e.id_code, e.reason, e.ts)
              and core.verify_signature(authority().public_key, {"entry": e.entry_hash}, core.unb64(e.signature)))
        if not ok:
            return {"ok": False, "entries": len(entries), "broken_at": e.id}
        prev = e.entry_hash
    return {"ok": True, "entries": len(entries), "broken_at": None}


# ---------------------------------------------------------------- audit and erasure
def verify_chain(session: Session) -> dict:
    """Audit: every header links to its predecessor, roots recompute, signatures verify."""
    blocks = session.exec(select(LedgerBlock).order_by(LedgerBlock.height)).all()
    prev = core.ZERO_HASH
    for b in blocks:
        h = _header_of(b)
        recs = session.exec(select(LedgerRecord).where(LedgerRecord.block_height == b.height)
                            .order_by(LedgerRecord.idx)).all()
        root = core.merkle_root([core.leaf_hash(json.loads(r.record_json)) for r in recs])
        ok = (b.prev_hash == core.b64(prev) and b.merkle_root == core.b64(root)
              and core.verify_signature(authority().public_key, h, core.unb64(b.signature)))
        if not ok:
            return {"ok": False, "blocks": len(blocks), "broken_at": b.height}
        prev = core.header_hash(h)
    return {"ok": True, "blocks": len(blocks), "broken_at": None}


def block_summary(session: Session, b: LedgerBlock) -> dict:
    """Explorer row: hashes and counts only, never personal data."""
    recs = session.exec(select(LedgerRecord).where(LedgerRecord.block_height == b.height).order_by(LedgerRecord.idx)).all()
    root = core.merkle_root([core.leaf_hash(json.loads(r.record_json)) for r in recs])
    sig_ok = core.verify_signature(authority().public_key, _header_of(b), core.unb64(b.signature))
    return {"height": b.height, "ts": b.ts, "prev_hash": b.prev_hash, "merkle_root": b.merkle_root, "records": len(recs),
            "signature_ok": sig_ok, "root_ok": core.b64(root) == b.merkle_root, "id_codes": [r.id_code for r in recs]}


def kyc_digest(kyc: str) -> str:
    """Keyed hash of the document number (case, spaces and dashes ignored)."""
    key = (Path(settings.keys_dir) / "pii.key")
    fernet()                                   # makes sure the key file exists
    norm = re.sub(r"[\s\-]", "", kyc).upper()
    return hmac.new(key.read_bytes(), norm.encode(), hashlib.sha256).hexdigest()


def active_id_for_document(session: Session, kyc: str, now: int | None = None) -> str | None:
    """The ID code of a live (not revoked, not expired) ID already issued for this document, if any."""
    now = int(time.time()) if now is None else now
    for row in session.exec(select(KycIndex).where(KycIndex.digest == kyc_digest(kyc))).all():
        rec = session.get(LedgerRecord, row.id_code)
        if rec and json.loads(rec.record_json)["t"] >= now and revocation_for(session, row.id_code) is None:
            return row.id_code
    return None


def remember_document(session: Session, id_code: str, kyc: str) -> None:
    session.add(KycIndex(id_code=id_code, digest=kyc_digest(kyc)))


def erase_expired(session: Session, now: int | None = None) -> int:
    """DPDP Act 2023: delete off-chain personal data once the visit has ended.
    The ledger keeps only salted hashes, which are unlinkable once the salts are gone."""
    now = int(time.time()) if now is None else now
    rows = session.exec(select(OffchainPII).where(OffchainPII.valid_to < now)).all()
    for r in rows:
        session.delete(r)
        idx = session.get(KycIndex, r.id_code)      # the document hash goes with the data it was derived from
        if idx:
            session.delete(idx)
    session.commit()
    return len(rows)
