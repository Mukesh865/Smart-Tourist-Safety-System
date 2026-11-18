import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { api } from '../api'
import DemoPanel from './DemoPanel'

beforeEach(() => vi.restoreAllMocks())

test('hidden when the server has demo mode disabled', async () => {
  vi.spyOn(api, 'get').mockRejectedValue({ response: { status: 404 } })
  const { container } = render(<DemoPanel />)
  await new Promise((r) => setTimeout(r, 30))
  expect(container).toBeEmptyDOMElement()
})

test('seeds, runs a scenario for the chosen tourist, and reports the alert kinds', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ data: { scenarios: ['normal', 'dropoff'] } })
  const post = vi.spyOn(api, 'post').mockImplementation(async (url: string) => {
    if (url === '/demo/seed') return { data: { users_created: 3, zones_created: 2, demo_login: { emails: ['demo1@tourist.local'], password: 'Demo@12345' } } }
    return { data: { alerts: [{ kind: 'dropoff' }] } }
  })
  const onDone = vi.fn()
  render(<DemoPanel onDone={onDone} />)
  const u = userEvent.setup()
  await u.click(await screen.findByText('Demo mode (simulated tourists)'))
  await u.click(screen.getByRole('button', { name: 'Seed demo data' }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Seeded: 3 tourists, 2 zones'))
  await u.selectOptions(screen.getByLabelText('demo tourist'), 'demo2@tourist.local')
  await u.click(screen.getByRole('button', { name: 'Signal drop-off' }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Signal drop-off: dropoff'))
  expect(post).toHaveBeenLastCalledWith('/demo/scenario', { scenario: 'dropoff', email: 'demo2@tourist.local' })
  expect(onDone).toHaveBeenCalledTimes(2)
})

test('shows "no alert" for the normal scenario and surfaces server errors', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ data: { scenarios: ['normal'] } })
  const post = vi.spyOn(api, 'post').mockResolvedValueOnce({ data: { alerts: [] } })
  render(<DemoPanel />)
  const u = userEvent.setup()
  await u.click(await screen.findByText('Demo mode (simulated tourists)'))
  await u.click(screen.getByRole('button', { name: 'Normal walk (no alert)' }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('no alert'))
  post.mockRejectedValueOnce({ response: { data: { detail: 'Demo tourists not seeded yet.' } } })
  await u.click(screen.getByRole('button', { name: 'Normal walk (no alert)' }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('not seeded yet'))
})
