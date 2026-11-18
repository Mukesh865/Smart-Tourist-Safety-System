import { useEffect, useRef, useState } from 'react'
import { Html5Qrcode } from 'html5-qrcode'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { ThemeToggle } from '../components/AppShell'
import { useAuth, homeFor } from '../store'
import { Button, Card, IconShield } from '../ui'

interface Result {
  valid: boolean; merkle_ok: boolean; signature_ok: boolean; in_validity: boolean; revoked?: boolean
  reason: string; id_code: string | null; verification?: string | null
}

const FAIL = (reason: string): Result => ({ valid: false, merkle_ok: false, signature_ok: false, in_validity: false, reason, id_code: null })

const Check = ({ ok, children }: { ok: boolean; children: string }) => (
  <li className="flex items-center gap-2"><span aria-hidden className={ok ? 'text-ok' : 'text-danger'}>{ok ? '✓' : '✗'}</span><span>{children}: <b>{ok ? 'pass' : 'fail'}</b></span></li>
)

/** Public check-post page: paste or scan a credential and verify it. No login needed, no personal data shown. */
export default function Verify() {
  const user = useAuth((s) => s.user)
  const [payload, setPayload] = useState('')
  const [res, setRes] = useState<Result | null>(null)
  const [scanning, setScanning] = useState(false)
  const [busy, setBusy] = useState(false)
  const scanner = useRef<Html5Qrcode | null>(null)

  async function verify(p = payload) {
    setBusy(true)
    try {
      const { data } = await api.post('/ledger/verify', { payload: p })
      setRes(data)
    } catch (e: any) {
      setRes(FAIL(e?.response?.status === 429 ? 'Too many checks. Wait a minute and try again.' : 'Could not verify'))
    } finally { setBusy(false) }
  }

  async function stopScan() {
    try { await scanner.current?.stop() } catch { /* already stopped */ }
    setScanning(false)
  }

  async function startScan() {
    setScanning(true)
    setTimeout(async () => {
      try {
        scanner.current = new Html5Qrcode('qr-reader')
        await scanner.current.start({ facingMode: 'environment' }, { fps: 10, qrbox: 250 }, (text) => {
          setPayload(text)
          verify(text)
          stopScan()
        }, () => {})
      } catch {
        setScanning(false)
        setRes(FAIL('Camera unavailable. Paste the code instead.'))
      }
    }, 0)
  }

  useEffect(() => () => { scanner.current?.stop().catch(() => {}) }, [])

  return (
    <div className="min-h-full">
      <header className="flex h-14 items-center justify-between border-b border-line bg-surface px-4">
        <Link to={user ? homeFor(user.role) : '/login'} className="flex items-center gap-2 font-bold">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand text-white dark:text-slate-950"><IconShield width={18} height={18} /></span>
          Tourist Safety
        </Link>
        <ThemeToggle />
      </header>
      <main className="mx-auto max-w-xl space-y-4 p-4 sm:p-6">
        <Link to={user ? homeFor(user.role) : '/login'} className="text-sm text-brand-ink underline">← Back</Link>
        <h1 className="text-2xl font-bold">Verify Tourist ID</h1>
        <p className="text-sm text-muted">Scan the QR on the visitor's phone or card, or paste its text. Works for any check-post; shows no personal details.</p>
        <div id="qr-reader" className={scanning ? 'w-full overflow-hidden rounded-xl' : 'hidden'} />
        <div className="flex gap-2">
          <Button onClick={scanning ? stopScan : startScan}>{scanning ? 'Stop camera' : 'Scan QR'}</Button>
        </div>
        <textarea className="input h-32 font-mono text-xs" placeholder="…or paste the QR text here" aria-label="QR text"
                  value={payload} onChange={(e) => setPayload(e.target.value)} />
        <Button onClick={() => verify()} disabled={!payload} loading={busy}>Verify</Button>
        {res && (
          <Card role="status" className={`p-4 ${res.valid ? 'border-ok bg-ok/10' : 'border-danger bg-danger/10'}`}>
            <p className={`text-xl font-extrabold ${res.valid ? 'text-ok' : 'text-danger'}`}>{res.valid ? 'VALID ID' : 'NOT VALID'}</p>
            {res.id_code && <p className="font-mono">{res.id_code}</p>}
            {res.valid && res.verification && <p className="text-sm">{res.verification === 'officer' ? 'Identity checked by an officer.' : 'Self-declared: identity document not yet checked. Ask to see the original document.'}</p>}
            {res.id_code && (
              <ul className="mt-3 space-y-1 text-sm">
                <Check ok={res.merkle_ok}>Merkle proof</Check>
                <Check ok={res.signature_ok}>Authority signature</Check>
                <Check ok={res.in_validity}>Within validity dates</Check>
                <Check ok={!res.revoked}>Not on the revocation list</Check>
              </ul>
            )}
            {res.reason && <p className="mt-3 text-sm font-medium text-danger">{res.reason}</p>}
          </Card>
        )}
      </main>
    </div>
  )
}
