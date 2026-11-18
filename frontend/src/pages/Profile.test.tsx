import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { api, TOKEN_KEY } from '../api'
import { useAuth } from '../store'
import { a11yViolations } from '../test-utils'
import { ThemeProvider, ToastProvider } from '../ui'
import Profile from './Profile'

const renderIt = () => render(<ThemeProvider><ToastProvider><MemoryRouter><Profile /></MemoryRouter></ToastProvider></ThemeProvider>)

beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  localStorage.setItem(TOKEN_KEY, 'old-token')
  document.documentElement.classList.remove('dark')
  useAuth.setState({ loading: false, user: { id: 1, email: 't@x.com', full_name: 'Tess', role: 'tourist', language: 'en' } })
})

async function fill(cur: string, pw: string, pw2: string) {
  const u = userEvent.setup()
  await u.type(screen.getByLabelText('Current password'), cur)
  await u.type(screen.getByLabelText('New password'), pw)
  await u.type(screen.getByLabelText('Repeat new password'), pw2)
  await u.click(screen.getByRole('button', { name: 'Update password' }))
}

test('shows the account details', () => {
  renderIt()
  expect(screen.getByText('Tess')).toBeInTheDocument()
  expect(screen.getByText('t@x.com')).toBeInTheDocument()
})

test('mismatching new passwords are rejected without calling the server', async () => {
  const post = vi.spyOn(api, 'post')
  renderIt()
  await fill('password123', 'newpassword1', 'newpassword2')
  expect(await screen.findAllByText(/do(es)? not match/i)).not.toHaveLength(0)
  expect(post).not.toHaveBeenCalled()
})

test('successful change stores the fresh token and clears the form', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { access_token: 'fresh-token' } })
  renderIt()
  await fill('password123', 'newpassword1', 'newpassword1')
  expect(post).toHaveBeenCalledWith('/auth/change-password', { current_password: 'password123', new_password: 'newpassword1' })
  await waitFor(() => expect(localStorage.getItem(TOKEN_KEY)).toBe('fresh-token'))
  expect(await screen.findByText(/other devices were signed out/i)).toBeInTheDocument()
  expect(screen.getByLabelText('Current password')).toHaveValue('')
})

test('wrong current password shows the server message and keeps the old token', async () => {
  vi.spyOn(api, 'post').mockRejectedValue({ response: { data: { detail: 'Current password is incorrect' } } })
  renderIt()
  await fill('nope-nope', 'newpassword1', 'newpassword1')
  expect(await screen.findByRole('alert')).toHaveTextContent('Current password is incorrect')
  expect(localStorage.getItem(TOKEN_KEY)).toBe('old-token')
})

test('theme choice is applied and persisted', async () => {
  renderIt()
  await userEvent.setup().selectOptions(screen.getByLabelText('Theme'), 'dark')
  expect(document.documentElement).toHaveClass('dark')
  expect(localStorage.getItem('ts_theme')).toBe('dark')
})

test('language change is saved to the account', async () => {
  const put = vi.spyOn(api, 'put').mockResolvedValue({ data: {} })
  renderIt()
  const field = screen.getAllByLabelText('Language').find((e) => e.tagName === 'SELECT')!
  await userEvent.setup().selectOptions(field, 'hi')
  expect(put).toHaveBeenCalledWith('/me/language', { language: 'hi' })
  expect(useAuth.getState().user?.language).toBe('hi')
})

test('sign out everywhere confirms, calls the API and clears the session', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { ok: true } })
  renderIt()
  const u = userEvent.setup()
  await u.click(screen.getByRole('button', { name: 'Sign out of all devices' }))
  expect(post).not.toHaveBeenCalled()                                  // asks first
  await u.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Sign out of all devices' }))
  expect(post).toHaveBeenCalledWith('/auth/logout-all')
  await waitFor(() => expect(useAuth.getState().user).toBeNull())
  expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
})

test('has no accessibility violations', async () => {
  const { container } = renderIt()
  expect(await a11yViolations(container)).toEqual([])
})
