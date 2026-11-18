from datetime import datetime, timezone
from enum import Enum
from typing import Optional

from sqlmodel import Field, SQLModel


def now() -> datetime:
    return datetime.now(timezone.utc)


class Role(str, Enum):
    tourist = "tourist"
    officer = "officer"  # entry-point issuing officer (tourism dept)
    police = "police"    # control room / police
    admin = "admin"


class User(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    email: str = Field(index=True, unique=True)
    full_name: str
    password_hash: str
    role: Role = Role.tourist
    language: str = "en"
    disabled: bool = False        # disabled accounts cannot sign in and their tokens stop working
    token_version: int = 0        # bumped on password change / logout-all / role change: older JWTs die
    created_at: datetime = Field(default_factory=now)


class Tourist(SQLModel, table=True):
    """Tourist profile. Raw PII is NOT stored here; it lives in the encrypted
    off-chain store added in Phase 2."""
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(foreign_key="user.id", index=True)
    id_code: Optional[str] = Field(default=None, index=True)  # ledger ID (Phase 2)
    valid_from: Optional[datetime] = None
    valid_to: Optional[datetime] = None
    share_with_family: bool = False
    share_token: Optional[str] = None
    id_verification: str = "officer"   # officer = checked in person | self_declared = issued online, not yet checked


class Itinerary(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    tourist_id: int = Field(foreign_key="tourist.id", index=True)
    route_json: str = "[]"  # planned route polyline [[lat, lon], ...]
    stops_json: str = "[]"  # planned stops / hotels [{name, lat, lon, hotel}]


class Zone(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    name: str
    polygon_json: str  # [[lat, lon], ...]
    risk_weight: float = 0.5  # 0..1
    no_entry: bool = False


class Fix(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    tourist_id: int = Field(foreign_key="tourist.id", index=True)
    lat: float
    lon: float
    accuracy: float = 10.0
    ts: datetime = Field(default_factory=now, index=True)


class Alert(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    tourist_id: int = Field(foreign_key="tourist.id", index=True)
    kind: str  # zone_entry|zone_warning|dropoff|inactivity|deviation|panic
    detail: str = ""
    lat: Optional[float] = None
    lon: Optional[float] = None
    status: str = "open"  # open|acknowledged|dispatched|resolved
    score: Optional[float] = None  # Isolation Forest priority 0..1 (ranking only)
    rule: Optional[str] = None     # R1|R2|R3 for detector alerts
    incident_id: Optional[int] = Field(default=None, index=True)
    resolution: Optional[str] = None  # resolved | false_alarm | cancelled_by_user
    assigned_to: Optional[int] = Field(default=None, index=True)   # police/admin user handling it
    zone_id: Optional[int] = None                                  # for zone alerts: which zone
    acknowledged_at: Optional[datetime] = None
    resolved_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=now, index=True)


class Incident(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    tourist_id: int = Field(foreign_key="tourist.id", index=True)
    status: str = "open"
    opened_at: datetime = Field(default_factory=now)
    closed_at: Optional[datetime] = None


class LedgerBlock(SQLModel, table=True):
    height: int = Field(primary_key=True)
    prev_hash: str
    merkle_root: str
    ts: int
    signature: str


class LedgerRecord(SQLModel, table=True):
    """On-chain record: only salted commitments, never personal data."""
    id_code: str = Field(primary_key=True)
    block_height: int = Field(foreign_key="ledgerblock.height", index=True)
    idx: int
    record_json: str


class OffchainPII(SQLModel, table=True):
    """Encrypted (Fernet) KYC / itinerary / contacts + salts. Erasable after expiry."""
    id_code: str = Field(primary_key=True)
    ciphertext: bytes
    valid_to: int = Field(index=True)


class AuditLog(SQLModel, table=True):
    """Who touched what. Required because personal data is opened only for active cases."""
    id: Optional[int] = Field(default=None, primary_key=True)
    user_id: int = Field(index=True)
    action: str  # ack|dispatch|resolve|reveal_pii|efir
    tourist_id: Optional[int] = None
    incident_id: Optional[int] = None
    detail: str = ""
    ts: datetime = Field(default_factory=now, index=True)


class RevocationEntry(SQLModel, table=True):
    """Append-only, hash-chained and signed revocation list (a revoked ID fails verification before expiry)."""
    id: Optional[int] = Field(default=None, primary_key=True)
    id_code: str = Field(index=True)
    reason: str
    revoked_by: int
    ts: int
    prev_hash: str
    entry_hash: str
    signature: str


class IncidentNote(SQLModel, table=True):
    """Free-text notes by control-room staff on an incident (part of its timeline; audited)."""
    id: Optional[int] = Field(default=None, primary_key=True)
    incident_id: int = Field(foreign_key="incident.id", index=True)
    user_id: int
    text: str
    ts: datetime = Field(default_factory=now, index=True)


class SystemSettings(SQLModel, table=True):
    """Single row (id=1): admin-calibrated detection/geo parameters stored as JSON over the paper's defaults."""
    id: int = Field(default=1, primary_key=True)
    values_json: str = "{}"
    updated_by: Optional[int] = None
    updated_at: datetime = Field(default_factory=now)


class KycIndex(SQLModel, table=True):
    """Keyed hash (HMAC) of the normalised identity-document number, one row per ID. Lets the system refuse a second
    ACTIVE ID for the same document without storing the number itself. Removed when the personal data is erased."""
    id_code: str = Field(primary_key=True)
    digest: str = Field(index=True)
