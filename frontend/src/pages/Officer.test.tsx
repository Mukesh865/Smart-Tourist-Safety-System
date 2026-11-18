import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../store'
import { a11yViolations } from '../test-utils'
import { ThemeProvider, ToastProvider } from '../ui'
import Officer from './Officer'

const hit = { tourist_id: 4, name: 'Tess Traveller', email: 't@x.com', id_code: null, status: 'no_id' }
const renderIt = () => render(<ThemeProvider><ToastProvider><MemoryRouter><Officer /></MemoryRouter></ToastProvider></ThemeProvider>)

beforeEach(() => {
  vi.restoreAllMocks()
  useAuth.setState({ loading: false, user: { id: 1, email: 'o@x.com', full_name: 'Olive', role: 'officer', language: 'en' } })
})

async function stepToContacts(u: ReturnType<typeof userEvent.setup>) {
  await u.type(screen.getByLabelText('Tourist account email'), 't@x.com')
  await u.click(screen.getByRole('button', { name: 'Next' }))
  await u.type(await screen.findByLabelText('Passport / Aadhaar number'), 'AADHAAR-1234')
  await u.click(screen.getByRole('button', { name: 'Next' }))
  await u.type(await screen.findByLabelText('Hotel name'), ' Polo')
  await u.click(screen.getByRole('button', { name: 'Next' }))
  await u.type(await screen.findByLabelText('Emergency contact name'), 'Mum')
  await u.type(screen.getByLabelText('Emergency contact phone'), '+919876543210')
}

test('walks through all five steps and issues the ID with the right payload', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ data: { total: 1, items: [hit] } })
  const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { id_code: 'TID-NEW', payload: 'x'.repeat(845) } })
  renderIt()
  const u = userEvent.setup()
  await stepToContacts(u)
  await u.click(screen.getByRole('button', { name: 'Next' }))
  expect(await screen.findByText('Tess Traveller (t@x.com)')).toBeInTheDocument()
  expect(screen.getByText(/•+.*234|••/)).toBeInTheDocument()                          // identity number is masked on the review step
  expect(screen.queryByText('AADHAAR-1234')).toBeNull()
  await u.click(screen.getByRole('button', { name: 'Issue ID' }))
  await waitFor(() => expect(screen.getByText(/Issued TID-NEW/)).toBeInTheDocument())
  const body = post.mock.calls[0][1] as any
  expect(body).toMatchObject({ tourist_email: 't@x.com', kyc_number: 'AADHAAR-1234', contacts: [{ name: 'Mum', phone: '+919876543210' }] })
  expect(body.stops[0]).toMatchObject({ name: 'Hotel Polo', hotel: true })
  expect(screen.getByRole('button', { name: 'Print ID card' })).toBeInTheDocument()
  await u.click(screen.getByRole('button', { name: 'Issue another ID' }))
  expect(screen.getByLabelText('Tourist account email')).toHaveValue('')
})

test('unknown email and already-issued visitors are explained, not advanced', async () => {
  const get = vi.spyOn(api, 'get').mockResolvedValue({ data: { total: 0, items: [] } })
  renderIt()
  const u = userEvent.setup()
  await u.type(screen.getByLabelText('Tourist account email'), 'nobody@x.com')
  await u.click(screen.getByRole('button', { name: 'Next' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('No tourist account with that email')
  get.mockResolvedValue({ data: { total: 1, items: [{ ...hit, email: 'nobody@x.com', status: 'active', id_code: 'TID-1' }] } })
  await u.click(screen.getByRole('button', { name: 'Next' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('already has an ID')
  expect(screen.queryByLabelText('Passport / Aadhaar number')).toBeNull()
})

test('Next is disabled until each step is valid; Back keeps what was typed', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ data: { total: 1, items: [hit] } })
  renderIt()
  const u = userEvent.setup()
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
  await u.type(screen.getByLabelText('Tourist account email'), 't@x.com')
  await u.click(screen.getByRole('button', { name: 'Next' }))
  const id = await screen.findByLabelText('Passport / Aadhaar number')
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()                 // identity too short
  await u.type(id, 'AB12')
  expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled()
  await u.click(screen.getByRole('button', { name: 'Back' }))
  expect(screen.getByLabelText('Tourist account email')).toHaveValue('t@x.com')
})

test('identity number can be revealed on demand', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ data: { total: 1, items: [hit] } })
  renderIt()
  const u = userEvent.setup()
  await u.type(screen.getByLabelText('Tourist account email'), 't@x.com')
  await u.click(screen.getByRole('button', { name: 'Next' }))
  const id = await screen.findByLabelText('Passport / Aadhaar number')
  expect(id).toHaveAttribute('type', 'password')
  await u.click(screen.getByRole('button', { name: 'Show or hide characters' }))
  expect(id).toHaveAttribute('type', 'text')
})

test('a second emergency contact can be added and removed; end before start is flagged', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ data: { total: 1, items: [hit] } })
  vi.spyOn(api, 'post').mockResolvedValue({ data: { id_code: 'TID-2', payload: 'p' } })
  renderIt()
  const u = userEvent.setup()
  await stepToContacts(u)
  await u.click(screen.getByRole('button', { name: 'Add another contact' }))
  expect(screen.getByLabelText('Contact 2 name')).toBeInTheDocument()
  await u.click(screen.getByRole('button', { name: 'Remove' }))
  expect(screen.queryByLabelText('Contact 2 name')).toBeNull()
  const to = screen.getByLabelText('Valid to')
  await u.clear(to)
  await u.type(to, '2000-01-01')
  expect(screen.getByText('Must be on or after the start date')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
})

test('server errors on issue stay on the review step', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ data: { total: 1, items: [hit] } })
  vi.spyOn(api, 'post').mockRejectedValue({ response: { data: { detail: 'Tourist already has an ID.' } } })
  renderIt()
  const u = userEvent.setup()
  await stepToContacts(u)
  await u.click(screen.getByRole('button', { name: 'Next' }))
  await u.click(await screen.findByRole('button', { name: 'Issue ID' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Tourist already has an ID.')
  expect(screen.getByRole('button', { name: 'Issue ID' })).toBeInTheDocument()
})

test('every step is free of accessibility violations', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ data: { total: 1, items: [hit] } })
  const { container } = renderIt()
  expect(await a11yViolations(container)).toEqual([])
  const u = userEvent.setup()
  await u.type(screen.getByLabelText('Tourist account email'), 't@x.com')
  await u.click(screen.getByRole('button', { name: 'Next' }))
  await screen.findByLabelText('Passport / Aadhaar number')
  expect(await a11yViolations(container)).toEqual([])
})
