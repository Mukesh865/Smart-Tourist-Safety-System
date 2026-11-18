import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, TOKEN_KEY } from '../api'
import AppShell from '../components/AppShell'
import { passwordStrength } from './Auth'
import { useAuth } from '../store'
import { Badge, Button, Card, ConfirmDialog, SelectInput, TextInput, useTheme, useToast, type ThemePref } from '../ui'

export default function Profile() {
  const { user, logout } = useAuth()
  const toast = useToast()
  const nav = useNavigate()
  const { pref, setPref } = useTheme()
  const [cur, setCur] = useState('')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmAll, setConfirmAll] = useState(false)
  const strength = passwordStrength(pw)

  async function change(e: FormEvent) {
    e.preventDefault()
    setError('')
    if (pw !== pw2) return setError('The new passwords do not match')
    setBusy(true)
    try {
      const { data } = await api.post('/auth/change-password', { current_password: cur, new_password: pw })
      localStorage.setItem(TOKEN_KEY, data.access_token)        // the old token is no longer valid
      setCur(''); setPw(''); setPw2('')
      toast('Password changed. Other devices were signed out.', { kind: 'success' })
    } catch (err: any) {
      setError(typeof err?.response?.data?.detail === 'string' ? err.response.data.detail : 'Could not change the password')
    } finally { setBusy(false) }
  }

  async function signOutEverywhere() {
    setConfirmAll(false)
    try { await api.post('/auth/logout-all') } catch { /* token may already be invalid */ }
    logout()
    nav('/login')
  }

  async function setLanguage(language: string) {
    try { await api.put('/me/language', { language }) } catch { /* offline: keep UI language */ }
    useAuth.setState((s) => ({ user: s.user ? { ...s.user, language } : s.user }))
  }

  return (
    <AppShell title="Profile">
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="space-y-2 p-5">
          <h2 className="font-semibold">Account</h2>
          <p className="text-lg font-medium">{user?.full_name}</p>
          <p className="text-sm text-muted">{user?.email}</p>
          <Badge tone="brand" className="capitalize">{user?.role}</Badge>
        </Card>

        <Card className="space-y-4 p-5">
          <h2 className="font-semibold">Appearance and language</h2>
          <SelectInput label="Theme" value={pref} onChange={(e) => setPref(e.target.value as ThemePref)}>
            <option value="system">Match my device</option><option value="light">Light</option><option value="dark">Dark</option>
          </SelectInput>
          <SelectInput label="Language" value={user?.language ?? 'en'} onChange={(e) => setLanguage(e.target.value)}>
            <option value="en">English</option><option value="hi">हिन्दी</option>
          </SelectInput>
        </Card>

        <Card className="p-5 md:col-span-2">
          <h2 className="mb-3 font-semibold">Change password</h2>
          <form onSubmit={change} className="grid gap-3 sm:grid-cols-3">
            <TextInput label="Current password" type="password" value={cur} onChange={(e) => setCur(e.target.value)} required autoComplete="current-password" />
            <TextInput label="New password" type="password" minLength={8} value={pw} onChange={(e) => setPw(e.target.value)} required autoComplete="new-password"
                       hint={pw ? `Strength: ${strength.label}` : 'At least 8 characters'} />
            <TextInput label="Repeat new password" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} required autoComplete="new-password"
                       error={pw2 && pw !== pw2 ? 'Does not match' : undefined} />
            <div className="sm:col-span-3">
              {error && <p role="alert" className="mb-2 text-sm text-danger">{error}</p>}
              <Button type="submit" loading={busy}>Update password</Button>
            </div>
          </form>
        </Card>

        <Card className="p-5 md:col-span-2">
          <h2 className="font-semibold">Sessions</h2>
          <p className="mb-3 mt-1 text-sm text-muted">Lost a phone or used a shared computer? Sign out of every device, including this one.</p>
          <Button variant="danger" onClick={() => setConfirmAll(true)}>Sign out of all devices</Button>
        </Card>
      </div>
      <ConfirmDialog open={confirmAll} danger title="Sign out everywhere?" confirmLabel="Sign out of all devices"
        message="Every active session, on every device, will end. You will need to sign in again."
        onConfirm={signOutEverywhere} onCancel={() => setConfirmAll(false)} />
    </AppShell>
  )
}
