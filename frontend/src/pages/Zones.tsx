import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { MapContainer, Polygon, Polyline, CircleMarker, TileLayer, useMapEvents } from 'react-leaflet'
import { api } from '../api'
import { ConfirmDialog } from '../ui'
import Layout from '../components/Layout'

export interface Zone {
  id: number
  name: string
  polygon: [number, number][]
  risk_weight: number
  no_entry: boolean
}

const CENTER: [number, number] = [25.5788, 91.8933] // Shillong, as in the paper's prototype

function Clicker({ onPoint }: { onPoint: (p: [number, number]) => void }) {
  useMapEvents({ click: (e) => onPoint([e.latlng.lat, e.latlng.lng]) })
  return null
}

const PRESETS: [string, number][] = [['Low', 0.3], ['Medium', 0.5], ['High', 0.8], ['Critical', 1]]
const color = (z: Zone) => (z.no_entry ? '#7f1d1d' : z.risk_weight >= 0.7 ? '#dc2626' : z.risk_weight >= 0.4 ? '#f59e0b' : '#16a34a')

export default function Zones() {
  const [zones, setZones] = useState<Zone[]>([])
  const [draft, setDraft] = useState<[number, number][]>([])
  const [name, setName] = useState('')
  const [risk, setRisk] = useState(0.5)
  const [noEntry, setNoEntry] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Zone | null>(null)
  const [toDelete, setToDelete] = useState<Zone | null>(null)
  const [note, setNote] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(() => api.get('/zones').then((r) => setZones(r.data)), [])
  useEffect(() => { load() }, [load])

  async function save(e: FormEvent) {
    e.preventDefault()
    setError('')
    try {
      const body = { name, polygon: draft, risk_weight: risk, no_entry: noEntry }
      if (editing) await api.put(`/zones/${editing.id}`, body)
      else await api.post('/zones', body)
      resetForm()
      await load()
    } catch (err: any) {
      setError(err?.response?.data?.detail ? 'Could not save zone. Check the fields.' : 'Network error.')
    }
  }

  function resetForm() { setDraft([]); setName(''); setRisk(0.5); setNoEntry(false); setEditing(null) }
  const copyPoly = (z: Zone) => z.polygon.map((p) => [...p] as [number, number])
  function edit(z: Zone) { setEditing(z); setName(z.name); setRisk(z.risk_weight); setNoEntry(z.no_entry); setDraft(copyPoly(z)); setError('') }
  function duplicate(z: Zone) { setEditing(null); setName(`${z.name} copy`); setRisk(z.risk_weight); setNoEntry(z.no_entry); setDraft(copyPoly(z)); setError('') }

  async function remove(z: Zone) {
    setToDelete(null)
    await api.delete(`/zones/${z.id}`)
    if (editing?.id === z.id) resetForm()
    await load()
  }

  async function exportGeo() {
    const { data } = await api.get('/zones/geojson')
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/geo+json' }))
    const a = document.createElement('a'); a.href = url; a.download = 'risk-zones.geojson'; a.click(); URL.revokeObjectURL(url)
  }
  async function importGeo(file: File | undefined) {
    if (!file) return
    setNote('')
    try {
      const { data } = await api.post('/zones/import', JSON.parse(await file.text()))
      setNote(`Imported ${data.added} zone(s), skipped ${data.skipped} with an existing name.`)
      await load()
    } catch (e: any) {
      setNote(typeof e?.response?.data?.detail === 'string' ? `Import failed: ${e.response.data.detail}` : 'Import failed: the file is not valid GeoJSON.')
    } finally { if (fileRef.current) fileRef.current.value = '' }
  }

  return (
    <Layout title="Risk Zones">
      <div className="grid gap-4 md:grid-cols-3">
        <div className="md:col-span-2 h-[28rem] overflow-hidden rounded-lg shadow">
          <MapContainer center={CENTER} zoom={13} className="h-full w-full">
            <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="© OpenStreetMap" />
            <Clicker onPoint={(p) => setDraft((d) => [...d, p])} />
            {zones.map((z) => (
              <Polygon key={z.id} positions={z.polygon} pathOptions={{ color: color(z), dashArray: z.no_entry ? '6' : undefined }} />
            ))}
            {draft.length > 1 && <Polyline positions={draft} pathOptions={{ color: '#2563eb' }} />}
            {draft.map((p, i) => <CircleMarker key={i} center={p} radius={4} pathOptions={{ color: '#2563eb' }} />)}
          </MapContainer>
        </div>
        <div className="space-y-4">
          <form onSubmit={save} className="space-y-3 rounded-lg bg-surface p-4 shadow">
            <h2 className="font-semibold">{editing ? `Edit zone: ${editing.name}` : 'New zone'}</h2>
            <p className="text-xs text-muted">Click the map to add corners ({draft.length} so far, minimum 3).</p>
            <label className="block text-sm">Name<input className="input" required value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label className="block text-sm">Risk weight: {risk.toFixed(1)}
              <input type="range" min={0} max={1} step={0.1} value={risk} onChange={(e) => setRisk(+e.target.value)} className="w-full" />
            </label>
            <div className="flex flex-wrap gap-1" role="group" aria-label="Risk presets">
              {PRESETS.map(([l, v]) => <button key={l} type="button" className="rounded-full border px-2 py-0.5 text-xs hover:bg-sunken" onClick={() => setRisk(v)}>{l}</button>)}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={noEntry} onChange={(e) => setNoEntry(e.target.checked)} />
              No-entry zone (adds a warning ring)
            </label>
            {error && <p role="alert" className="text-sm text-danger">{error}</p>}
            <div className="flex gap-2">
              <button className="btn" disabled={draft.length < 3 || !name}>{editing ? 'Update zone' : 'Save zone'}</button>
              <button type="button" className="rounded-md border px-3 py-2" onClick={() => (editing ? resetForm() : setDraft([]))}>{editing ? 'Cancel edit' : 'Clear'}</button>
              {draft.length > 0 && <button type="button" className="rounded-md border px-3 py-2" onClick={() => setDraft((d) => d.slice(0, -1))}>Undo corner</button>}
            </div>
          </form>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="rounded-md border px-3 py-1.5 text-sm" onClick={exportGeo} disabled={zones.length === 0}>Export GeoJSON</button>
            <button type="button" className="rounded-md border px-3 py-1.5 text-sm" onClick={() => fileRef.current?.click()}>Import GeoJSON</button>
            <input ref={fileRef} type="file" accept=".geojson,.json,application/geo+json,application/json" className="hidden" aria-label="GeoJSON file" onChange={(e) => importGeo(e.target.files?.[0])} />
          </div>
          {note && <p role="status" className="text-sm">{note}</p>}
          <ul className="space-y-2">
            {zones.map((z) => (
              <li key={z.id} className="flex items-center justify-between rounded-md bg-surface p-2 shadow">
                <span className="text-sm"><b>{z.name}</b> · risk {z.risk_weight.toFixed(1)}{z.no_entry && ' · no-entry'}</span>
                <span className="space-x-2 whitespace-nowrap text-sm">
                  <button aria-label={`Edit ${z.name}`} className="underline" onClick={() => edit(z)}>Edit</button>
                  <button aria-label={`Duplicate ${z.name}`} className="underline" onClick={() => duplicate(z)}>Duplicate</button>
                  <button aria-label={`Delete ${z.name}`} className="text-danger underline" onClick={() => setToDelete(z)}>Delete</button>
                </span>
              </li>
            ))}
            {zones.length === 0 && <li className="text-sm text-muted">No zones yet.</li>}
          </ul>
        </div>
      </div>
      <ConfirmDialog open={!!toDelete} danger title={`Delete ${toDelete?.name ?? ''}?`} confirmLabel="Delete"
        message="Tourists will no longer be warned about this area. This cannot be undone." onConfirm={() => toDelete && remove(toDelete)} onCancel={() => setToDelete(null)} />
    </Layout>
  )
}
