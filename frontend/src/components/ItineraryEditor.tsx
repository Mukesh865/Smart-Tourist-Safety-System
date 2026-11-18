import { useState } from 'react'
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip, useMapEvents } from 'react-leaflet'
import { Button, Tabs } from '../ui'

export interface Stop { name: string; lat: number; lon: number; hotel: boolean }
export interface Itinerary { route: [number, number][]; stops: Stop[] }

export const DEFAULT_CENTER: [number, number] = [25.5788, 91.8933]   // Shillong, as in the paper's prototype

function Clicker({ onPoint }: { onPoint: (p: [number, number]) => void }) {
  useMapEvents({ click: (e) => onPoint([+e.latlng.lat.toFixed(6), +e.latlng.lng.toFixed(6)]) })
  return null
}

/** Click the map to add planned stops or route points. The first stop is the hotel (distance to it is the
 *  "home" reference used by the detection rules). Pure controlled component: parent owns the value. */
export default function ItineraryEditor({ value, onChange, height = 'h-72' }: { value: Itinerary; onChange: (v: Itinerary) => void; height?: string }) {
  const [mode, setMode] = useState<'stop' | 'route'>('stop')

  function addPoint(p: [number, number]) {
    if (mode === 'route') return onChange({ ...value, route: [...value.route, p] })
    const n = value.stops.length
    onChange({ ...value, stops: [...value.stops, { name: n === 0 ? 'Hotel' : `Stop ${n}`, lat: p[0], lon: p[1], hotel: n === 0 }] })
  }
  const setStop = (i: number, patch: Partial<Stop>) => onChange({ ...value, stops: value.stops.map((s, k) => (k === i ? { ...s, ...patch } : s)) })
  const makeHotel = (i: number) => onChange({ ...value, stops: value.stops.map((s, k) => ({ ...s, hotel: k === i })) })
  const removeStop = (i: number) => {
    const stops = value.stops.filter((_, k) => k !== i)
    if (stops.length && !stops.some((s) => s.hotel)) stops[0] = { ...stops[0], hotel: true }
    onChange({ ...value, stops })
  }
  const first = value.stops[0]
  const center: [number, number] = first ? [first.lat, first.lon] : DEFAULT_CENTER

  return (
    <div className="space-y-3">
      <Tabs label="Map click action" value={mode} onChange={setMode} tabs={[{ id: 'stop', label: 'Add stops' }, { id: 'route', label: 'Draw route' }]} />
      <div className={`${height} overflow-hidden rounded-xl border border-line`}>
        <MapContainer center={center} zoom={13} className="h-full w-full">
          <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="© OpenStreetMap" />
          <Clicker onPoint={addPoint} />
          {value.route.length > 1 && <Polyline positions={value.route} pathOptions={{ color: '#2563eb', dashArray: '6' }} />}
          {value.route.map((p, i) => <CircleMarker key={`r${i}`} center={p} radius={3} pathOptions={{ color: '#2563eb' }} />)}
          {value.stops.map((s, i) => (
            <CircleMarker key={`s${i}`} center={[s.lat, s.lon]} radius={s.hotel ? 9 : 7} pathOptions={{ color: s.hotel ? '#0f766e' : '#d97706', fillOpacity: 0.8 }}>
              <Tooltip>{s.name}{s.hotel ? ' (hotel)' : ''}</Tooltip>
            </CircleMarker>
          ))}
        </MapContainer>
      </div>
      <p className="text-xs text-muted">
        {mode === 'stop' ? 'Click the map to add a planned stop. The first stop is the hotel.' : 'Click the map to add points along the planned route.'}
      </p>

      <ul className="space-y-2" aria-label="Planned stops">
        {value.stops.map((s, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-2 text-sm">
            <input aria-label={`Stop ${i + 1} name`} className="input max-w-[11rem] flex-1" value={s.name} onChange={(e) => setStop(i, { name: e.target.value })} />
            <span className="text-xs text-muted">{s.lat.toFixed(4)}, {s.lon.toFixed(4)}</span>
            <label className="ml-auto flex items-center gap-1 text-xs"><input type="radio" name="hotel" checked={s.hotel} onChange={() => makeHotel(i)} /> Hotel</label>
            <Button size="sm" variant="ghost" aria-label={`Remove stop ${i + 1}`} onClick={() => removeStop(i)}>Remove</Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>{value.route.length} route point(s)</span>
        <Button size="sm" variant="secondary" disabled={value.stops.length < 2} onClick={() => onChange({ ...value, route: value.stops.map((s) => [s.lat, s.lon] as [number, number]) })}>Use stops as route</Button>
        <Button size="sm" variant="secondary" disabled={!value.route.length} onClick={() => onChange({ ...value, route: [] })}>Clear route</Button>
      </div>
    </div>
  )
}
