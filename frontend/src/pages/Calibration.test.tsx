import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, test, vi } from 'vitest'
import { api } from '../api'
import { useAuth } from '../store'
import { a11yViolations } from '../test-utils'
import { ThemeProvider, ToastProvider } from '../ui'
import Calibration from './Calibration'

const defaults = { r1_minutes: 20, r2_still_min: 40, r2_dist_m: 200, r2_anywhere_min: 150, r3_km: 1, r3_minutes: 10, cooldown_min: 60, geo_k: 3, geo_buffer_m: 20, warn_ring_m: 50, night_start: 20, night_end: 5 }
const bounds = Object.fromEntries(Object.keys(defaults).map((k) => [k, { min: k === 'r1_minutes' ? 5 : 1, max: 500 }]))
const payload = (values = defaults) => ({ values, defaults, bounds })
const sr = (o = {}) => ({ recall: 0.99, precision: 1, fa_per_100: 0, kinds: { dropoff: { recall: 1, median_delay: 20 }, inactivity: { recall: 0.98, median_delay: 100 }, deviation: { recall: 1, median_delay: 13 } }, ...o })
const whatif = { candidate: { matched: sr({ fa_per_100: 0 }), shifted: sr({ fa_per_100: 20 }) }, defaults: { matched: sr(), shifted: sr({ fa_per_100: 50 }) }, geo: { candidate: 0.1, defaults: 0.5 }, note: 'Simulated.' }

const renderIt = () => render(<ThemeProvider><ToastProvider><MemoryRouter><Calibration /></MemoryRouter></ToastProvider></ThemeProvider>)
beforeEach(() => {
  vi.restoreAllMocks()
  useAuth.setState({ loading: false, user: { id: 1, email: 'a@x.com', full_name: 'A', role: 'admin', language: 'en' } })
  vi.spyOn(api, 'get').mockResolvedValue({ data: payload() })
})

test('shows every setting with its paper default and no unsaved-change state', async () => {
  renderIt()
  expect(await screen.findByLabelText('No location for more than')).toHaveValue(20)
  expect(screen.getAllByText(/Paper default: 20 min/).length).toBeGreaterThan(0)
  expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled()
})

test('editing marks the field as changed, enables save and clears any preview', async () => {
  const u = userEvent.setup()
  renderIt()
  const field = await screen.findByLabelText('No location for more than')
  await u.clear(field); await u.type(field, '45')
  expect(screen.getByText('changed')).toBeInTheDocument()
  expect(screen.getByText('You have unsaved changes.')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Save settings' })).toBeEnabled()
})

test('out-of-range values are flagged and block saving and previewing', async () => {
  const u = userEvent.setup()
  renderIt()
  const field = await screen.findByLabelText('No location for more than')
  await u.clear(field); await u.type(field, '1')
  expect(await screen.findByRole('alert')).toHaveTextContent('Between 5 and 500')
  expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled()
  expect(screen.getByRole('button', { name: /Preview effect/ })).toBeDisabled()
  await u.clear(field)
  expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled()          // empty is invalid too
})

test('save sends all values and confirms', async () => {
  const put = vi.spyOn(api, 'put').mockResolvedValue({ data: payload({ ...defaults, r1_minutes: 45 }) })
  const u = userEvent.setup()
  renderIt()
  const field = await screen.findByLabelText('No location for more than')
  await u.clear(field); await u.type(field, '45')
  await u.click(screen.getByRole('button', { name: 'Save settings' }))
  expect(put).toHaveBeenCalledWith('/admin/settings', expect.objectContaining({ r1_minutes: 45, geo_k: 3 }))
  expect(await screen.findByText(/Settings saved/)).toBeInTheDocument()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled())
})

test('the preview compares your settings with the paper defaults', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue({ data: whatif })
  const u = userEvent.setup()
  renderIt()
  await u.click(await screen.findByRole('button', { name: /Preview effect/ }))
  const res = await screen.findByLabelText('Preview result')
  expect(post).toHaveBeenCalledWith('/admin/settings/whatif', expect.objectContaining({ r1_minutes: 20 }), expect.anything())
  expect(within(res).getAllByText('better').length).toBeGreaterThan(0)             // fewer false alerts on the shifted days
  expect(within(res).getByText(/0.10/)).toBeInTheDocument()
})

test('preview and save errors are shown', async () => {
  vi.spyOn(api, 'post').mockRejectedValue({ response: { data: { detail: 'r1_minutes must be between 5 and 240' } } })
  const u = userEvent.setup()
  renderIt()
  await u.click(await screen.findByRole('button', { name: /Preview effect/ }))
  expect(await screen.findByRole('alert')).toHaveTextContent('r1_minutes must be between 5 and 240')
})

test('reset asks first, then restores the defaults', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue({ data: payload() })
  const u = userEvent.setup()
  renderIt()
  await u.click(await screen.findByRole('button', { name: 'Reset to paper defaults' }))
  expect(post).not.toHaveBeenCalled()
  await u.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reset' }))
  expect(post).toHaveBeenCalledWith('/admin/settings/reset')
})

test('has no accessibility violations', async () => {
  const { container } = renderIt()
  await screen.findByLabelText('No location for more than')
  expect(await a11yViolations(container)).toEqual([])
})
