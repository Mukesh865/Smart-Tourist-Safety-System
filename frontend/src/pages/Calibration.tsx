import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import AppShell from '../components/AppShell'
import { Badge, Button, Card, ConfirmDialog, Skeleton, useToast } from '../ui'

type Values = Record<string, number>
interface Payload { values: Values; defaults: Values; bounds: Record<string, { min: number; max: number }> }
interface SetResult { recall: number; precision: number; fa_per_100: number; kinds: Record<string, { recall: number; median_delay: number | null }> }
interface WhatIf { candidate: Record<'matched' | 'shifted', SetResult>; defaults: Record<'matched' | 'shifted', SetResult>; geo: { candidate: number; defaults: number }; note: string }

const GROUPS: { title: string; hint: string; fields: { key: string; label: string; unit: string; step: number }[] }[] = [
  { title: 'R1: signal drop-off', hint: 'Alert when no location arrives for longer than this. Raise it for roads with long dead zones (the paper suggests the longest normal gap).',
    fields: [{ key: 'r1_minutes', label: 'No location for more than', unit: 'min', step: 1 }] },
  { title: 'R2: prolonged inactivity', hint: 'Alert when a visitor stays still away from every planned stop (or for very long anywhere except the hotel).',
    fields: [{ key: 'r2_still_min', label: 'Still for more than', unit: 'min', step: 5 }, { key: 'r2_dist_m', label: 'and farther than', unit: 'm from any stop', step: 25 },
      { key: 'r2_anywhere_min', label: 'or still anywhere for more than', unit: 'min', step: 10 }] },
  { title: 'R3: route deviation', hint: 'Alert when a visitor stays far from the planned route.',
    fields: [{ key: 'r3_km', label: 'Farther than', unit: 'km from route', step: 0.1 }, { key: 'r3_minutes', label: 'for', unit: 'min', step: 1 }] },
  { title: 'Alert handling', hint: 'One incident at a time per visitor.', fields: [{ key: 'cooldown_min', label: 'Cool-down between alerts', unit: 'min', step: 5 }] },
  { title: 'Geo-fence', hint: 'Buffer and debounce make zone alerts robust to GPS drift (paper: about 4 times the GPS error, 3 fixes).',
    fields: [{ key: 'geo_k', label: 'Consecutive fixes inside', unit: 'fixes', step: 1 }, { key: 'geo_buffer_m', label: 'Must be inside by', unit: 'm', step: 5 }, { key: 'warn_ring_m', label: 'No-entry warning ring', unit: 'm', step: 10 }] },
  { title: 'Night (safety score)', hint: 'Hours counted as night in the visitor safety score (India time).',
    fields: [{ key: 'night_start', label: 'Night starts at', unit: 'o\'clock', step: 1 }, { key: 'night_end', label: 'Night ends at', unit: 'o\'clock', step: 1 }] },
]

const pct = (x: number) => `${Math.round(x * 100)}%`
const errText = (e: any, d: string) => (typeof e?.response?.data?.detail === 'string' ? e.response.data.detail : d)

function Compare({ label, cand, base }: { label: string; cand: SetResult; base: SetResult }) {
  const row = (name: string, c: string, b: string, better?: boolean | null) => (
    <tr className="border-t border-line"><td className="py-1">{name}</td><td>{b}</td><td className="font-semibold">{c}</td>
      <td>{better == null ? '' : <Badge tone={better ? 'ok' : 'warn'}>{better ? 'better' : 'worse'}</Badge>}</td></tr>)
  const d = (k: string) => (r: SetResult) => r.kinds[k]?.median_delay
  const fmtD = (v: number | null | undefined) => (v == null ? '-' : `${v} min`)
  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold">{label}</h3>
      <table className="w-full text-sm">
        <thead><tr className="text-left text-xs uppercase text-muted"><th className="py-1">Measure</th><th>Paper defaults</th><th>Your settings</th><th /></tr></thead>
        <tbody>
          {row('Anomalies found (recall)', pct(cand.recall), pct(base.recall), cand.recall === base.recall ? null : cand.recall > base.recall)}
          {row('False alerts per 100 days', String(cand.fa_per_100), String(base.fa_per_100), cand.fa_per_100 === base.fa_per_100 ? null : cand.fa_per_100 < base.fa_per_100)}
          {row('Drop-off alert delay', fmtD(d('dropoff')(cand)), fmtD(d('dropoff')(base)))}
          {row('Inactivity alert delay', fmtD(d('inactivity')(cand)), fmtD(d('inactivity')(base)))}
          {row('Deviation alert delay', fmtD(d('deviation')(cand)), fmtD(d('deviation')(base)))}
        </tbody>
      </table>
    </div>
  )
}

export default function Calibration() {
  const toast = useToast()
  const [data, setData] = useState<Payload | null>(null)
  const [vals, setVals] = useState<Values>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<'' | 'save' | 'whatif'>('')
  const [result, setResult] = useState<WhatIf | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)

  useEffect(() => { api.get('/admin/settings').then((r) => { setData(r.data); setVals(r.data.values) }).catch((e) => toast(errText(e, 'Could not load settings'), { kind: 'error' })) }, [toast])

  const dirty = useMemo(() => !!data && Object.keys(vals).some((k) => vals[k] !== data.values[k]), [vals, data])
  const modified = (k: string) => !!data && vals[k] !== data.defaults[k]

  function set(k: string, raw: string) {
    setResult(null)
    const n = raw === '' ? NaN : Number(raw)
    setVals((v) => ({ ...v, [k]: n }))
    const b = data!.bounds[k]
    setErrors((e) => {
      const next = { ...e }
      if (Number.isNaN(n) || n < b.min || n > b.max) next[k] = `Between ${b.min} and ${b.max}`
      else delete next[k]
      return next
    })
  }
  const invalid = Object.keys(errors).length > 0 || Object.values(vals).some((v) => Number.isNaN(v))

  async function save() {
    setBusy('save')
    try { const { data: d } = await api.put('/admin/settings', vals); setData(d); setVals(d.values); toast('Settings saved. They apply from the next fix and the next detection run.', { kind: 'success' }) }
    catch (e) { toast(errText(e, 'Could not save'), { kind: 'error' }) }
    finally { setBusy('') }
  }
  async function whatIf() {
    setBusy('whatif'); setResult(null)
    try { const { data: d } = await api.post('/admin/settings/whatif', vals, { timeout: 120000 }); setResult(d) }
    catch (e) { toast(errText(e, 'Could not run the preview'), { kind: 'error' }) }
    finally { setBusy('') }
  }
  async function reset() {
    setConfirmReset(false)
    try { const { data: d } = await api.post('/admin/settings/reset'); setData(d); setVals(d.values); setErrors({}); setResult(null); toast('Back to the paper\'s defaults', { kind: 'success' }) }
    catch (e) { toast(errText(e, 'Could not reset'), { kind: 'error' }) }
  }

  return (
    <AppShell title="Detection calibration">
      <p className="mb-4 max-w-3xl text-sm text-muted">
        The paper warns that rule thresholds must be tuned to each district. Change them here, preview the effect on simulated tourist-days, then save.
        Defaults are the paper's values. Previews use simulated data only, so confirm changes against real field results before relying on them.
      </p>
      {!data ? <Skeleton className="h-64" /> : (
        <div className="grid gap-4 lg:grid-cols-5">
          <div className="space-y-4 lg:col-span-3">
            {GROUPS.map((g) => (
              <Card key={g.title} className="space-y-3 p-4">
                <div><h2 className="font-semibold">{g.title}</h2><p className="text-xs text-muted">{g.hint}</p></div>
                {g.fields.map((f) => {
                  const b = data.bounds[f.key]
                  return (
                    <div key={f.key} className="grid items-center gap-2 sm:grid-cols-[1fr_auto]">
                      <div>
                        <label htmlFor={f.key} className="text-sm">{f.label}</label>
                        <input type="range" aria-label={`${f.label} slider`} className="w-full" min={b.min} max={b.max} step={f.step} value={Number.isNaN(vals[f.key]) ? data.defaults[f.key] : vals[f.key]}
                               onChange={(e) => set(f.key, e.target.value)} />
                        <p className="text-xs text-muted">Paper default: {data.defaults[f.key]} {f.unit}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <input id={f.key} type="number" className="input w-24" min={b.min} max={b.max} step={f.step} value={Number.isNaN(vals[f.key]) ? '' : vals[f.key]}
                               aria-invalid={!!errors[f.key] || undefined} aria-describedby={errors[f.key] ? `${f.key}-err` : undefined} onChange={(e) => set(f.key, e.target.value)} />
                        <span className="w-24 text-xs text-muted">{f.unit}</span>
                        {modified(f.key) && <Badge tone="warn">changed</Badge>}
                      </div>
                      {errors[f.key] && <p id={`${f.key}-err`} role="alert" className="text-xs text-danger sm:col-span-2">{errors[f.key]}</p>}
                    </div>
                  )
                })}
              </Card>
            ))}
          </div>

          <div className="space-y-4 lg:col-span-2">
            <Card className="sticky top-20 space-y-3 p-4">
              <h2 className="font-semibold">Preview and save</h2>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={whatIf} loading={busy === 'whatif'} disabled={invalid || busy === 'save'}>Preview effect (about 20 s)</Button>
                <Button onClick={save} loading={busy === 'save'} disabled={!dirty || invalid}>Save settings</Button>
                <Button variant="ghost" onClick={() => setConfirmReset(true)}>Reset to paper defaults</Button>
              </div>
              {dirty && <p className="text-xs text-warn">You have unsaved changes.</p>}
              {busy === 'whatif' && <p role="status" className="text-sm text-muted">Simulating tourist-days…</p>}
              {result && (
                <div className="space-y-4" aria-label="Preview result">
                  <Compare label="Behaviour matches the rules' assumptions" cand={result.candidate.matched} base={result.defaults.matched} />
                  <Compare label="Wider benign behaviour (hill roads, tunnels, markets)" cand={result.candidate.shifted} base={result.defaults.shifted} />
                  <p className="text-sm">Zone alerts walking along a boundary: <b>{result.geo.candidate.toFixed(2)}</b> per km (paper defaults: {result.geo.defaults.toFixed(2)}).</p>
                  <p className="text-xs text-muted">{result.note}</p>
                </div>
              )}
            </Card>
          </div>
        </div>
      )}
      <ConfirmDialog open={confirmReset} title="Reset all settings?" message="Detection and geo-fence settings return to the paper's defaults for the whole system." confirmLabel="Reset" danger onConfirm={reset} onCancel={() => setConfirmReset(false)} />
    </AppShell>
  )
}
