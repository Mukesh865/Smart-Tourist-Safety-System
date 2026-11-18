import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import App from './App'
import { api } from './api'
import { useAuth } from './store'

function renderAt(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>)
}
const asRole = (role: 'tourist' | 'officer' | 'police') =>
  useAuth.setState({ loading: false, user: { id: 1, email: 'x@x.com', full_name: 'X', role, language: 'en' } })

beforeEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  useAuth.setState({ user: null, loading: true })
})

test('unauthenticated users are sent to the login form', async () => {
  renderAt('/dashboard')
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument())
})

test('register page shows name field', async () => {
  renderAt('/register')
  await waitFor(() => expect(screen.getByLabelText(/full name/i)).toBeInTheDocument())
})

test('tourist cannot open the police dashboard', async () => {
  asRole('tourist')
  vi.spyOn(api, 'get').mockRejectedValue({})
  renderAt('/dashboard')
  await waitFor(() => expect(screen.getByRole('heading', { name: 'My Safety' })).toBeInTheDocument())
})

test('police can open the dashboard', async () => {
  asRole('police')
  renderAt('/dashboard')
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Police Dashboard' })).toBeInTheDocument())
})

test('verify page shows valid and invalid results', async () => {
  const post = vi.spyOn(api, 'post')
  post.mockResolvedValueOnce({ data: { valid: true, merkle_ok: true, signature_ok: true, in_validity: true, reason: '', id_code: 'TID-OK' } })
  renderAt('/verify')
  const u = userEvent.setup()
  await u.type(await screen.findByPlaceholderText(/paste the QR text/i), 'abc')
  await u.click(screen.getByRole('button', { name: 'Verify' }))
  await waitFor(() => expect(screen.getByText('VALID ID')).toBeInTheDocument())

  post.mockResolvedValueOnce({ data: { valid: false, merkle_ok: false, signature_ok: true, in_validity: true, reason: 'Merkle proof does not match block root', id_code: 'TID-X' } })
  await u.click(screen.getByRole('button', { name: 'Verify' }))
  await waitFor(() => expect(screen.getByText('NOT VALID')).toBeInTheDocument())
  expect(screen.getByText(/merkle proof does not match/i)).toBeInTheDocument()
})
