import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, test, vi } from 'vitest'
import { api } from '../../api'
import { a11yViolations } from '../../test-utils'
import { ThemeProvider, ToastProvider } from '../../ui'
import ApplyId from './ApplyId'
import { TouristProvider } from './TouristContext'

const cred = { id_code: 'TID-NEW', payload: '{}', valid_from: '2026-01-01T00:00:00Z', valid_to: '2030-01-01T00:00:00Z', revoked: false, verification: 'self_declared' }
let credCalls: number

function renderIt() {
  credCalls = 0
  vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
    if (url === '/ledger/my-credential') { credCalls += 1; if (credCalls === 1) throw { response: { status: 404 } }; return { data: cred } }
    if (url === '/zones') return { data: [] }
    if (url === '/alerts/mine') return { data: [] }
    return { data: {} }
  })
  ;(navigator as any).geolocation = { watchPosition: () => 1, clearWatch: vi.fn() }
  return render(<ThemeProvider><ToastProvider><MemoryRouter><TouristProvider><ApplyId /></TouristProvider></MemoryRouter></ToastProvider></ThemeProvider>)
}

beforeEach(() => { vi.restoreAllMocks() })

async function fillAll(u: ReturnType<typeof userEvent.setup>) {
  await u.type(screen.getByLabelText('Passport number'), 'P-1234567')
  await u.type(screen.getByLabelText('Contact 1 name'), 'Mum')
  await u.type(screen.getByLabelText('Contact 1 phone'), '+919876543210')
}

test('the create button stays disabled until every part is filled and the declaration is ticked', async () => {
  const u = userEvent.setup()
  renderIt()
  const btn = await screen.findByRole('button', { name: 'Create my digital ID' })
  expect(btn).toBeDisabled()
  await fillAll(u)
  expect(btn).toBeDisabled()                                       // still needs the declaration
  await u.click(screen.getByRole('checkbox', { name: /I confirm these details are true/ }))
  expect(btn).toBeEnabled()
})

test('submitting sends the details, then loads the new credential', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { id_code: 'TID-NEW', payload: '{}', verification: 'self_declared' } })
  const u = userEvent.setup()
  renderIt()
  await screen.findByRole('button', { name: 'Create my digital ID' })
  await u.selectOptions(screen.getByLabelText('Document type'), 'Aadhaar')
  await u.type(screen.getByLabelText('Aadhaar number'), '1111 2222 3333')
  await u.type(screen.getByLabelText('Contact 1 name'), 'Mum')
  await u.type(screen.getByLabelText('Contact 1 phone'), '+919876543210')
  await u.click(screen.getByRole('checkbox', { name: /I confirm/ }))
  await u.click(screen.getByRole('button', { name: 'Create my digital ID' }))
  expect(post).toHaveBeenCalledWith('/ledger/apply', expect.objectContaining({
    kyc_number: '1111 2222 3333', declaration: true, contacts: [{ name: 'Mum', phone: '+919876543210' }],
    stops: [expect.objectContaining({ hotel: true })], valid_from: expect.stringMatching(/T00:00:00Z$/), valid_to: expect.stringMatching(/T23:59:59Z$/),
  }))
  await waitFor(() => expect(credCalls).toBeGreaterThanOrEqual(2))               // the credential was reloaded
  expect(await screen.findByText('Your digital ID is ready')).toBeInTheDocument()
})

test('server refusals are shown in plain words and the form stays filled', async () => {
  vi.spyOn(api, 'post').mockRejectedValue({ response: { data: { detail: 'A valid digital ID already exists for this identity document.' } } })
  const u = userEvent.setup()
  renderIt()
  await screen.findByRole('button', { name: 'Create my digital ID' })
  await fillAll(u)
  await u.click(screen.getByRole('checkbox', { name: /I confirm/ }))
  await u.click(screen.getByRole('button', { name: 'Create my digital ID' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('already exists for this identity document')
  expect(screen.getByLabelText('Passport number')).toHaveValue('P-1234567')
})

test('validation messages from the server are shown without technical prefixes', async () => {
  vi.spyOn(api, 'post').mockRejectedValue({ response: { data: { detail: [{ msg: 'Value error, A digital ID can be issued for at most 90 days at a time' }] } } })
  const u = userEvent.setup()
  renderIt()
  await screen.findByRole('button', { name: 'Create my digital ID' })
  await fillAll(u)
  await u.click(screen.getByRole('checkbox', { name: /I confirm/ }))
  await u.click(screen.getByRole('button', { name: 'Create my digital ID' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(/^A digital ID can be issued for at most 90 days/)
})

test('a second contact can be added and removed; end before start is flagged and blocks submit', async () => {
  const u = userEvent.setup()
  renderIt()
  await screen.findByRole('button', { name: 'Create my digital ID' })
  await u.click(screen.getByRole('button', { name: 'Add another contact' }))
  expect(screen.getByLabelText('Contact 2 name')).toBeInTheDocument()
  await u.click(screen.getByRole('button', { name: 'Remove' }))
  expect(screen.queryByLabelText('Contact 2 name')).toBeNull()
  const to = screen.getByLabelText('Valid to')
  await u.clear(to)
  await u.type(to, '2000-01-01')
  expect(screen.getByText('Must be on or after the start date')).toBeInTheDocument()
  await fillAll(u)
  await u.click(screen.getByRole('checkbox', { name: /I confirm/ }))
  expect(screen.getByRole('button', { name: 'Create my digital ID' })).toBeDisabled()
})

test('has no accessibility violations', async () => {
  const { container } = renderIt()
  await screen.findByRole('button', { name: 'Create my digital ID' })
  expect(await a11yViolations(container)).toEqual([])
})
