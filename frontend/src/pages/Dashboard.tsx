import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CircleMarker, MapContainer, Polygon, Polyline, TileLayer, Tooltip, useMap } from 'react-leaflet'
import { Link } from 'react-router-dom'
import { api, TOKEN_KEY } from '../api'
import { askNotificationPermission, beep, notificationPermission, notify, setSoundEnabled, soundEnabled } from '../alerting'
import AlertPanel, { ago, KIND_TONE, nextAction, type AlertRow, type Staff, type TimelineItem, type TrailPoint } from '../components/AlertPanel'
import AppShell from '../components/AppShell'
import DemoPanel from '../components/DemoPanel'
import HeatLayer from '../components/HeatLayer'
import { useAuth } from '../store'
import { Badge, Button, Card, EmptyState, SelectInput, Skeleton, StatCard, TextInput, useToast } from '../ui'
import type { Zone } from './Zones'

interface Overview {
  positions: { tourist_id: number; id_code: string | null; lat: number; lon: number; open_alerts: number }[]
  clusters: { lat: number; lon: number; count: number }[]
  alert_heat: [number, number, number][]
  zone_heat: [number, number, number][]
  alerts_by_status: Record<string, number>
  active_tourists: number
}
interface Case { name: string; id_code: string; kyc: string; contacts: { name: string; phone: string }[]; itinerary: any }

const PAGE = 30
const STATUS_FILTERS = [['active', 'Active'], ['open', 'Open'], ['acknowledged', 'Acknowledged'], ['dispatched', 'Dispatched'], ['resolved', 'Resolved'], ['all', 'All']] as const
const KINDS = ['panic', 'dropoff', 'inactivity', 'deviation', 'zone_entry', 'zone_warning']
const errText = (e: any, d: string) => (typeof e?.response?.data?.detail === 'string' ? e.response.data.detail : d)

export function wsUrl(token: string) {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${window.location.host}/api/ws/alerts?token=${encodeURIComponent(token)}`
}

function FlyTo({ to }: { to: [number, number] | null }) {
  const map = useMap()
  useEffect(() => { if (to) map.flyTo(to, Math.max(map.getZoom(), 14), { duration: 0.6 }) }, [to?.[0], to?.[1]]) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}

export default function Dashboard() {
  const toast = useToast()
  const me = useAuth((s) => s.user?.id)
  const [data, setData] = useState<{ total: number; items: AlertRow[] } | null>(null)
  const [ov, setOv] = useState<Overview | null>(null)
  const [zones, setZones] = useState<Zone[]>([])
  const [staff, setStaff] = useState<Staff[]>([])
  const [live, setLive] = useState(false)
  const [error, setError] = useState('')

  const [q, setQ] = useState('')
  const [kind, setKind] = useState('')
  const [statusF, setStatusF] = useState<(typeof STATUS_FILTERS)[number][0]>('active')
  const [mineOnly, setMineOnly] = useState(false)
  const [limit, setLimit] = useState(PAGE)

  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [trail, setTrail] = useState<TrailPoint[] | null>(null)
  const [replayIdx, setReplayIdx] = useState(0)
  const [timeline, setTimeline] = useState<TimelineItem[] | null>(null)
  const [kase, setKase] = useState<Case | null>(null)
  const [busy, setBusy] = useState(false)

  const [layers, setLayers] = useState({ zones: true, heat: true, clusters: true, trails: true })
  const [sound, setSound] = useState(soundEnabled)
  const [notif, setNotif] = useState(notificationPermission)

  const params = useMemo(() => ({
    paged: true, limit, q: q || undefined, kind: kind || undefined,
    status: ['open', 'acknowledged', 'dispatched', 'resolved'].includes(statusF) ? statusF : undefined,
    include_resolved: statusF === 'all' ? true : undefined,
  }), [limit, q, kind, statusF])

  // Responses can arrive out of order (an action's refresh overlapping a filter change). Only the newest request may
  // update the screen, otherwise an older, slower answer would silently overwrite fresher data.
  const seq = useRef(0)
  const refresh = useCallback(async () => {
    const mine = ++seq.current
    try {
      const [a, o] = await Promise.all([api.get('/dashboard/alerts', { params }), api.get('/dashboard/overview')])
      if (mine !== seq.current) return
      setData(a.data); setOv(o.data); setError('')
    } catch { if (mine === seq.current) setError('Could not refresh the dashboard.') }
  }, [params])

  useEffect(() => { const t = setTimeout(refresh, q ? 250 : 0); return () => clearTimeout(t) }, [refresh, q])
  useEffect(() => {
    api.get('/zones').then((r) => setZones(r.data)).catch(() => {})
    api.get('/dashboard/staff').then((r) => setStaff(r.data)).catch(() => {})
  }, [])

  const items = useMemo(() => (data?.items ?? []).filter((a) => !mineOnly || a.assigned_to === me), [data, mineOnly, me])
  const selected = items.find((a) => a.id === selectedId) ?? data?.items.find((a) => a.id === selectedId) ?? null

  // ---------- live feed ----------
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  const soundRef = useRef(sound)
  soundRef.current = sound
  useEffect(() => {
    let ws: WebSocket | null = null
    let closed = false
    let retry: ReturnType<typeof setTimeout> | undefined
    const connect = () => {
      ws = new WebSocket(wsUrl(localStorage.getItem(TOKEN_KEY) ?? ''))
      ws.onopen = () => setLive(true)
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data)
        toast(`${String(m.kind).toUpperCase()}: ${m.detail}`, { kind: m.kind === 'panic' && m.status === 'open' ? 'alert' : 'info', ms: m.kind === 'panic' ? 12000 : 6000 })
        if (m.kind === 'panic' && m.status === 'open') {          // only a NEW panic makes noise, not its later updates
          if (soundRef.current) beep()
          notify('PANIC alert', m.detail)
        }
        refreshRef.current()
      }
      ws.onclose = () => { setLive(false); if (!closed) retry = setTimeout(connect, 3000) }
    }
    connect()
    return () => { closed = true; if (retry) clearTimeout(retry); ws?.close() }
  }, [toast])

  // ---------- selected alert: trail + timeline ----------
  useEffect(() => {
    setTrail(null); setReplayIdx(0)
    if (!selected) return
    let cancel = false
    api.get(`/dashboard/trail/${selected.tourist_id}`, { params: { hours: 6 } })
      .then((r) => { if (!cancel) { setTrail(r.data.points); setReplayIdx(Math.max(0, r.data.points.length - 1)) } })
      .catch(() => { if (!cancel) setTrail([]) })
    return () => { cancel = true }
  }, [selected?.id, selected?.tourist_id]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadTimeline = useCallback(async (incident: number | null) => {
    if (!incident) return setTimeline(null)
    try { const { data } = await api.get(`/incidents/${incident}/timeline`); setTimeline(data.items) } catch { setTimeline([]) }
  }, [])
  useEffect(() => { setKase(null); void loadTimeline(selected?.incident_id ?? null) }, [selected?.id, selected?.incident_id, loadTimeline])

  // ---------- actions ----------
  async function act(a: AlertRow, to: string, resolution?: 'resolved' | 'false_alarm') {
    setBusy(true)
    try { await api.patch(`/alerts/${a.id}`, { status: to, ...(resolution ? { resolution } : {}) }); await refresh() }
    catch (e) { toast(errText(e, 'Update failed'), { kind: 'error' }) }
    finally { setBusy(false) }
  }
  async function assign(a: AlertRow, id: number | null) {
    try { await api.patch(`/alerts/${a.id}`, { assignee_id: id }); await refresh() } catch (e) { toast(errText(e, 'Could not assign'), { kind: 'error' }) }
  }
  async function addNote(text: string) {
    if (!selected?.incident_id) return
    try { await api.post(`/incidents/${selected.incident_id}/notes`, { text }); await loadTimeline(selected.incident_id) }
    catch (e) { toast(errText(e, 'Could not save the note'), { kind: 'error' }); throw e }
  }
  async function reveal() {
    if (!selected?.incident_id) return
    try { const { data } = await api.post(`/incidents/${selected.incident_id}/reveal`); setKase(data); await loadTimeline(selected.incident_id) }
    catch (e) { toast(errText(e, 'Could not open personal data'), { kind: 'error' }) }
  }
  async function efir() {
    if (!selected?.incident_id) return
    try {
      const { data } = await api.get(`/incidents/${selected.incident_id}/efir.pdf`, { responseType: 'blob' })
      download(data, `draft-efir-${selected.incident_id}.pdf`)
    } catch { toast('Could not generate the e-FIR draft', { kind: 'error' }) }
  }
  async function exportCsv() {
    try {
      const { data } = await api.get('/dashboard/alerts.csv', { params: { q: q || undefined, kind: kind || undefined, status: params.status, include_resolved: statusF === 'all' ? true : undefined }, responseType: 'blob' })
      download(data, 'alerts.csv')
    } catch { toast('Could not export', { kind: 'error' }) }
  }
  async function bulk(to: 'acknowledged') {
    const ids = [...checked]
    try {
      const { data } = await api.post('/alerts/bulk', { ids, status: to })
      toast(`${data.updated.length} acknowledged${data.skipped.length ? `, ${data.skipped.length} skipped` : ''}`, { kind: data.skipped.length ? 'info' : 'success' })
      setChecked(new Set()); await refresh()
    } catch (e) { toast(errText(e, 'Bulk update failed'), { kind: 'error' }) }
  }

  // ---------- keyboard: J/K move, A acknowledge, D dispatch, R resolve ----------
  const kb = useRef({ items, selected, act })
  kb.current = { items, selected, act }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) return
      const { items: list, selected: sel, act: doAct } = kb.current
      const i = sel ? list.findIndex((x) => x.id === sel.id) : -1
      if (e.key === 'j') setSelectedId(list[Math.min(list.length - 1, i + 1)]?.id ?? null)
      else if (e.key === 'k') setSelectedId(list[Math.max(0, i - 1)]?.id ?? null)
      else if (sel && e.key === 'a' && sel.status === 'open') void doAct(sel, 'acknowledged')
      else if (sel && e.key === 'd' && sel.status === 'acknowledged') void doAct(sel, 'dispatched')
      else if (sel && e.key === 'r' && (sel.status === 'acknowledged' || sel.status === 'dispatched')) void doAct(sel, 'resolved', 'resolved')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const toggleChecked = (id: number) => setChecked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const counts = ov?.alerts_by_status ?? {}
  const heat: [number, number, number][] = ov ? [...ov.alert_heat, ...ov.zone_heat] : []
  const flyTo: [number, number] | null = selected?.lat != null && selected.lon != null ? [selected.lat, selected.lon] : null
  const replayPoint = trail && trail.length ? trail[Math.min(replayIdx, trail.length - 1)] : null
  const openChecked = [...checked].filter((id) => data?.items.find((a) => a.id === id)?.status === 'open').length

  return (
    <AppShell title="Police Dashboard" actions={<span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${live ? 'bg-ok/15 text-ok' : 'bg-sunken text-muted'}`}>{live ? 'Live' : 'Offline'}</span>}>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Active tourists" value={ov?.active_tourists ?? 0} />
        <StatCard label="Open alerts" value={counts.open ?? 0} tone={(counts.open ?? 0) > 0 ? 'danger' : 'ok'} />
        <StatCard label="In progress" value={(counts.acknowledged ?? 0) + (counts.dispatched ?? 0)} tone="warn" />
        <StatCard label="Resolved" value={counts.resolved ?? 0} />
      </div>
      {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}

      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div className="w-full sm:w-52"><TextInput label="Search ID code" value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE) }} /></div>
        <div className="w-40"><SelectInput label="Type" value={kind} onChange={(e) => { setKind(e.target.value); setLimit(PAGE) }}>
          <option value="">All types</option>{KINDS.map((k) => <option key={k} value={k}>{k.replace('_', ' ')}</option>)}
        </SelectInput></div>
        <div className="w-40"><SelectInput label="Status" value={statusF} onChange={(e) => { setStatusF(e.target.value as any); setLimit(PAGE) }}>
          {STATUS_FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </SelectInput></div>
        <label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} /> Assigned to me</label>
        <div className="ml-auto flex flex-wrap items-center gap-2 pb-0.5">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={sound} onChange={(e) => { setSound(e.target.checked); setSoundEnabled(e.target.checked); if (e.target.checked) beep() }} /> Sound on panic</label>
          {notif === 'default' && <Button size="sm" variant="secondary" onClick={async () => setNotif(await askNotificationPermission())}>Enable desktop alerts</Button>}
          {notif === 'granted' && <Badge tone="ok">Desktop alerts on</Badge>}
          <Button size="sm" variant="secondary" onClick={exportCsv}>Export CSV</Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <section aria-label="Alert queue" className="space-y-3 lg:col-span-2">
          {openChecked > 0 && (
            <div className="flex items-center justify-between rounded-lg bg-brand/10 p-2 text-sm">
              <span>{checked.size} selected</span>
              <Button size="sm" onClick={() => bulk('acknowledged')}>Acknowledge {openChecked} open</Button>
            </div>
          )}
          {!data ? <Skeleton className="h-40" /> : items.length === 0 ? (
            <EmptyState title="No alerts" hint="New alerts appear here instantly. Use the demo panel below to simulate some." />
          ) : (
            <ul className="space-y-2" aria-label="Alerts">
              {items.map((a) => (
                <li key={a.id} data-testid={`alert-${a.id}`} aria-current={a.id === selectedId ? 'true' : undefined}
                    className={`rounded-lg border p-3 text-sm ${a.id === selectedId ? 'border-brand bg-brand/5' : 'border-line bg-surface'}`}>
                  <div className="flex items-center gap-2">
                    {a.status === 'open' && <input type="checkbox" aria-label={`Select alert ${a.id}`} checked={checked.has(a.id)} onChange={() => toggleChecked(a.id)} />}
                    <Badge tone={KIND_TONE[a.kind] ?? 'neutral'}>{a.kind.replace('_', ' ')}</Badge>
                    <span className="font-mono text-xs">{a.id_code}</span>
                    <span className="ml-auto text-xs text-muted">{ago(a.created_at)}</span>
                  </div>
                  <button className="mt-1 block w-full text-left" onClick={() => setSelectedId(a.id)} aria-label={`Open alert ${a.id}: ${a.detail}`}>{a.detail}</button>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted">
                    <span>{a.status}{a.resolution ? ` · ${a.resolution.replace('_', ' ')}` : ''}</span>
                    {a.score != null && <span>Priority {(a.score * 100).toFixed(0)}%</span>}
                    {a.assignee && <Badge tone="brand">{a.assignee}</Badge>}
                    {nextAction(a.status) && a.id !== selectedId && (
                      <Button size="sm" className="ml-auto" onClick={() => act(a, nextAction(a.status)!.to)}>{nextAction(a.status)!.label}</Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {data && data.total > data.items.length && (
            <Button variant="secondary" size="sm" onClick={() => setLimit(limit + PAGE)}>Show more ({data.items.length} of {data.total})</Button>
          )}
          <p className="text-xs text-muted">Keyboard: J / K move, A acknowledge, D dispatch, R resolve.</p>
        </section>

        <section aria-label="Map and details" className="space-y-3 lg:col-span-3">
          <div className="flex flex-wrap gap-3 text-xs" role="group" aria-label="Map layers">
            {(Object.keys(layers) as (keyof typeof layers)[]).map((k) => (
              <label key={k} className="flex items-center gap-1 capitalize"><input type="checkbox" checked={layers[k]} onChange={(e) => setLayers({ ...layers, [k]: e.target.checked })} /> {k}</label>
            ))}
          </div>
          <div className="h-80 overflow-hidden rounded-xl border border-line">
            <MapContainer center={[25.5788, 91.8933]} zoom={12} className="h-full w-full">
              <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="© OpenStreetMap" />
              <FlyTo to={flyTo} />
              {layers.zones && zones.map((z) => <Polygon key={z.id} positions={z.polygon} pathOptions={{ color: z.no_entry ? '#7f1d1d' : '#dc2626', weight: 1 }} />)}
              {layers.heat && <HeatLayer points={heat} />}
              {layers.clusters && ov?.clusters.filter((c) => c.count > 1).map((c, i) => (
                <CircleMarker key={`c${i}`} center={[c.lat, c.lon]} radius={10 + c.count * 2} pathOptions={{ color: '#0f766e', fillOpacity: 0.3 }}><Tooltip>{c.count} tourists</Tooltip></CircleMarker>
              ))}
              {ov?.positions.map((p) => (
                <CircleMarker key={p.tourist_id} center={[p.lat, p.lon]} radius={p.tourist_id === selected?.tourist_id ? 9 : 6}
                              pathOptions={{ color: p.open_alerts ? '#dc2626' : '#2563eb', fillOpacity: 0.9 }}><Tooltip>{p.id_code} · {p.open_alerts} open alert(s)</Tooltip></CircleMarker>
              ))}
              {layers.trails && trail && trail.length > 1 && <Polyline positions={trail.map((t) => [t.lat, t.lon] as [number, number])} pathOptions={{ color: '#0ea5e9', weight: 4 }} />}
              {layers.trails && replayPoint && <CircleMarker center={[replayPoint.lat, replayPoint.lon]} radius={8} pathOptions={{ color: '#f59e0b', fillOpacity: 1 }}><Tooltip permanent>{new Date(replayPoint.ts).toLocaleTimeString()}</Tooltip></CircleMarker>}
            </MapContainer>
          </div>

          {selected ? (
            <AlertPanel alert={selected} staff={staff} me={me} trail={trail} replayIdx={replayIdx} onReplay={setReplayIdx} timeline={timeline} busy={busy}
                        onAction={(to, res) => act(selected, to, res)} onAssign={(id) => assign(selected, id)} onNote={addNote}
                        onReveal={reveal} onEfir={efir} onClose={() => setSelectedId(null)} />
          ) : <p className="rounded-lg bg-sunken p-3 text-sm text-muted">Select an alert to see its track, timeline and actions.</p>}

          {kase && (
            <Card className="border-2 border-danger/50 p-3 text-sm" aria-label="case details">
              <h2 className="font-semibold">Case details (access is logged)</h2>
              <p>Name: {kase.name}</p>
              <p>ID document: {kase.kyc}</p>
              <p>Contacts: {kase.contacts.map((c) => `${c.name} ${c.phone}`).join(', ')}</p>
              <p>Planned stops: {(kase.itinerary?.stops ?? []).map((s: any) => s.name).join(', ') || '-'}</p>
            </Card>
          )}
          <DemoPanel onDone={refresh} />
          <p className="text-xs text-muted"><Link className="text-brand-ink underline" to="/analytics">Analytics</Link> · <Link className="text-brand-ink underline" to="/zones">Manage risk zones</Link></p>
        </section>
      </div>
    </AppShell>
  )
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = name; a.click()
  URL.revokeObjectURL(url)
}
