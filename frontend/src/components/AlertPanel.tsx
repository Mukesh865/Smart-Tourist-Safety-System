import { useState, type FormEvent } from 'react'
import { Badge, Button, Card, SelectInput, Skeleton, TextInput, type Tone } from '../ui'

export interface AlertRow {
  id: number; tourist_id: number; id_code: string | null; kind: string; rule: string | null; detail: string
  lat: number | null; lon: number | null; status: string; score: number | null; incident_id: number | null
  resolution?: string | null; assigned_to?: number | null; assignee?: string | null; created_at: string
}
export interface TimelineItem { kind: 'alert' | 'note' | 'action'; ts: string; text: string; by: string | null }
export interface Staff { id: number; name: string }
export interface TrailPoint { lat: number; lon: number; ts: string }

export const KIND_TONE: Record<string, Tone> = { panic: 'danger', dropoff: 'warn', inactivity: 'warn', deviation: 'warn', zone_entry: 'brand', zone_warning: 'brand' }
const NEXT: Record<string, { to: string; label: string } | undefined> = {
  open: { to: 'acknowledged', label: 'Acknowledge' },
  acknowledged: { to: 'dispatched', label: 'Dispatch' },
  dispatched: { to: 'resolved', label: 'Resolve' },
}
export const nextAction = (status: string) => NEXT[status]

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso.endsWith('Z') || iso.includes('+') ? iso : `${iso}Z`).getTime()) / 1000)
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`
}
export { ago }

interface Props {
  alert: AlertRow
  staff: Staff[]
  me: number | undefined
  trail: TrailPoint[] | null
  replayIdx: number
  onReplay: (i: number) => void
  timeline: TimelineItem[] | null
  onAction: (to: string, resolution?: 'resolved' | 'false_alarm') => void
  onAssign: (id: number | null) => void
  onNote: (text: string) => Promise<void>
  onReveal: () => void
  onEfir: () => void
  onClose: () => void
  busy?: boolean
}

/** Detail panel for one alert: workflow, assignment, trail replay, notes + timeline, personal data (active incident only). */
export default function AlertPanel(p: Props) {
  const { alert: a } = p
  const [resolution, setResolution] = useState<'resolved' | 'false_alarm'>('resolved')
  const [note, setNote] = useState('')
  const [noting, setNoting] = useState(false)
  const next = nextAction(a.status)
  const point = p.trail && p.trail.length ? p.trail[Math.min(p.replayIdx, p.trail.length - 1)] : null

  async function addNote(e: FormEvent) {
    e.preventDefault()
    if (!note.trim()) return
    setNoting(true)
    try { await p.onNote(note.trim()); setNote('') } finally { setNoting(false) }
  }

  return (
    <Card className="space-y-4 p-4" aria-label="Alert details" role="region">
      <div className="flex items-start justify-between gap-2">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={KIND_TONE[a.kind] ?? 'neutral'}>{a.kind.replace('_', ' ')}</Badge>
            <span className="font-mono text-sm">{a.id_code}</span>
            <Badge>{a.status}{a.resolution ? ` · ${a.resolution.replace('_', ' ')}` : ''}</Badge>
          </div>
          <p className="text-sm">{a.detail}</p>
          <p className="text-xs text-muted">{ago(a.created_at)}{a.score != null ? ` · priority ${(a.score * 100).toFixed(0)}%` : ''}{a.rule ? ` · rule ${a.rule}` : ''}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={p.onClose} aria-label="Close details">Close</Button>
      </div>

      {a.status !== 'resolved' && (
        <div className="flex flex-wrap items-end gap-2">
          {next && next.to === 'resolved' && (
            <div className="w-44">
              <SelectInput label="Outcome" value={resolution} onChange={(e) => setResolution(e.target.value as any)}>
                <option value="resolved">Genuine, handled</option>
                <option value="false_alarm">False alarm</option>
              </SelectInput>
            </div>
          )}
          {next && <Button loading={p.busy} onClick={() => p.onAction(next.to, next.to === 'resolved' ? resolution : undefined)}>{next.label}</Button>}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <div className="w-52">
          <SelectInput label="Assigned to" value={a.assigned_to ?? ''} onChange={(e) => p.onAssign(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Nobody</option>
            {p.staff.map((s) => <option key={s.id} value={s.id}>{s.name}{s.id === p.me ? ' (me)' : ''}</option>)}
          </SelectInput>
        </div>
        {p.me && a.assigned_to !== p.me && <Button variant="secondary" size="sm" onClick={() => p.onAssign(p.me!)}>Assign to me</Button>}
      </div>

      <section aria-label="Trail replay" className="space-y-2">
        <h2 className="text-sm font-semibold">Last 6 hours</h2>
        {p.trail === null ? <Skeleton className="h-8" /> : p.trail.length < 2 ? <p className="text-sm text-muted">No track recorded in this period.</p> : (
          <>
            <input type="range" className="w-full" min={0} max={p.trail.length - 1} value={Math.min(p.replayIdx, p.trail.length - 1)}
                   onChange={(e) => p.onReplay(Number(e.target.value))} aria-label="Replay position" />
            <p className="text-xs text-muted">{point ? new Date(point.ts).toLocaleTimeString() : ''} · {p.trail.length} fixes · drag to replay</p>
          </>
        )}
      </section>

      {a.incident_id && (
        <section aria-label="Case" className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={p.onReveal}>Open personal details</Button>
            <Button variant="secondary" size="sm" onClick={p.onEfir}>Draft e-FIR (PDF)</Button>
          </div>
          <h2 className="text-sm font-semibold">Timeline</h2>
          {p.timeline === null ? <Skeleton className="h-16" /> : (
            <ol className="space-y-2 border-l border-line pl-3 text-sm" aria-label="Incident timeline">
              {p.timeline.map((t, i) => (
                <li key={i}>
                  <p className={t.kind === 'note' ? 'rounded bg-sunken p-2' : ''}>{t.text}</p>
                  <p className="text-xs text-muted">{new Date(t.ts).toLocaleTimeString()}{t.by ? ` · ${t.by}` : ''}</p>
                </li>
              ))}
            </ol>
          )}
          <form onSubmit={addNote} className="flex items-end gap-2">
            <div className="flex-1"><TextInput label="Add a note" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} /></div>
            <Button type="submit" size="sm" loading={noting} disabled={!note.trim()}>Add note</Button>
          </form>
        </section>
      )}
    </Card>
  )
}
