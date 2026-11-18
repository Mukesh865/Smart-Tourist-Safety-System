import { useEffect, useState } from 'react'
import { api } from '../api'

const LABEL: Record<string, string> = {
  normal: 'Normal walk (no alert)', dropoff: 'Signal drop-off', inactivity: 'Prolonged inactivity',
  deviation: 'Route deviation', zone_entry: 'Enter risk zone', border_warning: 'Approach no-entry zone', panic: 'Panic button',
}

/** Police/admin demo tools. Scenarios replay through the real fix-ingest and detection code. Hidden if the server disables demo mode. */
export default function DemoPanel({ onDone }: { onDone?: () => void }) {
  const [scenarios, setScenarios] = useState<string[] | null>(null)
  const [email, setEmail] = useState('demo1@tourist.local')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => { api.get('/demo/scenarios').then((r) => setScenarios(r.data.scenarios)).catch(() => setScenarios(null)) }, [])
  if (!scenarios) return null

  async function call(fn: () => Promise<string>) {
    setBusy(true); setMsg('')
    try { setMsg(await fn()); onDone?.() }
    catch (e: any) { setMsg(e?.response?.data?.detail ?? 'Demo action failed') }
    finally { setBusy(false) }
  }

  return (
    <details className="rounded-md bg-surface p-3 text-sm shadow">
      <summary className="cursor-pointer font-semibold">Demo mode (simulated tourists)</summary>
      <div className="mt-3 space-y-3">
        <div className="flex flex-wrap gap-2">
          <button className="rounded border px-3 py-1" disabled={busy}
                  onClick={() => call(async () => {
                    const { data } = await api.post('/demo/seed')
                    return `Seeded: ${data.users_created} tourists, ${data.zones_created} zones. Tourist login: ${data.demo_login.emails[0]} / ${data.demo_login.password}`
                  })}>Seed demo data</button>
          <button className="rounded border px-3 py-1" disabled={busy}
                  onClick={() => call(async () => { const { data } = await api.post('/demo/reset'); return `Reset: ${data.removed} records removed` })}>Reset demo</button>
        </div>
        <label className="block">Tourist
          <select className="input" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="demo tourist">
            {['demo1', 'demo2', 'demo3'].map((d) => <option key={d} value={`${d}@tourist.local`}>{d}</option>)}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-2">
          {scenarios.map((s) => (
            <button key={s} className="btn !px-2 !py-1" disabled={busy}
                    onClick={() => call(async () => {
                      const { data } = await api.post('/demo/scenario', { scenario: s, email })
                      return `${LABEL[s] ?? s}: ${data.alerts.length ? data.alerts.map((a: any) => a.kind).join(', ') : 'no alert'}`
                    })}>{LABEL[s] ?? s}</button>
          ))}
        </div>
        {msg && <p role="status" className="rounded bg-sunken p-2">{msg}</p>}
      </div>
    </details>
  )
}
