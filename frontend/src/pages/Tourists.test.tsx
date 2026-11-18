import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { api } from '../api'
import { useAuth, type Role } from '../store'
import { a11yViolations } from '../test-utils'
import { ThemeProvider, ToastProvider } from '../ui'
import Tourists from './Tourists'

const row = (o: any = {}) => ({ tourist_id: 1, name: 'Tess Traveller', email: 't@x.com', id_code: 'TID-AAA', valid_from: '2026-01-01T00:00:00Z', valid_to: '2030-01-01T00:00:00Z', status: 'active', ...o })
let rows: any[]

const renderAs = (role: Role) => {
  useAuth.setState({ loading: false, user: { id: 1, email: 'x@x.com', full_name: 'X', role, language: 'en' } })
  return render(<ThemeProvider><ToastProvider><MemoryRouter><Tourists /></MemoryRouter></ToastProvider></ThemeProvider>)
}

beforeEach(() => {
  vi.restoreAllMocks()
  rows = [row(), row({ tourist_id: 2, name: 'Rex Revoked', email: 'r@x.com', id_code: 'TID-BBB', status: 'revoked' }),
    row({ tourist_id: 3, name: 'Nina New', email: 'n@x.com', id_code: null, status: 'no_id', valid_to: null })]
  vi.spyOn(api, 'get').mockImplementation(async (url: string, cfg?: any) => {
    if (url === '/tourists') {
      const q = (cfg?.params?.q ?? '').toLowerCase(); const st = cfg?.params?.status
      const items = rows.filter((r) => (!q || r.name.toLowerCase().includes(q)) && (!st || r.status === st))
      return { data: { total: items.length, items } }
    }
    if (url === '/tourists/1/credential') return { data: { id_code: 'TID-AAA', name: 'Tess Traveller', payload: '{"v":1}', valid_from: '2026-01-01T00:00:00Z', valid_to: '2030-01-01T00:00:00Z', revoked: false } }
    if (url === '/tourists/1') return { data: { itinerary: { route: [[25.5, 91.8], [25.6, 91.9]], stops: [{ name: 'Hotel', lat: 25.5, lon: 91.8, hotel: true }] } } }
    return { data: {} }
  })
})

test('lists tourists with status badges', async () => {
  renderAs('officer')
  expect(await screen.findByText('Tess Traveller')).toBeInTheDocument()
  const table = within(screen.getByRole('table'))          // the same words also appear on the filter chips
  expect(table.getByText('Active')).toBeInTheDocument()
  expect(table.getByText('Revoked')).toBeInTheDocument()
  expect(table.getByText('No ID yet')).toBeInTheDocument()
})

test('status filter chips query the server and show a pressed state', async () => {
  renderAs('officer')
  await screen.findByText('Tess Traveller')
  await userEvent.setup().click(screen.getByRole('button', { name: 'Revoked' }))
  await waitFor(() => expect(screen.queryByText('Tess Traveller')).toBeNull())
  expect(screen.getByText('Rex Revoked')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Revoked', pressed: true })).toBeInTheDocument()
})

test('search narrows the list and an empty result shows guidance', async () => {
  renderAs('officer')
  await screen.findByText('Tess Traveller')
  await userEvent.setup().type(screen.getByLabelText('Search name, email or ID code'), 'zzzz')
  expect(await screen.findByText('No tourists match')).toBeInTheDocument()
})

test('officers can extend and edit itineraries but not revoke; admins can revoke', async () => {
  const { unmount } = renderAs('officer')
  await screen.findByText('Tess Traveller')
  expect(screen.getByRole('button', { name: 'Extend ID for Tess Traveller' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Itinerary for Tess Traveller' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /Revoke ID of/ })).toBeNull()
  expect(screen.queryByRole('button', { name: /Extend ID for Rex/ })).toBeNull()      // revoked IDs cannot be extended
  unmount()
  renderAs('admin')
  expect(await screen.findByRole('button', { name: 'Revoke ID of Tess Traveller' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Revoke ID of Rex Revoked' })).toBeNull()
})

test('ID card opens with the credential and a print button', async () => {
  renderAs('officer')
  await userEvent.setup().click(await screen.findByRole('button', { name: 'ID card for Tess Traveller' }))
  const dlg = await screen.findByRole('dialog', { name: 'Digital tourist ID' })
  expect(within(dlg).getByText('TID-AAA')).toBeInTheDocument()
  expect(within(dlg).getByRole('button', { name: 'Print ID card' })).toBeInTheDocument()
})

test('extend posts the new end date, reloads, and shows the new ID card', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { id_code: 'TID-NEW', payload: '{"v":1}', previous: 'TID-AAA' } })
  renderAs('officer')
  const u = userEvent.setup()
  await u.click(await screen.findByRole('button', { name: 'Extend ID for Tess Traveller' }))
  const dlg = screen.getByRole('dialog', { name: /Extend ID/ })
  await u.click(within(dlg).getByRole('button', { name: 'Extend' }))
  expect(post).toHaveBeenCalledWith('/tourists/1/renew', { valid_to: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T23:59:59Z$/) })
  expect(await screen.findByText('TID-NEW')).toBeInTheDocument()
})

test('extend failure for erased data shows the server explanation', async () => {
  vi.spyOn(api, 'post').mockRejectedValue({ response: { data: { detail: 'The original details were erased after the visit ended. Register the visitor again at the entry point.' } } })
  renderAs('officer')
  const u = userEvent.setup()
  await u.click(await screen.findByRole('button', { name: 'Extend ID for Tess Traveller' }))
  await u.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Extend' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('erased after the visit ended')
})

test('itinerary editor loads the saved stops and saves changes', async () => {
  const put = vi.spyOn(api, 'put').mockResolvedValue({ data: {} })
  renderAs('officer')
  const u = userEvent.setup()
  await u.click(await screen.findByRole('button', { name: 'Itinerary for Tess Traveller' }))
  const dlg = await screen.findByRole('dialog', { name: /Itinerary for/ })
  const name = within(dlg).getByLabelText('Stop 1 name')
  expect(name).toHaveValue('Hotel')
  await u.clear(name)
  await u.type(name, 'Grand Hotel')
  await u.click(within(dlg).getByRole('button', { name: 'Save itinerary' }))
  expect(put).toHaveBeenCalledWith('/tourists/1/itinerary', expect.objectContaining({ stops: [expect.objectContaining({ name: 'Grand Hotel', hotel: true })] }))
})

test('admin revoke requires a reason and posts it', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue({ data: {} })
  renderAs('admin')
  const u = userEvent.setup()
  await u.click(await screen.findByRole('button', { name: 'Revoke ID of Tess Traveller' }))
  const dlg = screen.getByRole('dialog')
  expect(within(dlg).getByRole('button', { name: 'Revoke ID' })).toBeDisabled()
  await u.type(within(dlg).getByLabelText('Reason'), 'Reported stolen')
  await u.click(within(dlg).getByRole('button', { name: 'Revoke ID' }))
  expect(post).toHaveBeenCalledWith('/ledger/TID-AAA/revoke', { reason: 'Reported stolen' })
})

test('has no accessibility violations', async () => {
  const { container } = renderAs('admin')
  await screen.findByText('Tess Traveller')
  expect(await a11yViolations(container)).toEqual([])
})
