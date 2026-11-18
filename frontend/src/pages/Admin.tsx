import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api } from '../api'
import AppShell from '../components/AppShell'
import { Badge, Button, Card, ConfirmDialog, EmptyState, Modal, SelectInput, Skeleton, StatCard, Tabs, TextInput, useToast } from '../ui'
import type { Role } from '../store'

interface UserRow { id: number; email: string; full_name: string; role: Role; disabled: boolean; id_code: string | null; created_at: string }
interface Stats {
  users_by_role: Record<string, number>; disabled_users: number; alerts_by_status: Record<string, number>
  open_incidents: number; ledger_blocks: number; ids_issued: number
  system: { env: string; demo_enabled: boolean; rate_limit_enabled: boolean; detection_interval_s: number; forest_model_loaded: boolean }
}
interface AuditRow { id: number; ts: string; action: string; actor: string | null; detail: string; tourist_id: number | null }

const ROLES: Role[] = ['tourist', 'officer', 'police', 'admin']
const PAGE = 20
const AUDIT_ACTIONS = ['ack', 'dispatch', 'resolve', 'assign', 'note', 'reveal_pii', 'efir', 'export_alerts', 'issue_id', 'revoke_id', 'renew_id', 'update_itinerary', 'admin_update_user', 'admin_reset_password', 'admin_update_settings']
const errText = (e: any, fallback: string) => (typeof e?.response?.data?.detail === 'string' ? e.response.data.detail : fallback)

/* ------------------------------ Users ------------------------------ */
function UsersTab() {
  const toast = useToast()
  const [q, setQ] = useState('')
  const [role, setRole] = useState('')
  const [offset, setOffset] = useState(0)
  const [data, setData] = useState<{ total: number; items: UserRow[] } | null>(null)
  const [creating, setCreating] = useState(false)
  const [confirm, setConfirm] = useState<{ kind: 'toggle' | 'reset'; user: UserRow } | null>(null)
  const [temp, setTemp] = useState<{ email: string; password: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/admin/users', { params: { q, role: role || undefined, limit: PAGE, offset } })
      setData(data)
    } catch (e) { toast(errText(e, 'Could not load users'), { kind: 'error' }) }
  }, [q, role, offset, toast])

  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t) }, [load])   // debounce typing

  async function patch(u: UserRow, body: object, ok: string) {
    try { await api.patch(`/admin/users/${u.id}`, body); toast(ok, { kind: 'success' }); await load() }
    catch (e) { toast(errText(e, 'Update failed'), { kind: 'error' }) }
  }

  async function doConfirm() {
    if (!confirm) return
    const { kind, user } = confirm
    setConfirm(null)
    if (kind === 'toggle') return patch(user, { disabled: !user.disabled }, user.disabled ? 'Account enabled' : 'Account disabled')
    try {
      const { data } = await api.post(`/admin/users/${user.id}/reset-password`)
      setTemp({ email: user.email, password: data.temporary_password })
    } catch (e) { toast(errText(e, 'Reset failed'), { kind: 'error' }) }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-full sm:w-64"><TextInput label="Search name or email" value={q} onChange={(e) => { setQ(e.target.value); setOffset(0) }} /></div>
        <div className="w-40">
          <SelectInput label="Role" value={role} onChange={(e) => { setRole(e.target.value); setOffset(0) }}>
            <option value="">All roles</option>
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </SelectInput>
        </div>
        <Button className="ml-auto" onClick={() => setCreating(true)}>Add staff account</Button>
      </div>

      {!data ? <Skeleton className="h-40" /> : data.items.length === 0 ? (
        <EmptyState title="No users match" hint="Try a different search or role filter." />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead><tr className="border-b text-left text-xs uppercase text-muted"><th className="p-3">User</th><th>Role</th><th>Status</th><th>ID</th><th className="pr-3 text-right">Actions</th></tr></thead>
            <tbody>
              {data.items.map((u) => (
                <tr key={u.id} className="border-b last:border-0">
                  <td className="p-3"><p className="font-medium">{u.full_name}</p><p className="text-xs text-muted">{u.email}</p></td>
                  <td>
                    <select aria-label={`Role for ${u.email}`} value={u.role} className="rounded-md border border-line bg-surface px-2 py-1 text-xs"
                            onChange={(e) => patch(u, { role: e.target.value }, `Role changed to ${e.target.value}`)}>
                      {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </td>
                  <td>{u.disabled ? <Badge tone="danger">Disabled</Badge> : <Badge tone="ok">Active</Badge>}</td>
                  <td className="font-mono text-xs">{u.id_code ?? '-'}</td>
                  <td className="space-x-2 whitespace-nowrap pr-3 text-right">
                    <Button size="sm" variant="secondary" onClick={() => setConfirm({ kind: 'reset', user: u })}>Reset password</Button>
                    <Button size="sm" variant={u.disabled ? 'secondary' : 'danger'} onClick={() => setConfirm({ kind: 'toggle', user: u })}>{u.disabled ? 'Enable' : 'Disable'}</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {data && data.total > PAGE && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted">{offset + 1}-{Math.min(offset + PAGE, data.total)} of {data.total}</span>
          <div className="space-x-2">
            <Button size="sm" variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</Button>
            <Button size="sm" variant="secondary" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>Next</Button>
          </div>
        </div>
      )}

      <CreateStaff open={creating} onClose={() => setCreating(false)} onDone={() => { setCreating(false); load() }} />
      <ConfirmDialog open={!!confirm} danger={confirm?.kind === 'toggle' && !confirm.user.disabled}
        title={confirm?.kind === 'reset' ? 'Reset password?' : confirm?.user.disabled ? 'Enable account?' : 'Disable account?'}
        message={confirm?.kind === 'reset'
          ? `A temporary password will be generated for ${confirm?.user.email}. Their current sessions will end.`
          : confirm?.user.disabled ? `${confirm?.user.email} will be able to sign in again.` : `${confirm?.user.email} will be signed out immediately and cannot sign in.`}
        confirmLabel={confirm?.kind === 'reset' ? 'Reset' : confirm?.user.disabled ? 'Enable' : 'Disable'}
        onConfirm={doConfirm} onCancel={() => setConfirm(null)} />
      <Modal open={!!temp} title="Temporary password" onClose={() => setTemp(null)}
             footer={<Button onClick={() => setTemp(null)}>Done</Button>}>
        <p className="text-sm text-muted">Share this with {temp?.email} through a secure channel. It is shown only once.</p>
        <p className="select-all rounded-lg bg-sunken p-3 text-center font-mono text-lg" aria-label="temporary password">{temp?.password}</p>
      </Modal>
    </div>
  )
}

function CreateStaff({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast()
  const [f, setF] = useState({ full_name: '', email: '', password: '', role: 'officer' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value })

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      await api.post('/auth/staff', f)
      toast(`${f.role} account created`, { kind: 'success' })
      setF({ full_name: '', email: '', password: '', role: 'officer' })
      onDone()
    } catch (err) { setError(errText(err, 'Check the details and try again')) }
    finally { setBusy(false) }
  }

  return (
    <Modal open={open} title="Add staff account" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <TextInput label="Full name" required value={f.full_name} onChange={set('full_name')} />
        <TextInput label="Email" type="email" required value={f.email} onChange={set('email')} />
        <TextInput label="Initial password" type="text" required minLength={8} hint="At least 8 characters. They should change it after signing in." value={f.password} onChange={set('password')} />
        <SelectInput label="Role" value={f.role} onChange={set('role')}>
          <option value="officer">Issuing officer</option><option value="police">Police / control room</option><option value="admin">Administrator</option>
        </SelectInput>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy}>Create account</Button></div>
      </form>
    </Modal>
  )
}

/* ------------------------------ System ------------------------------ */
function SystemTab() {
  const toast = useToast()
  const [s, setS] = useState<Stats | null>(null)
  const [chain, setChain] = useState<string>('')
  const [erase, setErase] = useState(false)

  useEffect(() => { api.get('/admin/stats').then((r) => setS(r.data)).catch((e) => toast(errText(e, 'Could not load statistics'), { kind: 'error' })) }, [toast])

  async function audit() {
    try {
      const { data } = await api.get('/ledger/chain')
      setChain(data.ok ? `Chain intact: ${data.blocks} block(s) verified` : `CHAIN BROKEN at block ${data.broken_at}`)
    } catch (e) { toast(errText(e, 'Audit failed'), { kind: 'error' }) }
  }
  async function eraseNow() {
    setErase(false)
    try { const { data } = await api.post('/ledger/erase-expired'); toast(`Erased personal data for ${data.erased} expired ID(s)`, { kind: 'success' }) }
    catch (e) { toast(errText(e, 'Erase failed'), { kind: 'error' }) }
  }

  if (!s) return <Skeleton className="h-40" />
  const open = s.alerts_by_status.open ?? 0
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="IDs issued" value={s.ids_issued} />
        <StatCard label="Ledger blocks" value={s.ledger_blocks} />
        <StatCard label="Open alerts" value={open} tone={open ? 'danger' : 'ok'} />
        <StatCard label="Open incidents" value={s.open_incidents} tone={s.open_incidents ? 'warn' : 'ok'} />
      </div>
      <Card className="p-4">
        <h2 className="mb-3 font-semibold">Users</h2>
        <div className="flex flex-wrap gap-2">{Object.entries(s.users_by_role).map(([r, n]) => <Badge key={r} tone="brand">{r}: {n}</Badge>)}
          {s.disabled_users > 0 && <Badge tone="danger">disabled: {s.disabled_users}</Badge>}</div>
      </Card>
      <Card className="p-4">
        <h2 className="mb-3 font-semibold">Configuration</h2>
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <div><dt className="text-muted">Environment</dt><dd><Badge tone={s.system.env === 'production' ? 'ok' : 'warn'}>{s.system.env}</Badge></dd></div>
          <div><dt className="text-muted">Demo mode</dt><dd><Badge tone={s.system.demo_enabled ? 'warn' : 'ok'}>{s.system.demo_enabled ? 'on' : 'off'}</Badge></dd></div>
          <div><dt className="text-muted">Rate limiting</dt><dd><Badge tone={s.system.rate_limit_enabled ? 'ok' : 'danger'}>{s.system.rate_limit_enabled ? 'on' : 'off'}</Badge></dd></div>
          <div><dt className="text-muted">Detection loop</dt><dd>{s.system.detection_interval_s ? `every ${s.system.detection_interval_s}s` : 'disabled'} · ranking model {s.system.forest_model_loaded ? 'loaded' : 'not loaded'}</dd></div>
        </dl>
      </Card>
      <Card className="space-y-3 p-4">
        <h2 className="font-semibold">Ledger maintenance</h2>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={audit}>Verify ledger chain</Button>
          <Button variant="danger" onClick={() => setErase(true)}>Erase expired personal data</Button>
        </div>
        {chain && <p role="status" className={`text-sm ${chain.startsWith('Chain intact') ? 'text-ok' : 'text-danger'}`}>{chain}</p>}
      </Card>
      <ConfirmDialog open={erase} danger title="Erase expired personal data?" confirmLabel="Erase"
        message="Encrypted KYC, itinerary and contact details of IDs whose visit has ended are permanently deleted. The ledger keeps only salted hashes. This cannot be undone."
        onConfirm={eraseNow} onCancel={() => setErase(false)} />
    </div>
  )
}

/* ------------------------------ Audit ------------------------------ */
function AuditTab() {
  const toast = useToast()
  const [action, setAction] = useState('')
  const [offset, setOffset] = useState(0)
  const [data, setData] = useState<{ total: number; items: AuditRow[] } | null>(null)

  useEffect(() => {
    api.get('/admin/audit', { params: { action: action || undefined, limit: PAGE, offset } }).then((r) => setData(r.data))
      .catch((e) => toast(errText(e, 'Could not load the audit log'), { kind: 'error' }))
  }, [action, offset, toast])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="w-56"><SelectInput label="Action" value={action} onChange={(e) => { setAction(e.target.value); setOffset(0) }}>
          <option value="">All actions</option>{AUDIT_ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
        </SelectInput></div>
        <Button variant="secondary" size="sm" onClick={async () => {
          try {
            const { data } = await api.get('/admin/audit.csv', { params: { action: action || undefined }, responseType: 'blob' })
            const url = URL.createObjectURL(data); const a = document.createElement('a'); a.href = url; a.download = 'audit-log.csv'; a.click(); URL.revokeObjectURL(url)
          } catch (e) { toast(errText(e, 'Could not export the audit log'), { kind: 'error' }) }
        }}>Export CSV</Button>
      </div>
      {!data ? <Skeleton className="h-40" /> : data.items.length === 0 ? <EmptyState title="No audit entries" hint="Sensitive actions (reveal, e-FIR, account changes) appear here." /> : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-sm">
            <thead><tr className="border-b text-left text-xs uppercase text-muted"><th className="p-3">Time</th><th>Action</th><th>By</th><th>Detail</th></tr></thead>
            <tbody>{data.items.map((a) => (
              <tr key={a.id} className="border-b last:border-0">
                <td className="whitespace-nowrap p-3 text-xs">{new Date(a.ts).toLocaleString()}</td>
                <td><Badge tone={a.action === 'reveal_pii' ? 'warn' : 'neutral'}>{a.action}</Badge></td>
                <td>{a.actor ?? '-'}</td><td className="text-xs text-muted">{a.detail}</td>
              </tr>))}</tbody>
          </table>
        </Card>
      )}
      {data && data.total > PAGE && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted">{offset + 1}-{Math.min(offset + PAGE, data.total)} of {data.total}</span>
          <div className="space-x-2">
            <Button size="sm" variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</Button>
            <Button size="sm" variant="secondary" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>Next</Button>
          </div>
        </div>
      )}
    </div>
  )
}

/* ------------------------------ Page ------------------------------ */
export default function Admin() {
  const [tab, setTab] = useState<'users' | 'system' | 'audit'>('users')
  return (
    <AppShell title="Administration">
      <div className="mb-4"><Tabs label="Admin sections" value={tab} onChange={setTab}
        tabs={[{ id: 'users', label: 'Users' }, { id: 'system', label: 'System' }, { id: 'audit', label: 'Audit log' }]} /></div>
      {tab === 'users' && <UsersTab />}
      {tab === 'system' && <SystemTab />}
      {tab === 'audit' && <AuditTab />}
    </AppShell>
  )
}
