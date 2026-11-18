import { useEffect, useState } from 'react'
import { CircleMarker, MapContainer, TileLayer } from 'react-leaflet'
import { useParams } from 'react-router-dom'
import { api } from '../api'

/** Public family live view (opt-in by the tourist). */
export default function Family() {
  const { token } = useParams()
  const [d, setD] = useState<{ name: string; lat: number | null; lon: number | null; updated: string | null } | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    const load = () => api.get(`/share/${token}`).then((r) => { setD(r.data); setErr('') })
      .catch(() => setErr('This link is not active. The traveller may have stopped sharing.'))
    load()
    const i = setInterval(load, 15000)
    return () => clearInterval(i)
  }, [token])

  if (err) return <p role="alert" className="p-6">{err}</p>
  if (!d) return <p className="p-6">Loading…</p>
  return (
    <div className="mx-auto max-w-xl space-y-3 p-6">
      <h1 className="text-2xl font-bold">{d.name}'s live location</h1>
      {d.lat == null || d.lon == null ? <p>No location received yet.</p> : (
        <>
          <p className="text-sm text-muted">Updated {d.updated ? new Date(d.updated).toLocaleTimeString() : ''}</p>
          <div className="h-80 overflow-hidden rounded-lg shadow">
            <MapContainer center={[d.lat, d.lon]} zoom={15} className="h-full w-full">
              <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="© OpenStreetMap" />
              <CircleMarker center={[d.lat, d.lon]} radius={9} pathOptions={{ color: '#dc2626' }} />
            </MapContainer>
          </div>
        </>
      )}
    </div>
  )
}
