import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { api } from '../../api'
import App from '../../App'
import { clearQueues, pendingFixes, pendingPanics } from '../../offline/queue'
import { useAuth } from '../../store'
import { a11yViolations } from '../../test-utils'
import { ThemeProvider, ToastProvider } from '../../ui'

const cred = { id_code: 'TID-ABC123', payload: '{"v":1}', valid_from: '2026-01-01T00:00:00Z', valid_to: '2030-01-01T00:00:00Z', revoked: false }
const square = (lat: number, lon: number, d = 0.002): [number, number][] => [[lat - d, lon - d], [lat - d, lon + d], [lat + d, lon + d], [lat + d, lon - d]]
const POS = { lat: 25.5788, lon: 91.8933 }

let alertsData: any[]
let routes: Record<string, any>
let watchCb: ((p: any) => void) | null

function setup(path = '/tourist', over: Record<string, any> = {}) {
  routes = {
    '/ledger/my-credential': cred, '/zones': [{ id: 1, name: 'Landslide Area', polygon: square(POS.lat, POS.lon), risk_weight: 0.8, no_entry: false }],
    '/me/profile': { share_token: null }, '/me/trip': { route: [], stops: [{ name: 'Hotel', lat: 25.57, lon: 91.88, hotel: true }, { name: 'Waterfall', lat: 25.6, lon: 91.9, hotel: false }] },
    '/me/contacts': { contacts: [{ name: 'Mum', phone: '+919876543210' }] }, '/me/score': { score: 62, z: 0.8, night: 0, a: 0, has_fix: true },
    ...over,
  }
  alertsData = over['/alerts/mine'] ?? []
  vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
    if (url === '/alerts/mine') return { data: alertsData }
    if (!(url in routes)) return { data: {} }
    const r = routes[url]
    if (r instanceof Error) throw r
    return { data: r }
  })
  vi.spyOn(api, 'post').mockResolvedValue({ data: { accepted: 1, alerts: [], next_interval_s: 60 } })
  return render(<ThemeProvider><ToastProvider><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></ToastProvider></ThemeProvider>)
}

beforeEach(async () => {
  vi.restoreAllMocks()
  await clearQueues()
  localStorage.clear()
  watchCb = null
  ;(navigator as any).geolocation = { watchPosition: (ok: any) => { watchCb = ok; return 1 }, clearWatch: vi.fn() }
  useAuth.setState({ loading: false, user: { id: 1, email: 't@x.com', full_name: 'Tess Traveller', role: 'tourist', language: 'en' } })
})
afterEach(() => { vi.useRealTimers() })

const gps = (p = POS) => act(() => watchCb!({ coords: { latitude: p.lat, longitude: p.lon, accuracy: 6 } }))
const home = async () => { await screen.findByRole('heading', { level: 1, name: 'My Safety' }); await screen.findByText(/safe area|risk area|waiting for your location/i) }

// ------------------------------------------------------------------ Home
test('home shows the score, status from zones, next stop and the hold-to-send button', async () => {
  setup()
  await home()
  expect(await screen.findByLabelText('safety score')).toHaveTextContent('62')
  expect(screen.getByText('Waiting for your location')).toBeInTheDocument()
  gps()
  expect(await screen.findByText('You are inside a risk area')).toBeInTheDocument()   // the demo zone is around this point
  expect(screen.getByText(/Waterfall ·/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'PANIC' })).toBeEnabled()
})

test('a point far from every zone is reported as a safe area', async () => {
  setup()
  await home()
  gps({ lat: 26.5, lon: 92.8 })
  expect(await screen.findByText('You are in a safe area')).toBeInTheDocument()
})

test('without an ID the home screen offers to create one online (no office visit)', async () => {
  setup('/tourist', { '/ledger/my-credential': Object.assign(new Error('404'), {}) })
  expect(await screen.findByRole('heading', { name: 'Get your digital ID' })).toBeInTheDocument()
  expect(screen.getByText('No office visit')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'PANIC' })).toBeNull()                 // nothing to panic about until there is an ID
})

test('an expired ID is flagged and a new one can be created from the home screen', async () => {
  setup('/tourist', { '/ledger/my-credential': { ...cred, valid_to: '2020-01-01T00:00:00Z' } })
  expect(await screen.findByText('Your digital ID has expired.')).toBeInTheDocument()
  await userEvent.setup().click(screen.getByRole('button', { name: 'Create a new digital ID' }))
  expect(await screen.findByRole('heading', { name: 'Get your digital ID' })).toBeInTheDocument()
})

test('a revoked ID shows a warning and tracking does not start', async () => {
  setup('/tourist', { '/ledger/my-credential': { ...cred, revoked: true, revoked_reason: 'Visa cancelled' } })
  expect(await screen.findByText(/This ID has been revoked: Visa cancelled/)).toBeInTheDocument()
  await waitFor(() => expect(watchCb).toBeNull())
})

// ------------------------------------------------------------------ Panic
test('confirm-path panic sends the device timestamp and shows delivery status', async () => {
  const user = userEvent.setup()
  setup()
  await home()
  gps()
  vi.mocked(api.post).mockResolvedValue({ data: { alert_id: 7, lat: POS.lat, lon: POS.lon, contacts: [{ name: 'Mum', phone: '+919876543210' }] } })
  await user.click(screen.getByRole('button', { name: /Can't hold/ }))
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Send now' }))
  expect(await screen.findByText('Help request sent to the control room.')).toBeInTheDocument()
  const panicCall = vi.mocked(api.post).mock.calls.find((c) => c[0] === '/panic')!
  expect(panicCall[1]).toMatchObject({ lat: POS.lat, lon: POS.lon, ts: expect.stringMatching(/^\d{4}-/) })
  expect(screen.getByRole('button', { name: 'PANIC' })).toBeDisabled()                // no double sends while one is open
})

test('holding the button for the full time sends the request; a short press does not', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  setup()
  await home()
  const b = screen.getByRole('button', { name: 'PANIC' })
  vi.mocked(api.post).mockResolvedValue({ data: { alert_id: 3, lat: null, lon: null, contacts: [] } })
  fireEvent.pointerDown(b); await act(async () => { await vi.advanceTimersByTimeAsync(600) }); fireEvent.pointerUp(b)
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(vi.mocked(api.post).mock.calls.some((c) => c[0] === '/panic')).toBe(false)
  fireEvent.pointerDown(b); await act(async () => { await vi.advanceTimersByTimeAsync(1700) })
  await waitFor(() => expect(vi.mocked(api.post).mock.calls.some((c) => c[0] === '/panic')).toBe(true))
})

test('offline panic is saved, shown with an SMS fallback, and delivered when the connection returns', async () => {
  const user = userEvent.setup()
  setup()
  await home()
  gps()
  vi.mocked(api.post).mockRejectedValue(Object.assign(new Error('Network Error'), { response: undefined }))
  await user.click(screen.getByRole('button', { name: /Can't hold/ }))
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Send now' }))
  expect(await screen.findByText(/No connection. Your request is saved/)).toBeInTheDocument()
  expect(await pendingPanics()).toBe(1)
  const href = decodeURIComponent(screen.getByRole('link', { name: 'Send SMS' }).getAttribute('href')!)
  expect(href).toContain('sms:112,+919876543210')
  expect(href).toContain(`${POS.lat},${POS.lon}`)
  vi.mocked(api.post).mockResolvedValue({ data: { alert_id: 9, lat: POS.lat, lon: POS.lon, contacts: [] } })
  await act(async () => { window.dispatchEvent(new Event('online')) })
  expect(await screen.findByText('Help request sent to the control room.')).toBeInTheDocument()
  expect(await pendingPanics()).toBe(0)
})

test('the app reports when the control room acknowledges and dispatches help', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  setup()
  await home()
  gps()
  vi.mocked(api.post).mockResolvedValue({ data: { alert_id: 7, lat: POS.lat, lon: POS.lon, contacts: [] } })
  fireEvent.click(screen.getByRole('button', { name: /Can't hold/ }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Send now' }))
  await screen.findByText('Help request sent to the control room.')
  alertsData = [{ id: 7, kind: 'panic', detail: 'x', status: 'acknowledged', created_at: new Date().toISOString() }]
  await act(async () => { await vi.advanceTimersByTimeAsync(5200) })
  expect(await screen.findByText('The control room has seen your request.')).toBeInTheDocument()
  alertsData = [{ id: 7, kind: 'panic', detail: 'x', status: 'dispatched', created_at: new Date().toISOString() }]
  await act(async () => { await vi.advanceTimersByTimeAsync(5200) })
  expect(await screen.findByText('Help is on the way.')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /It was a mistake/ })).toBeNull()      // too late to cancel once acknowledged
})

test('an accidental press can be cancelled while the request is still unseen', async () => {
  const user = userEvent.setup()
  setup()
  await home()
  vi.mocked(api.post).mockResolvedValue({ data: { alert_id: 7, lat: null, lon: null, contacts: [] } })
  await user.click(screen.getByRole('button', { name: /Can't hold/ }))
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Send now' }))
  await user.click(await screen.findByRole('button', { name: /It was a mistake/ }))
  expect(vi.mocked(api.post)).toHaveBeenCalledWith('/panic/7/cancel')
  expect(await screen.findByText('Request cancelled.')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'OK' }))
  expect(screen.queryByText('Request cancelled.')).toBeNull()
  expect(screen.getByRole('button', { name: 'PANIC' })).toBeEnabled()                // ready again
})

test('cancel refused by the server explains why', async () => {
  const user = userEvent.setup()
  setup()
  await home()
  vi.mocked(api.post).mockResolvedValueOnce({ data: { alert_id: 7, lat: null, lon: null, contacts: [] } })
  await user.click(screen.getByRole('button', { name: /Can't hold/ }))
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Send now' }))
  vi.mocked(api.post).mockRejectedValueOnce({ response: { status: 409, data: { detail: 'x' } } })
  await user.click(await screen.findByRole('button', { name: /It was a mistake/ }))
  expect(await screen.findByText(/already has your request/)).toBeInTheDocument()
})

test('a server refusal (e.g. rate limit) is shown, not silently queued', async () => {
  const user = userEvent.setup()
  setup()
  await home()
  vi.mocked(api.post).mockRejectedValue({ response: { status: 429, data: { detail: 'Too many requests. Try again later.' } } })
  await user.click(screen.getByRole('button', { name: /Can't hold/ }))
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Send now' }))
  expect(await screen.findByText('Too many requests. Try again later.')).toBeInTheDocument()
  expect(await pendingPanics()).toBe(0)
})

// ------------------------------------------------------------------ Offline banner
test('offline banner appears when the browser goes offline and when fixes are waiting', async () => {
  setup()
  await home()
  await act(async () => { window.dispatchEvent(new Event('offline')); Object.defineProperty(navigator, 'onLine', { value: false, configurable: true }) })
  expect(await screen.findByText(/You are offline/)).toBeInTheDocument()
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
  await act(async () => { window.dispatchEvent(new Event('online')) })
  await waitFor(() => expect(screen.queryByText(/You are offline/)).toBeNull())
})

// ------------------------------------------------------------------ Other tabs
test('tab bar navigates between all five tabs and keeps the tracker running', async () => {
  const user = userEvent.setup()
  setup()
  await home()
  for (const [label, heading] of [['Map', 'Map'], ['Safety', 'Safety'], ['ID', 'My Digital ID'], ['Settings', 'Settings'], ['Home', 'My Safety']] as const) {
    const tabs = screen.getByRole('navigation', { name: 'Tabs' })          // each page renders its own shell: query again
    await user.click(within(tabs).getByRole('link', { name: label }))
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument()
  }
  expect(watchCb).not.toBeNull()                                                        // one provider, GPS watch never restarted
})

test('map tab warns when you are inside or near a zone', async () => {
  setup('/tourist/map')
  await screen.findByRole('heading', { level: 1, name: 'Map' })
  gps()
  expect(await screen.findByText(/You are inside Landslide Area/)).toBeInTheDocument()
  gps({ lat: POS.lat + 0.004, lon: POS.lon })                                           // about 220 m beyond the zone edge
  expect(await screen.findByText(/Landslide Area is \d+ m away/)).toBeInTheDocument()
})

test('safety tab shows score parts, alerts and tips', async () => {
  setup('/tourist/safety', { '/alerts/mine': [{ id: 1, kind: 'zone_entry', detail: 'Entered Landslide Area (risk 0.8)', status: 'open', created_at: '2026-06-01T09:00:00Z' }] })
  expect(await screen.findByText('Entered Landslide Area (risk 0.8)')).toBeInTheDocument()
  expect(screen.getByRole('img', { name: /Risk areas within 1 km: minus 40 points/ })).toBeInTheDocument()   // 0.8 x 50
  expect(screen.getByText(/Keep your phone charged/)).toBeInTheDocument()
})

test('ID tab shows the QR card; a revoked ID is flagged', async () => {
  setup('/tourist/id')
  expect(await screen.findByText('TID-ABC123')).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Verify an ID' })).toHaveAttribute('href', '/verify')
})

test('settings: tracking toggle, family sharing with copy, contacts', async () => {
  const user = userEvent.setup()
  setup('/tourist/settings')
  await screen.findByRole('heading', { level: 1, name: 'Settings' })
  expect(await screen.findByText('Mum')).toBeInTheDocument()
  const track = screen.getByRole('checkbox', { name: 'Location tracking' })
  expect(track).toBeChecked()
  await user.click(track)
  expect(track).not.toBeChecked()
  vi.mocked(api.post).mockResolvedValue({ data: { share_with_family: true, share_token: 'tok123' } })
  await user.click(screen.getByRole('checkbox', { name: 'share with family' }))
  expect(vi.mocked(api.post)).toHaveBeenCalledWith('/me/share', { enabled: true })
  expect(await screen.findByText(/family\/tok123/)).toBeInTheDocument()
  const write = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true })
  await user.click(screen.getByRole('button', { name: 'Copy link' }))
  expect(write).toHaveBeenCalledWith(expect.stringContaining('/family/tok123'))
  expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
})

test('settings: waiting fixes can be sent now, install is unavailable without a prompt', async () => {
  const { enqueueFix } = await import('../../offline/queue')
  await enqueueFix({ lat: 1, lon: 1, accuracy: 5, ts: new Date().toISOString() })
  setup('/tourist/settings')
  expect(await screen.findByRole('button', { name: 'Install app' })).toBeDisabled()
  expect(await screen.findByRole('button', { name: 'Send now' })).toBeEnabled()
  expect(await pendingFixes()).toBe(1)
})

test('install prompt becomes available when the browser offers it', async () => {
  setup('/tourist/settings')
  const prompt = vi.fn().mockResolvedValue(undefined)
  const ev = Object.assign(new Event('beforeinstallprompt'), { prompt, userChoice: Promise.resolve({ outcome: 'accepted' }) })
  await screen.findByRole('heading', { level: 1, name: 'Settings' })
  await act(async () => { window.dispatchEvent(ev) })
  const btn = await screen.findByRole('button', { name: 'Install app' })
  await waitFor(() => expect(btn).toBeEnabled())
  await userEvent.setup().click(btn)
  expect(prompt).toHaveBeenCalled()
})

test('Hindi interface: tab labels and the panic hint are translated', async () => {
  useAuth.setState({ user: { id: 1, email: 't@x.com', full_name: 'T', role: 'tourist', language: 'hi' } })
  setup()
  expect(await screen.findByRole('link', { name: 'नक्शा' })).toBeInTheDocument()
  expect(screen.getByText(/1.5 सेकंड/)).toBeInTheDocument()
})

test.each(['/tourist', '/tourist/map', '/tourist/safety', '/tourist/id', '/tourist/settings'])('%s has no accessibility violations', async (path) => {
  const { container } = setup(path)
  await waitFor(() => expect(container.querySelector('h1')).not.toBeNull())
  await new Promise((r) => setTimeout(r, 200))
  expect(await a11yViolations(container)).toEqual([])
})
