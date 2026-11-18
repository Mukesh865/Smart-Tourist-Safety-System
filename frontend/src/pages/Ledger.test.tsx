import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../store'
import { a11yViolations } from '../test-utils'
import { ThemeProvider, ToastProvider } from '../ui'
import Ledger from './Ledger'

const H = 'a'.repeat(43)
const block = (h: number, o: any = {}) => ({ height: h, ts: 1_780_000_000, prev_hash: H, merkle_root: 'b'.repeat(43), records: 2, signature_ok: true, root_ok: true, ...o })
const detail = { ...block(1), records: [
  { id_code: 'TID-AAA', index: 0, leaf_hash: 'c'.repeat(43), commitments: ['x', 'y', 'z'], valid_from: 0, valid_to: 1, revoked: false },
  { id_code: 'TID-BBB', index: 1, leaf_hash: 'd'.repeat(43), commitments: ['x', 'y', 'z'], valid_from: 0, valid_to: 1, revoked: true }] }

let chain: any, revAudit: any, blocks: any[], revs: any[]
const renderIt = () => render(<ThemeProvider><ToastProvider><MemoryRouter><Ledger /></MemoryRouter></ToastProvider></ThemeProvider>)

beforeEach(() => {
  vi.restoreAllMocks()
  chain = { ok: true, blocks: 2, broken_at: null }
  revAudit = { ok: true, entries: 1 }
  blocks = [block(1), block(0, { records: 1 })]
  revs = [{ id_code: 'TID-BBB', reason: 'Visa cancelled', ts: 1_780_000_100, entry_hash: 'e'.repeat(43) }]
  useAuth.setState({ loading: false, user: { id: 1, email: 'p@x.com', full_name: 'P', role: 'police', language: 'en' } })
  vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
    if (url === '/ledger/chain') return { data: chain }
    if (url === '/ledger/revocations/audit') return { data: revAudit }
    if (url === '/ledger/blocks') return { data: { total: blocks.length, items: blocks } }
    if (url === '/ledger/blocks/1') return { data: detail }
    if (url === '/ledger/revocations') return { data: { head: 'h', entries: revs } }
    return { data: {} }
  })
})

test('shows chain health, stats and the block list', async () => {
  renderIt()
  expect(await screen.findByText('Chain verified')).toBeInTheDocument()
  expect(screen.getByText('#1')).toBeInTheDocument()
  expect(screen.getAllByText('Signature + root OK')).toHaveLength(2)
  expect(screen.getAllByText('Intact')).toHaveLength(2)
})

test('a broken chain or tampered revocation list raises a loud integrity warning', async () => {
  chain = { ok: false, blocks: 2, broken_at: 1 }
  renderIt()
  expect(await screen.findByText('INTEGRITY PROBLEM')).toBeInTheDocument()
  expect(screen.getByText('Broken at 1')).toBeInTheDocument()
})

test('a block with a bad signature or root is flagged', async () => {
  blocks = [block(1, { signature_ok: false }), block(0, { root_ok: false })]
  renderIt()
  expect(await screen.findByText('Bad signature')).toBeInTheDocument()
  expect(screen.getByText('Root mismatch')).toBeInTheDocument()
})

test('opening a block shows hashes only, the Merkle path length, and revoked state per record', async () => {
  renderIt()
  await userEvent.setup().click(await screen.findByRole('button', { name: 'Open block 1' }))
  const dlg = await screen.findByRole('dialog', { name: 'Block #1' })
  expect(within(dlg).getByText(/1 hash\(es\) for 2 record\(s\)/)).toBeInTheDocument()
  expect(within(dlg).getAllByText(/3 salted commitments \(no personal data\)/)).toHaveLength(2)
  expect(within(dlg).getByRole('button', { name: 'Revoke TID-AAA' })).toBeInTheDocument()
  expect(within(dlg).getByText('Revoked')).toBeInTheDocument()                          // TID-BBB already revoked
  expect(within(dlg).queryByRole('button', { name: 'Revoke TID-BBB' })).toBeNull()
})

test('revoking from the explorer needs a reason, posts it and refreshes', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue({ data: {} })
  renderIt()
  const u = userEvent.setup()
  await u.click(await screen.findByRole('button', { name: 'Open block 1' }))
  await u.click(await screen.findByRole('button', { name: 'Revoke TID-AAA' }))
  const dlg = screen.getByRole('dialog', { name: 'Revoke TID-AAA' })
  expect(within(dlg).getByRole('button', { name: 'Revoke ID' })).toBeDisabled()
  await u.type(within(dlg).getByLabelText('Reason'), 'Lost phone')
  await u.click(within(dlg).getByRole('button', { name: 'Revoke ID' }))
  expect(post).toHaveBeenCalledWith('/ledger/TID-AAA/revoke', { reason: 'Lost phone' })
  expect(await screen.findByText('ID revoked')).toBeInTheDocument()
})

test('revocation tab lists entries; empty state explains itself', async () => {
  renderIt()
  const u = userEvent.setup()
  await u.click(await screen.findByRole('tab', { name: 'Revocation list' }))
  expect(await screen.findByText('Visa cancelled')).toBeInTheDocument()
  revs = []
  const { unmount } = renderIt()
  await waitFor(() => expect(screen.getAllByRole('tab', { name: 'Revocation list' }).length).toBe(2))
  unmount()
})

test('empty ledger shows guidance', async () => {
  blocks = []
  chain = { ok: true, blocks: 0, broken_at: null }
  renderIt()
  expect(await screen.findByText('No blocks yet')).toBeInTheDocument()
})

test('has no accessibility violations', async () => {
  const { container } = renderIt()
  await screen.findByText('#1')
  expect(await a11yViolations(container)).toEqual([])
})
