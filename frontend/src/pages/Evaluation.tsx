import { useState } from 'react'
import { api } from '../api'
import Layout from '../components/Layout'

interface Row { measure: string; limit: string; measured: string | number; unit: string; status: string; note: string }

const COLOR: Record<string, string> = { met: 'bg-ok/15 text-ok', 'NOT MET': 'bg-danger/15 text-danger', 'next stage': 'bg-sunken text-muted', 'not run': 'bg-warn/15 text-warn' }

/** Paper Table V, measured live. Field-trial rows stay "next stage" because they cannot be measured without real users. */
export default function Evaluation() {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function run(detection: boolean) {
    setBusy(true); setError('')
    try {
      const { data } = await api.get(`/evaluation/table5?detection=${detection}`, { timeout: 300000 })
      setRows(data.rows)
    } catch { setError('Could not run the evaluation.') }
    finally { setBusy(false) }
  }

  return (
    <Layout title="Evaluation vs paper Table V">
      <p className="mb-3 text-sm text-muted">
        Measured on this server with synthetic data. These show whether the implementation meets the limits the paper fixed
        before testing, not real-world performance.
      </p>
      <div className="mb-4 flex gap-2">
        <button className="btn" disabled={busy} onClick={() => run(false)}>Run quick checks</button>
        <button className="rounded border px-3 py-2" disabled={busy} onClick={() => run(true)}>Include detection benchmark (about 1 min)</button>
      </div>
      {busy && <p role="status">Running…</p>}
      {error && <p role="alert" className="text-danger">{error}</p>}
      {rows && (
        <table className="w-full rounded-lg bg-surface text-sm shadow">
          <thead><tr className="border-b text-left"><th className="p-2">Measure</th><th>Limit</th><th>Measured</th><th>Status</th><th>Note</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.measure} className="border-b last:border-0">
                <td className="p-2">{r.measure}</td><td>{r.limit}</td><td>{r.measured} {r.unit}</td>
                <td><span className={`rounded px-2 py-0.5 text-xs font-semibold ${COLOR[r.status] ?? ''}`}>{r.status}</span></td>
                <td className="text-xs text-muted">{r.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Layout>
  )
}
