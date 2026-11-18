import { useEffect, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { api } from '../api'
import AppShell from '../components/AppShell'
import { Badge, Button, Card, EmptyState, Skeleton, StatCard, Tabs, useToast } from '../ui'

interface Summary {
  days: number; total_alerts: number
  per_day: { date: string; panic: number; movement: number; zone: number }[]
  response: { median_ack_s: number | null; median_resolve_s: number | null; n_ack: number; n_resolved: number }
  rules: { kind: string; total: number; open: number; genuine: number; false_alarm: number; cancelled: number; judged: number; false_alarm_ratio: number | null }[]
  zones: { zone_id: number; name: string; count: number }[]
  active_tourists: { date: string; count: number }[]
}

// Categorical slots 1-3 of the validated palette (see index.css); identity is never colour-only: legend + table view.
const SERIES = [
  { key: 'movement', label: 'Movement alerts', color: 'rgb(var(--series-1))' },
  { key: 'panic', label: 'Panic alerts', color: 'rgb(var(--series-2))' },
  { key: 'zone', label: 'Zone alerts', color: 'rgb(var(--series-3))' },
] as const

export const fmtDuration = (s: number | null) => {
  if (s == null) return '-'
  if (s < 60) return `${Math.round(s)} s`
  if (s < 3600) return `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, '0')} s`
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`
}
const shortDate = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
const AXIS = { fill: 'rgb(var(--muted))', fontSize: 12 }
const TIP = { background: 'rgb(var(--surface))', border: '1px solid rgb(var(--line))', borderRadius: 8, color: 'rgb(var(--ink))' }
const SIZE = { width: 640, height: 280 }   // initial size; ResponsiveContainer takes over in the browser

function ChartCard({ title, table, children, hint }: { title: string; table: React.ReactNode; children: React.ReactNode; hint?: string }) {
  const [asTable, setAsTable] = useState(false)
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div><h2 className="font-semibold">{title}</h2>{hint && <p className="text-xs text-muted">{hint}</p>}</div>
        <Button size="sm" variant="ghost" aria-pressed={asTable} onClick={() => setAsTable((v) => !v)}>{asTable ? 'View as chart' : 'View as table'}</Button>
      </div>
      {asTable ? <div className="max-h-72 overflow-auto">{table}</div> : <div role="img" aria-label={`${title} chart. Use "View as table" for the numbers.`}>{children}</div>}
    </Card>
  )
}

export default function Analytics() {
  const toast = useToast()
  const [days, setDays] = useState<'7' | '14' | '30'>('14')
  const [d, setD] = useState<Summary | null>(null)

  useEffect(() => {
    setD(null)
    api.get('/analytics/summary', { params: { days: Number(days) } }).then((r) => setD(r.data))
      .catch(() => toast('Could not load analytics', { kind: 'error' }))
  }, [days, toast])

  const judged = d?.rules.reduce((n, r) => n + r.judged, 0) ?? 0
  const falseAlarms = d?.rules.reduce((n, r) => n + r.false_alarm, 0) ?? 0

  return (
    <AppShell title="Analytics" actions={<Tabs label="Time range" value={days} onChange={setDays} tabs={[{ id: '7', label: '7 days' }, { id: '14', label: '14 days' }, { id: '30', label: '30 days' }]} />}>
      {!d ? <Skeleton className="h-64" /> : d.total_alerts === 0 && d.active_tourists.every((x) => x.count === 0) ? (
        <EmptyState title="No data in this period" hint="Alerts and tourist activity appear here as the system is used. Seed the demo data from the dashboard to see examples." />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Alerts" value={d.total_alerts} hint={`last ${d.days} days`} />
            <StatCard label="Median time to acknowledge" value={fmtDuration(d.response.median_ack_s)} hint={`${d.response.n_ack} alerts`} />
            <StatCard label="Median time to resolve" value={fmtDuration(d.response.median_resolve_s)} hint={`${d.response.n_resolved} alerts`} />
            <StatCard label="False-alarm rate" value={judged ? `${Math.round((falseAlarms / judged) * 100)}%` : '-'} hint={judged ? `${falseAlarms} of ${judged} judged` : 'resolve alerts as genuine / false alarm'} />
          </div>

          <ChartCard title="Alerts per day" hint="Stacked by type"
            table={<table className="w-full text-sm"><thead><tr className="text-left text-xs uppercase text-muted"><th className="py-1">Date</th>{SERIES.map((s) => <th key={s.key}>{s.label}</th>)}</tr></thead>
              <tbody>{d.per_day.map((r) => <tr key={r.date} className="border-t border-line"><td className="py-1">{shortDate(r.date)}</td>{SERIES.map((s) => <td key={s.key}>{r[s.key]}</td>)}</tr>)}</tbody></table>}>
            <ResponsiveContainer width="100%" height={280} initialDimension={SIZE}>
              <BarChart data={d.per_day} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                <CartesianGrid stroke="rgb(var(--line))" vertical={false} />
                <XAxis dataKey="date" tickFormatter={shortDate} tick={AXIS} tickLine={false} axisLine={{ stroke: 'rgb(var(--line))' }} interval="preserveStartEnd" />
                <YAxis allowDecimals={false} tick={AXIS} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={TIP} labelFormatter={(l) => shortDate(String(l))} cursor={{ fill: 'rgb(var(--sunken))' }} />
                <Legend verticalAlign="top" height={28} />
                {SERIES.map((s, i) => (
                  <Bar key={s.key} dataKey={s.key} name={s.label} stackId="a" fill={s.color} stroke="rgb(var(--surface))" strokeWidth={2}
                       radius={i === SERIES.length - 1 ? [4, 4, 0, 0] : 0} isAnimationActive={false} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard title="Active tourists per day" hint="Visitors who reported a location"
              table={<table className="w-full text-sm"><thead><tr className="text-left text-xs uppercase text-muted"><th className="py-1">Date</th><th>Tourists</th></tr></thead>
                <tbody>{d.active_tourists.map((r) => <tr key={r.date} className="border-t border-line"><td className="py-1">{shortDate(r.date)}</td><td>{r.count}</td></tr>)}</tbody></table>}>
              <ResponsiveContainer width="100%" height={220} initialDimension={{ width: 480, height: 220 }}>
                <LineChart data={d.active_tourists} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                  <CartesianGrid stroke="rgb(var(--line))" vertical={false} />
                  <XAxis dataKey="date" tickFormatter={shortDate} tick={AXIS} tickLine={false} axisLine={{ stroke: 'rgb(var(--line))' }} interval="preserveStartEnd" />
                  <YAxis allowDecimals={false} tick={AXIS} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={TIP} labelFormatter={(l) => shortDate(String(l))} />
                  <Line type="monotone" dataKey="count" name="Active tourists" stroke="rgb(var(--series-1))" strokeWidth={2} dot={{ r: 4, stroke: 'rgb(var(--surface))', strokeWidth: 2 }} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Busiest risk zones" hint="Zone entries in the period"
              table={d.zones.length ? <table className="w-full text-sm"><thead><tr className="text-left text-xs uppercase text-muted"><th className="py-1">Zone</th><th>Entries</th></tr></thead>
                <tbody>{d.zones.map((z) => <tr key={z.zone_id} className="border-t border-line"><td className="py-1">{z.name}</td><td>{z.count}</td></tr>)}</tbody></table> : <p className="text-sm text-muted">No zone entries.</p>}>
              {d.zones.length === 0 ? <p className="py-10 text-center text-sm text-muted">No zone entries in this period.</p> : (
                <ResponsiveContainer width="100%" height={Math.max(160, d.zones.length * 36)} initialDimension={{ width: 480, height: 220 }}>
                  <BarChart data={d.zones} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
                    <CartesianGrid stroke="rgb(var(--line))" horizontal={false} />
                    <XAxis type="number" allowDecimals={false} tick={AXIS} tickLine={false} axisLine={false} />
                    <YAxis type="category" dataKey="name" width={110} tick={AXIS} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={TIP} cursor={{ fill: 'rgb(var(--sunken))' }} />
                    <Bar dataKey="count" name="Entries" fill="rgb(var(--series-3))" radius={[0, 4, 4, 0]} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </ChartCard>
          </div>

          <Card className="overflow-x-auto p-4" tabIndex={0} role="region" aria-label="Detector accuracy table">
            <h2 className="font-semibold">Detector accuracy in the field</h2>
            <p className="mb-3 text-xs text-muted">From how alerts were closed. A high false-alarm share means that rule's threshold should be loosened for this district (see the paper's recommendation).</p>
            {d.rules.length === 0 ? <p className="text-sm text-muted">No alerts yet.</p> : (
              <table className="w-full min-w-[560px] text-sm">
                <thead><tr className="text-left text-xs uppercase text-muted"><th className="py-1">Alert type</th><th>Total</th><th>Genuine</th><th>False alarm</th><th>Cancelled by tourist</th><th>Still open</th><th>False-alarm share</th></tr></thead>
                <tbody>{d.rules.map((r) => (
                  <tr key={r.kind} className="border-t border-line">
                    <td className="py-1.5">{r.kind.replace('_', ' ')}</td><td>{r.total}</td><td>{r.genuine}</td><td>{r.false_alarm}</td><td>{r.cancelled}</td><td>{r.open}</td>
                    <td>{r.false_alarm_ratio == null ? <span className="text-muted">not judged yet</span> : <Badge tone={r.false_alarm_ratio > 0.5 ? 'danger' : r.false_alarm_ratio > 0.2 ? 'warn' : 'ok'}>{Math.round(r.false_alarm_ratio * 100)}%</Badge>}</td>
                  </tr>))}</tbody>
              </table>
            )}
          </Card>
        </div>
      )}
    </AppShell>
  )
}
