import { useEffect, useState } from 'react'
import { CircleMarker, MapContainer, Polygon, Polyline, TileLayer, useMap } from 'react-leaflet'
import AppShell from '../../components/AppShell'
import { DEFAULT_CENTER } from '../../components/ItineraryEditor'
import { fmtDistance, zoneStatus } from '../../geo'
import { useT } from '../../i18n'
import { Button } from '../../ui'
import { OfflineBanner } from './parts'
import { useTourist } from './TouristContext'

/** Re-centres the map on the user whenever `nonce` changes (the "Centre on me" button). */
function Recenter({ center, nonce }: { center: [number, number] | null; nonce: number }) {
  const map = useMap()
  useEffect(() => { if (center && nonce > 0) map.setView(center, Math.max(map.getZoom(), 14)) }, [nonce]) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}

export default function TouristMap() {
  const t = useT()
  const { pos, zones, trail, trip } = useTourist()
  const [nonce, setNonce] = useState(0)
  const me: [number, number] | null = pos ? [pos.lat, pos.lon] : null
  const zs = me ? zoneStatus(me, zones) : null

  return (
    <AppShell title={t('tabMap')}>
      <div className="space-y-3">
        <OfflineBanner />
        {zs && (
          <p role="status" className={`rounded-lg p-3 text-sm font-medium ${zs.inside ? 'bg-danger/15 text-danger' : 'bg-warn/15 text-warn'}`}>
            {zs.inside ? t('zoneInside', { zone: zs.zone.name }) : t('zoneNear', { zone: zs.zone.name, dist: fmtDistance(zs.distance) })}
          </p>
        )}
        <div className="h-[calc(100vh-17rem)] min-h-[20rem] overflow-hidden rounded-xl border border-line">
          <MapContainer center={me ?? DEFAULT_CENTER} zoom={14} className="h-full w-full">
            <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="© OpenStreetMap" />
            <Recenter center={me} nonce={nonce} />
            {zones.map((z) => <Polygon key={z.id} positions={z.polygon} pathOptions={{ color: z.no_entry ? '#7f1d1d' : '#dc2626', weight: 2, fillOpacity: 0.15 }} />)}
            {trip && trip.route.length > 1 && <Polyline positions={trip.route} pathOptions={{ color: '#2563eb', dashArray: '6' }} />}
            {trip?.stops.map((s, i) => <CircleMarker key={i} center={[s.lat, s.lon]} radius={6} pathOptions={{ color: s.hotel ? '#0f766e' : '#d97706' }} />)}
            {trail.length > 1 && <Polyline positions={trail} pathOptions={{ color: '#0ea5e9', weight: 4 }} />}
            {me && <CircleMarker center={me} radius={9} pathOptions={{ color: '#2563eb', fillOpacity: 0.9 }} />}
          </MapContainer>
        </div>
        <div className="flex items-center justify-between text-xs text-muted">
          <span>{t('trail')}: {trail.length}</span>
          <Button size="sm" variant="secondary" onClick={() => setNonce((n) => n + 1)} disabled={!me}>{t('recenter')}</Button>
        </div>
      </div>
    </AppShell>
  )
}
