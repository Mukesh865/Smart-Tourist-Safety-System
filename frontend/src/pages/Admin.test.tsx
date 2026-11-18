import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../store'
import { a11yViolations } from '../test-utils'
import { ThemeProvider, ToastProvider } from '../ui'
import Admin from './Admin'

const mk = (o: any = {}) => ({ id: 2, email: 'p@x.com', full_name: 'Pat Police', role: 'police', disabled: false, id_code: null, created_at: '2026-01-01T00:00:00Z', ...o })
const stats = {
  users_by_role: { tourist: 3, officer: 1, police: 1, admin: 1 }, disabled_users: 1, alerts_by_status: { open: 2 }, open_incidents: 1,
  ledger_blocks: 4, ids_issued: 4, system: { env: 'dev', demo_enabled: true, rate_limit_enabled: true, detection_interval_s: 60, forest_model_loaded: false },
}
const audit = { total: 1, items: [{ id: 1, ts: '2026-01-01T10:00:00Z', action: 'reveal_pii', actor: 'Pat Police', detail: 'TID-1', tourist_id: 1 }] }

let users: any[]
function mockGets() {
  return vi.spyOn(api, 'get').mockImplementation(async (url: string, cfg?: any) => {
    if (url === '/admin/users') {
      const q = (cfg?.params?.q ?? '').toLowerCase()
      const items = users.filter((u) => !q || u.email.includes(q) || u.full_name.toLowerCase().includes(q))
      return { data: { total: items.length, items } }
    }
    if (url === '/admin/stats') return { data: stats }
    if (url === '/admin/audit') return { data: audit }
    if (url === '/ledger/chain') return { data: { ok: true, blocks: 4, broken_at: null } }
    return { data: {} }
  })
}

const renderIt = () => render(<ThemeProvider><ToastProvider><MemoryRouter><Admin /></MemoryRouter></ToastProvider></ThemeProvider>)

beforeEach(() => {
  vi.restoreAllMocks()
  users = [mk(), mk({ id: 3, email: 't@x.com', full_name: 'Tess Tourist', role: 'tourist', id_code: 'TID-AAA' })]
  useAuth.setState({ loading: false, user: { id: 1, email: 'admin@tourist.local', full_name: 'Admin', role: 'admin', language: 'en' } })
})

describe('Users tab', () => {
  test('lists users with role, status and ID code', async () => {
    mockGets()
    renderIt()
    expect(await screen.findByText('Pat Police')).toBeInTheDocument()
    expect(screen.getByText('TID-AAA')).toBeInTheDocument()
    expect(screen.getAllByText('Active')).toHaveLength(2)
  })

  test('search is sent to the server after a short pause', async () => {
    const get = mockGets()
    renderIt()
    await screen.findByText('Pat Police')
    await userEvent.setup().type(screen.getByLabelText('Search name or email'), 'tess')
    await waitFor(() => expect(screen.queryByText('Pat Police')).toBeNull())
    expect(screen.getByText('Tess Tourist')).toBeInTheDocument()
    expect(get.mock.calls.some((c) => (c[1] as any)?.params?.q === 'tess')).toBe(true)
  })

  test('shows an empty state when nothing matches', async () => {
    mockGets()
    renderIt()
    await screen.findByText('Pat Police')
    await userEvent.setup().type(screen.getByLabelText('Search name or email'), 'zzz')
    expect(await screen.findByText('No users match')).toBeInTheDocument()
  })

  test('changing a role patches the user and confirms', async () => {
    mockGets()
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })
    renderIt()
    await screen.findByText('Pat Police')
    await userEvent.setup().selectOptions(screen.getByLabelText('Role for p@x.com'), 'officer')
    expect(patch).toHaveBeenCalledWith('/admin/users/2', { role: 'officer' })
    expect(await screen.findByText('Role changed to officer')).toBeInTheDocument()
  })

  test('disable asks for confirmation first, cancel does nothing', async () => {
    mockGets()
    const patch = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })
    renderIt()
    await screen.findByText('Pat Police')
    const u = userEvent.setup()
    const row = screen.getByText('Pat Police').closest('tr')!
    await u.click(within(row).getByRole('button', { name: 'Disable' }))
    expect(screen.getByRole('dialog', { name: 'Disable account?' })).toBeInTheDocument()
    await u.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(patch).not.toHaveBeenCalled()
    await u.click(within(row).getByRole('button', { name: 'Disable' }))
    await u.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Disable' }))
    expect(patch).toHaveBeenCalledWith('/admin/users/2', { disabled: true })
  })

  test('reset password shows the temporary password once', async () => {
    mockGets()
    vi.spyOn(api, 'post').mockResolvedValue({ data: { temporary_password: 'Zx9-temp-pass' } })
    renderIt()
    await screen.findByText('Pat Police')
    const u = userEvent.setup()
    await u.click(within(screen.getByText('Pat Police').closest('tr')!).getByRole('button', { name: 'Reset password' }))
    await u.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reset' }))
    expect(await screen.findByLabelText('temporary password')).toHaveTextContent('Zx9-temp-pass')
    await u.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByText('Zx9-temp-pass')).toBeNull()
  })

  test('server refusal (last admin) is shown as an error toast', async () => {
    mockGets()
    vi.spyOn(api, 'patch').mockRejectedValue({ response: { data: { detail: 'At least one active administrator must remain' } } })
    renderIt()
    await screen.findByText('Pat Police')
    const u = userEvent.setup()
    await u.click(within(screen.getByText('Pat Police').closest('tr')!).getByRole('button', { name: 'Disable' }))
    await u.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Disable' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('At least one active administrator must remain')
  })

  test('create staff account posts the form and reloads', async () => {
    const get = mockGets()
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: {} })
    renderIt()
    await screen.findByText('Pat Police')
    const u = userEvent.setup()
    await u.click(screen.getByRole('button', { name: 'Add staff account' }))
    const dlg = screen.getByRole('dialog', { name: 'Add staff account' })
    await u.type(within(dlg).getByLabelText('Full name'), 'New Officer')
    await u.type(within(dlg).getByLabelText('Email'), 'new@x.com')
    await u.type(within(dlg).getByLabelText('Initial password'), 'password123')
    await u.click(within(dlg).getByRole('button', { name: 'Create account' }))
    expect(post).toHaveBeenCalledWith('/auth/staff', { full_name: 'New Officer', email: 'new@x.com', password: 'password123', role: 'officer' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(get.mock.calls.filter((c) => c[0] === '/admin/users').length).toBeGreaterThan(1)
  })

  test('duplicate email error stays inside the dialog', async () => {
    mockGets()
    vi.spyOn(api, 'post').mockRejectedValue({ response: { data: { detail: 'Email already registered' } } })
    renderIt()
    await screen.findByText('Pat Police')
    const u = userEvent.setup()
    await u.click(screen.getByRole('button', { name: 'Add staff account' }))
    const dlg = screen.getByRole('dialog')
    await u.type(within(dlg).getByLabelText('Full name'), 'X')
    await u.type(within(dlg).getByLabelText('Email'), 'dup@x.com')
    await u.type(within(dlg).getByLabelText('Initial password'), 'password123')
    await u.click(within(dlg).getByRole('button', { name: 'Create account' }))
    expect(await within(dlg).findByRole('alert')).toHaveTextContent('Email already registered')
  })

  test('has no accessibility violations', async () => {
    mockGets()
    const { container } = renderIt()
    await screen.findByText('Pat Police')
    expect(await a11yViolations(container)).toEqual([])
  })
})

describe('System tab', () => {
  async function openSystem() {
    mockGets()
    renderIt()
    await userEvent.setup().click(screen.getByRole('tab', { name: 'System' }))
  }

  test('shows statistics and configuration flags', async () => {
    await openSystem()
    expect(await screen.findByText('IDs issued')).toBeInTheDocument()
    expect(screen.getByText('disabled: 1')).toBeInTheDocument()
    expect(screen.getByText('every 60s', { exact: false })).toBeInTheDocument()
  })

  test('ledger chain audit reports an intact chain', async () => {
    await openSystem()
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Verify ledger chain' }))
    expect(await screen.findByText('Chain intact: 4 block(s) verified')).toBeInTheDocument()
  })

  test('a broken chain is reported loudly', async () => {
    await openSystem()
    ;(api.get as any).mockImplementation(async (url: string) => (url === '/ledger/chain' ? { data: { ok: false, blocks: 4, broken_at: 2 } } : { data: stats }))
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Verify ledger chain' }))
    expect(await screen.findByText('CHAIN BROKEN at block 2')).toBeInTheDocument()
  })

  test('erasing personal data needs explicit confirmation', async () => {
    await openSystem()
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { erased: 3 } })
    const u = userEvent.setup()
    await u.click(await screen.findByRole('button', { name: 'Erase expired personal data' }))
    expect(post).not.toHaveBeenCalled()
    await u.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Erase' }))
    expect(post).toHaveBeenCalledWith('/ledger/erase-expired')
    expect(await screen.findByText('Erased personal data for 3 expired ID(s)')).toBeInTheDocument()
  })
})

describe('Audit tab', () => {
  test('lists entries and filters by action', async () => {
    const get = mockGets()
    renderIt()
    const u = userEvent.setup()
    await u.click(screen.getByRole('tab', { name: 'Audit log' }))
    expect(await screen.findByText('Pat Police')).toBeInTheDocument()       // actor column (the action name is also a filter option)
    expect(screen.getByRole('cell', { name: 'reveal_pii' })).toBeInTheDocument()
    await u.selectOptions(screen.getByLabelText('Action'), 'efir')
    await waitFor(() => expect(get.mock.calls.some((c) => c[0] === '/admin/audit' && (c[1] as any)?.params?.action === 'efir')).toBe(true))
  })
})
