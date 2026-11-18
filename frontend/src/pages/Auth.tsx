import { useState, type FormEvent } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { homeFor, useAuth } from '../store'
import { Button, IconEye, IconShield, TextInput } from '../ui'
import { ThemeToggle } from '../components/AppShell'

/** Password strength hint (length + variety). Guidance only; the server enforces the real rule (8+ chars). */
export function passwordStrength(pw: string): { score: 0 | 1 | 2 | 3; label: string } {
  if (!pw) return { score: 0, label: '' }
  let s = 0
  if (pw.length >= 8) s++
  if (pw.length >= 12 || (/[a-z]/.test(pw) && /[A-Z]/.test(pw))) s++
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++
  const score = Math.min(s, 3) as 0 | 1 | 2 | 3
  return { score, label: ['Too short', 'Weak', 'Good', 'Strong'][score] }
}

const DEMO = import.meta.env.DEV ? [
  { label: 'Admin', email: 'admin@tourist.local', pw: 'Admin@12345' },
  { label: 'Demo tourist', email: 'demo1@tourist.local', pw: 'Demo@12345' },
] : []

export default function Auth({ mode }: { mode: 'login' | 'register' }) {
  const { user, login, register } = useAuth()
  const nav = useNavigate()
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [reveal, setReveal] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const strength = passwordStrength(password)

  if (user) return <Navigate to={homeFor(user.role)} replace />

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      if (mode === 'login') await login(email, password)
      else await register(email, name, password)
      nav('/')
    } catch (err: any) {
      const d = err?.response?.data?.detail
      setError(err?.response?.status === 429 ? 'Too many attempts. Please wait a minute and try again.'
        : typeof d === 'string' ? d : 'Something went wrong. Check your details.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid min-h-full lg:grid-cols-2">
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-brand p-10 text-white dark:text-slate-950 lg:flex">
        <span className="flex items-center gap-2 text-lg font-bold"><IconShield /> Tourist Safety</span>
        <div>
          <h2 className="text-3xl font-bold leading-tight">Travel with confidence.<br />Help is one press away.</h2>
          <ul className="mt-6 space-y-3 text-sm">
            <li>• A digital ID that can be verified offline, with no personal data on the ledger</li>
            <li>• Live geo-fence warnings for risky areas</li>
            <li>• Panic button that reaches the control room and your family</li>
          </ul>
        </div>
        <p className="text-xs">Based on the AKGEC IEEE research prototype.</p>
      </aside>

      <main className="flex flex-col p-4 sm:p-8">
        <div className="flex justify-end"><ThemeToggle /></div>
        <div className="m-auto w-full max-w-sm">
          <form onSubmit={submit} className="space-y-4" noValidate={false}>
            <div>
              <h1 className="text-2xl font-bold">{mode === 'login' ? 'Sign in' : 'Create tourist account'}</h1>
              <p className="mt-1 text-sm text-muted">{mode === 'login' ? 'Welcome back.' : 'Register to get your digital tourist ID at the entry point.'}</p>
            </div>
            {mode === 'register' && <TextInput label="Full name" value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" />}
            <TextInput label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
            <div>
              <div className="relative">
                <TextInput label="Password" type={reveal ? 'text' : 'password'} minLength={8} value={password} required
                           onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                           hint={mode === 'register' ? 'At least 8 characters.' : undefined} />
                <button type="button" onClick={() => setReveal((v) => !v)} aria-pressed={reveal} aria-label="Show or hide characters" title="Show or hide characters"
                        className="absolute right-2 top-7 grid h-8 w-8 place-items-center rounded text-muted hover:text-ink"><IconEye width={18} height={18} /></button>
              </div>
              {mode === 'register' && password && (
                <div className="mt-2" aria-live="polite">
                  <div className="flex gap-1">{[1, 2, 3].map((i) => <span key={i} className={`h-1.5 flex-1 rounded ${strength.score >= i ? (strength.score === 3 ? 'bg-ok' : strength.score === 2 ? 'bg-warn' : 'bg-danger') : 'bg-sunken'}`} />)}</div>
                  <p className="mt-1 text-xs text-muted">Strength: {strength.label}</p>
                </div>
              )}
            </div>
            {error && <p role="alert" className="rounded-lg bg-danger/10 p-2 text-sm text-danger">{error}</p>}
            <Button type="submit" className="w-full" loading={busy}>{mode === 'login' ? 'Sign in' : 'Register'}</Button>
            <p className="text-center text-sm text-muted">
              {mode === 'login'
                ? <>New tourist? <Link className="font-medium text-brand-ink underline" to="/register">Register</Link></>
                : <>Have an account? <Link className="font-medium text-brand-ink underline" to="/login">Sign in</Link></>}
            </p>
            <p className="text-center text-sm"><Link className="text-brand-ink underline" to="/verify">Verify a tourist ID (check-post)</Link></p>
          </form>
          {mode === 'login' && DEMO.length > 0 && (
            <div className="mt-6 rounded-lg bg-sunken p-3 text-xs text-muted">
              <p className="mb-2 font-semibold">Development shortcuts</p>
              <div className="flex flex-wrap gap-2">
                {DEMO.map((d) => (
                  <button key={d.label} type="button" className="rounded border border-line bg-surface px-2 py-1 hover:bg-canvas"
                          onClick={() => { setEmail(d.email); setPassword(d.pw) }}>{d.label}</button>
                ))}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
