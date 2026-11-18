import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlmodel import Session, select

from ..db import get_session
from ..geo import manager
from ..models import Role, User, Zone
from ..security import current_user, require_roles

router = APIRouter(prefix="/api/zones", tags=["zones"])
manage = require_roles(Role.admin, Role.police)


class ZoneIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    polygon: list[tuple[float, float]] = Field(min_length=3, max_length=500)  # [lat, lon]
    risk_weight: float = Field(ge=0, le=1)
    no_entry: bool = False

    @field_validator("polygon")
    @classmethod
    def _valid(cls, v):
        for lat, lon in v:
            if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                raise ValueError("coordinates out of range")
        return v


class ZoneOut(BaseModel):
    id: int
    name: str
    polygon: list[tuple[float, float]]
    risk_weight: float
    no_entry: bool


def _out(z: Zone) -> ZoneOut:
    return ZoneOut(id=z.id, name=z.name, polygon=json.loads(z.polygon_json),
                   risk_weight=z.risk_weight, no_entry=z.no_entry)


@router.get("", response_model=list[ZoneOut])
def list_zones(_: User = Depends(current_user), session: Session = Depends(get_session)):
    return [_out(z) for z in session.exec(select(Zone)).all()]


@router.post("", response_model=ZoneOut, status_code=201, dependencies=[Depends(manage)])
def create_zone(data: ZoneIn, session: Session = Depends(get_session)):
    z = Zone(name=data.name, polygon_json=json.dumps(data.polygon),
             risk_weight=data.risk_weight, no_entry=data.no_entry)
    session.add(z)
    session.commit()
    session.refresh(z)
    manager.invalidate()
    return _out(z)


@router.put("/{zone_id}", response_model=ZoneOut, dependencies=[Depends(manage)])
def update_zone(zone_id: int, data: ZoneIn, session: Session = Depends(get_session)):
    z = session.get(Zone, zone_id)
    if not z:
        raise HTTPException(404, "Zone not found")
    z.name, z.polygon_json = data.name, json.dumps(data.polygon)
    z.risk_weight, z.no_entry = data.risk_weight, data.no_entry
    session.add(z)
    session.commit()
    manager.invalidate()
    return _out(z)


@router.delete("/{zone_id}", status_code=204, dependencies=[Depends(manage)])
def delete_zone(zone_id: int, session: Session = Depends(get_session)):
    z = session.get(Zone, zone_id)
    if not z:
        raise HTTPException(404, "Zone not found")
    session.delete(z)
    session.commit()
    manager.invalidate()


# ---------------------------------------------------------------- GeoJSON import / export
@router.get("/geojson", dependencies=[Depends(manage)])
def export_geojson(session: Session = Depends(get_session)):
    """FeatureCollection with [lon, lat] rings (GeoJSON order), ready for QGIS / geojson.io."""
    feats = []
    for z in session.exec(select(Zone).order_by(Zone.id)).all():
        ring = [[lon, lat] for lat, lon in json.loads(z.polygon_json)]
        if ring and ring[0] != ring[-1]:
            ring.append(ring[0])
        feats.append({"type": "Feature", "properties": {"name": z.name, "risk_weight": z.risk_weight, "no_entry": z.no_entry},
                      "geometry": {"type": "Polygon", "coordinates": [ring]}})
    return {"type": "FeatureCollection", "features": feats}


@router.post("/import", status_code=201)
def import_geojson(fc: dict, user: User = Depends(manage), session: Session = Depends(get_session)):
    """All-or-nothing import of Polygon features. Features with the same name as an existing zone are skipped."""
    if fc.get("type") != "FeatureCollection" or not isinstance(fc.get("features"), list):
        raise HTTPException(422, "Expected a GeoJSON FeatureCollection")
    if len(fc["features"]) > 500:
        raise HTTPException(422, "At most 500 zones per import")
    parsed = []
    for i, f in enumerate(fc["features"], 1):
        try:
            g, props = f["geometry"], f.get("properties") or {}
            if g["type"] != "Polygon":
                raise ValueError("only Polygon geometries are supported")
            ring = [(float(c[1]), float(c[0])) for c in g["coordinates"][0]]
            if len(ring) > 1 and ring[0] == ring[-1]:
                ring = ring[:-1]
            z = ZoneIn(name=str(props.get("name") or f"Imported zone {i}")[:80], polygon=ring,
                       risk_weight=float(props.get("risk_weight", 0.5)), no_entry=bool(props.get("no_entry", False)))
        except Exception as e:                       # report which feature is wrong; import nothing
            raise HTTPException(422, f"Feature {i}: {getattr(e, 'errors', lambda: None)() and 'invalid zone values' or e}")
        parsed.append(z)
    have = {z.name for z in session.exec(select(Zone)).all()}
    added = skipped = 0
    for z in parsed:
        if z.name in have:
            skipped += 1
            continue
        session.add(Zone(name=z.name, polygon_json=json.dumps(z.polygon), risk_weight=z.risk_weight, no_entry=z.no_entry))
        have.add(z.name)
        added += 1
    session.commit()
    manager.invalidate()
    return {"added": added, "skipped": skipped}
