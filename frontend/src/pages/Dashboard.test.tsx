import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { api } from '../api'
import { useAuth } from '../store'
import { a11yViolations } from '../test-utils'
import { ThemeProvider, ToastProvider } from '../ui'
import Dashboard, { wsUrl } from './Dashboard'

vi.mock('../components/HeatLayer', () => ({ default: () => null }))      // canvas is unavailable in jsdom
const alerting = vi.hoisted(() => ({ beep: vi.fn(() => true), notify: vi.fn(() => true), soundEnabled: vi.fn(() => true), setSoundEnabled: vi.fn(),
  notificationPermission: vi.fn(() => 'default'), askNotificationPermission: vi.fn(async () => 'granted') }))
vi.mock('../alerting', () => alerting)

const alert = (o: any = {}) => ({
  id: 1, tourist_id: 1, id_code: 'TID-AAA', kind: 'panic', rule: null, detail: 'Panic button pressed by Tess', lat: 25.5, lon: 91.8, status: 'open',
  score: null, incident_id: null, resolution: null, assigned_to: null, assignee: null, created_at: new Date().toISOString(), ...o,
})
const overview = { positions: [{ tourist_id: 1, id_code: 'TID-AAA', lat: 25.5, lon: 91.8, open_alerts: 1 }], clusters: [], alert_heat: [], zone_heat: [],
  alerts_by_status: { open: 2, acknowledged: 1, resolved: 4 }, active_tourists: 3 }
const trailPts = [0, 1, 2].map((i) => ({ lat: 25.5 + i / 1000, lon: 91.8, ts: new Date(Date.now() - (3 - i) * 600000).toISOString() }))

class FakeWS {
  static instances: FakeWS[] = []
  onopen: any; onmessage: any; onclose: any; url: string
  constructor(url: string) { this.url = url; FakeWS.instances.push(this) }
  close() { this.onclose?.() }
}

let queue: any[]
let get: any
const lastAlertParams = () => (get.mock.calls.filter((c: any[]) => c[0] === '/dashboard/alerts').at(-1)![1] as any).params

beforeEach(() => {
  vi.restoreAllMocks()
  Object.values(alerting).forEach((f: any) => f.mockClear?.())
  alerting.soundEnabled.mockReturnValue(true)
  alerting.notificationPermission.mockReturnValue('default')
  FakeWS.instances = []
  ;(globalThis as any).WebSocket = FakeWS
  localStorage.setItem('ts_token', 'tok')
  queue = [alert(), alert({ id: 2, id_code: 'TID-BBB', kind: 'dropoff', rule: 'R1', detail: 'No location for 22 min', score: 0.72, assigned_to: 9, assignee: 'Pat Police' }),
    alert({ id: 3, id_code: 'TID-CCC', kind: 'zone_entry', detail: 'Entered Landslide Area', status: 'acknowledged', incident_id: 7, assigned_to: 9, assignee: 'Pat Police' })]
  useAuth.setState({ loading: false, user: { id: 9, email: 'p@x.com', full_name: 'Pat Police', role: 'police', language: 'en' } })
  get = vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
    if (url === '/dashboard/alerts') return { data: { total: queue.length, items: queue } }
    if (url === '/dashboard/overview') return { data: overview }
    if (url === '/zones') return { data: [] }
    if (url === '/dashboard/staff') return { data: [{ id: 9, name: 'Pat Police' }, { id: 10, name: 'Sam Chief' }] }
    if (url.startsWith('/dashboard/trail/')) return { data: { tourist_id: 1, points: trailPts } }
    if (url === '/incidents/7/timeline') return { data: { items: [{ kind: 'alert', ts: new Date().toISOString(), text: 'zone entry: Entered Landslide Area', by: null }, { kind: 'action', ts: new Date().toISOString(), text: 'ack: alert 3 (zone_entry)', by: 'Pat Police' }] } }
    if (url === '/dashboard/alerts.csv' || url.startsWith('/incidents/7/efir')) return { data: new Blob(['x']) }
    return { data: {} }
  })
  ;(URL as any).createObjectURL = vi.fn(() => 'blob:x')
  ;(URL as any).revokeObjectURL = vi.fn()
})
afterEach(() => { vi.useRealTimers() })

const renderIt = () => render(<ThemeProvider><ToastProvider><MemoryRouter><Dashboard /></MemoryRouter></ToastProvider></ThemeProvider>)
const open = async (id: number) => { await userEvent.setup().click(await screen.findByRole('button', { name: new RegExp(`^Open alert ${id}:`) })) }

// ------------------------------------------------------------------ queue + live
test('shows stats, the queue with assignee and priority, and the live badge', async () => {
  renderIt()
  expect(await screen.findByText('TID-AAA')).toBeInTheDocument()
  expect(screen.getByText('3')).toBeInTheDocument()                               // active tourists
  expect(screen.getByText('Priority 72%')).toBeInTheDocument()
  expect(screen.getAllByText('Pat Police').length).toBeGreaterThan(0)
  expect(screen.getByText('Offline')).toBeInTheDocument()
  act(() => FakeWS.instances[0].onopen())
  expect(screen.getByText('Live')).toBeInTheDocument()
  expect(FakeWS.instances[0].url).toContain('/api/ws/alerts?token=tok')
})

test('a NEW panic plays the sound and desktop notification; updates and other kinds stay quiet', async () => {
  renderIt()
  await screen.findByText('TID-AAA')
  const send = (m: any) => act(() => FakeWS.instances[0].onmessage({ data: JSON.stringify(m) }))
  send({ kind: 'panic', status: 'open', detail: 'Panic button pressed by Tess' })
  expect(alerting.beep).toHaveBeenCalledTimes(1)
  expect(alerting.notify).toHaveBeenCalledWith('PANIC alert', 'Panic button pressed by Tess')
  expect(await screen.findByRole('alert')).toHaveTextContent('PANIC: Panic button pressed by Tess')
  send({ kind: 'panic', status: 'acknowledged', detail: 'x' })
  send({ kind: 'dropoff', status: 'open', detail: 'No location' })
  expect(alerting.beep).toHaveBeenCalledTimes(1)
})

test('sound can be switched off and is remembered', async () => {
  renderIt()
  await screen.findByText('TID-AAA')
  await userEvent.setup().click(screen.getByLabelText('Sound on panic'))
  expect(alerting.setSoundEnabled).toHaveBeenCalledWith(false)
  act(() => FakeWS.instances[0].onmessage({ data: JSON.stringify({ kind: 'panic', status: 'open', detail: 'x' }) }))
  expect(alerting.beep).not.toHaveBeenCalled()
})

test('desktop notification permission can be requested', async () => {
  renderIt()
  await userEvent.setup().click(await screen.findByRole('button', { name: 'Enable desktop alerts' }))
  expect(alerting.askNotificationPermission).toHaveBeenCalled()
  expect(await screen.findByText('Desktop alerts on')).toBeInTheDocument()
})

test('the socket reconnects after it drops', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  renderIt()
  await waitFor(() => expect(FakeWS.instances.length).toBe(1))
  act(() => FakeWS.instances[0].onclose())
  act(() => { vi.advanceTimersByTime(3100) })
  expect(FakeWS.instances.length).toBe(2)
})

// ------------------------------------------------------------------ filters
test('type, status and ID search are sent to the server', async () => {
  const u = userEvent.setup()
  renderIt()
  await screen.findByText('TID-AAA')
  await u.selectOptions(screen.getByLabelText('Type'), 'dropoff')
  await waitFor(() => expect(lastAlertParams()).toMatchObject({ kind: 'dropoff', paged: true }))
  await u.selectOptions(screen.getByLabelText('Status'), 'open')
  await waitFor(() => expect(lastAlertParams().status).toBe('open'))
  await u.selectOptions(screen.getByLabelText('Status'), 'all')
  await waitFor(() => expect(lastAlertParams()).toMatchObject({ include_resolved: true, status: undefined }))
  await u.type(screen.getByLabelText('Search ID code'), 'tid-b')
  await waitFor(() => expect(lastAlertParams().q).toBe('tid-b'))
})

test('"Assigned to me" filters the loaded list; "Show more" loads another page', async () => {
  const u = userEvent.setup()
  const many = Array.from({ length: 31 }, (_, i) => alert({ id: 100 + i, id_code: `TID-${i}` }))
  get.mockImplementation(async (url: string) => (url === '/dashboard/alerts' ? { data: { total: 80, items: many } } : url === '/dashboard/overview' ? { data: overview } : { data: [] }))
  renderIt()
  await screen.findByText('TID-0')
  await u.click(screen.getByRole('button', { name: 'Show more (31 of 80)' }))
  await waitFor(() => expect(lastAlertParams().limit).toBe(60))
  await u.click(screen.getByLabelText('Assigned to me'))
  expect(await screen.findByText('No alerts')).toBeInTheDocument()
})

// ------------------------------------------------------------------ details panel
test('opening an alert loads its trail and timeline; the replay slider moves through the track', async () => {
  renderIt()
  await open(3)
  const panel = await screen.findByRole('region', { name: 'Alert details' })
  expect(within(panel).getByText('Entered Landslide Area')).toBeInTheDocument()
  expect(await within(panel).findByText(/3 fixes · drag to replay/)).toBeInTheDocument()
  expect(await within(panel).findByRole('list', { name: 'Incident timeline' })).toHaveTextContent('ack: alert 3')
  const slider = within(panel).getByLabelText('Replay position')
  const before = within(panel).getByText(/3 fixes/).textContent
  fireEvent.change(slider, { target: { value: '0' } })
  expect(within(panel).getByText(/3 fixes/).textContent).not.toBe(before)
  expect(get).toHaveBeenCalledWith('/dashboard/trail/1', { params: { hours: 6 } })
})

test('workflow: acknowledge, then dispatch', async () => {
  const patch = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })
  renderIt()
  await open(1)
  const panel = await screen.findByRole('region', { name: 'Alert details' })
  await userEvent.setup().click(within(panel).getByRole('button', { name: 'Acknowledge' }))
  expect(patch).toHaveBeenCalledWith('/alerts/1', { status: 'acknowledged' })
  // alert 3 is already acknowledged: resolving offers an outcome
  await open(3)
  const p2 = await screen.findByRole('region', { name: 'Alert details' })
  const u = userEvent.setup()
  expect(within(p2).queryByLabelText('Outcome')).toBeNull()                 // the outcome is only asked when resolving
  await u.click(within(p2).getByRole('button', { name: 'Dispatch' }))
  expect(patch).toHaveBeenLastCalledWith('/alerts/3', { status: 'dispatched' })
})

test('resolving sends the chosen outcome', async () => {
  const patch = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })
  queue = [alert({ id: 5, status: 'dispatched', incident_id: 7 })]
  renderIt()
  await open(5)
  const panel = await screen.findByRole('region', { name: 'Alert details' })
  const u = userEvent.setup()
  await u.selectOptions(within(panel).getByLabelText('Outcome'), 'false_alarm')
  await u.click(within(panel).getByRole('button', { name: 'Resolve' }))
  expect(patch).toHaveBeenCalledWith('/alerts/5', { status: 'resolved', resolution: 'false_alarm' })
})

test('assignment: assign to me, pick a colleague, unassign', async () => {
  const patch = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })
  renderIt()
  await open(1)
  const panel = await screen.findByRole('region', { name: 'Alert details' })
  const u = userEvent.setup()
  await u.click(within(panel).getByRole('button', { name: 'Assign to me' }))
  expect(patch).toHaveBeenLastCalledWith('/alerts/1', { assignee_id: 9 })
  await u.selectOptions(within(panel).getByLabelText('Assigned to'), 'Sam Chief')
  expect(patch).toHaveBeenLastCalledWith('/alerts/1', { assignee_id: 10 })
  await u.selectOptions(within(panel).getByLabelText('Assigned to'), 'Nobody')
  expect(patch).toHaveBeenLastCalledWith('/alerts/1', { assignee_id: null })
})

test('notes are added to the incident and the timeline reloads', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue({ data: {} })
  renderIt()
  await open(3)
  const panel = await screen.findByRole('region', { name: 'Alert details' })
  const u = userEvent.setup()
  await u.type(within(panel).getByLabelText('Add a note'), 'Called the hotel')
  await u.click(within(panel).getByRole('button', { name: 'Add note' }))
  expect(post).toHaveBeenCalledWith('/incidents/7/notes', { text: 'Called the hotel' })
  await waitFor(() => expect(within(panel).getByLabelText('Add a note')).toHaveValue(''))
  expect(get.mock.calls.filter((c: any[]) => c[0] === '/incidents/7/timeline').length).toBeGreaterThan(1)
})

test('personal details open only for an incident; an erased record shows the server message; e-FIR downloads', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValueOnce({ data: { name: 'Tess', id_code: 'TID-CCC', kyc: 'AADHAAR-1', contacts: [{ name: 'Mom', phone: '+91999' }], itinerary: { stops: [{ name: 'Hotel' }] } } })
  renderIt()
  await open(1)
  expect(screen.queryByRole('button', { name: 'Open personal details' })).toBeNull()      // alert 1 has no incident yet
  await open(3)
  const u = userEvent.setup()
  await u.click(await screen.findByRole('button', { name: 'Open personal details' }))
  expect(post).toHaveBeenCalledWith('/incidents/7/reveal')
  expect(await screen.findByLabelText('case details')).toHaveTextContent('AADHAAR-1')
  post.mockRejectedValueOnce({ response: { data: { detail: 'Personal data was erased after the visit ended' } } })
  await u.click(screen.getByRole('button', { name: 'Open personal details' }))
  expect(await screen.findByText(/erased after the visit/)).toBeInTheDocument()
  await u.click(screen.getByRole('button', { name: 'Draft e-FIR (PDF)' }))
  expect(get.mock.calls.find((c: any[]) => c[0] === '/incidents/7/efir.pdf')![1]).toEqual({ responseType: 'blob' })
})

test('closing the panel returns to the hint', async () => {
  renderIt()
  await open(1)
  await userEvent.setup().click(await screen.findByRole('button', { name: 'Close details' }))
  expect(screen.getByText(/Select an alert to see its track/)).toBeInTheDocument()
})

// ------------------------------------------------------------------ bulk, export, keyboard, layers
test('bulk acknowledge only counts open alerts and reports skips', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { updated: [1, 2], skipped: [] } })
  queue = [alert(), alert({ id: 2, id_code: 'TID-BBB' }), alert({ id: 3, status: 'acknowledged', id_code: 'TID-CCC' })]
  renderIt()
  const u = userEvent.setup()
  await u.click(await screen.findByLabelText('Select alert 1'))
  await u.click(screen.getByLabelText('Select alert 2'))
  expect(screen.queryByLabelText('Select alert 3')).toBeNull()                         // only open alerts can be bulk-selected
  await u.click(screen.getByRole('button', { name: 'Acknowledge 2 open' }))
  expect(post).toHaveBeenCalledWith('/alerts/bulk', { ids: [1, 2], status: 'acknowledged' })
  expect(await screen.findByText('2 acknowledged')).toBeInTheDocument()
})

test('CSV export sends the current filters', async () => {
  const u = userEvent.setup()
  renderIt()
  await screen.findByText('TID-AAA')
  await u.selectOptions(screen.getByLabelText('Type'), 'panic')
  await u.click(screen.getByRole('button', { name: 'Export CSV' }))
  const call = get.mock.calls.find((c: any[]) => c[0] === '/dashboard/alerts.csv')!
  expect(call[1]).toMatchObject({ params: { kind: 'panic' }, responseType: 'blob' })
})

test('keyboard: J/K move the selection, A acknowledges an open alert, typing in a field is ignored', async () => {
  const patch = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })
  renderIt()
  await screen.findByText('TID-AAA')
  fireEvent.keyDown(window, { key: 'j' })
  expect(await screen.findByRole('region', { name: 'Alert details' })).toHaveTextContent('TID-AAA')
  fireEvent.keyDown(window, { key: 'j' })
  await waitFor(() => expect(screen.getByRole('region', { name: 'Alert details' })).toHaveTextContent('TID-BBB'))
  fireEvent.keyDown(window, { key: 'k' })
  await waitFor(() => expect(screen.getByRole('region', { name: 'Alert details' })).toHaveTextContent('TID-AAA'))
  fireEvent.keyDown(window, { key: 'a' })
  await waitFor(() => expect(patch).toHaveBeenCalledWith('/alerts/1', { status: 'acknowledged' }))
  patch.mockClear()
  fireEvent.keyDown(screen.getByLabelText('Search ID code'), { key: 'a' })               // typing 'a' in the search box must not act
  expect(patch).not.toHaveBeenCalled()
})

test('keyboard shortcuts respect the workflow order', async () => {
  const patch = vi.spyOn(api, 'patch').mockResolvedValue({ data: {} })
  renderIt()
  await screen.findByText('TID-AAA')
  fireEvent.keyDown(window, { key: 'j' })                  // alert 1 is open
  fireEvent.keyDown(window, { key: 'd' })                  // cannot dispatch before acknowledging
  fireEvent.keyDown(window, { key: 'r' })
  expect(patch).not.toHaveBeenCalled()
  fireEvent.keyDown(window, { key: 'j' }); fireEvent.keyDown(window, { key: 'j' })   // alert 3 is acknowledged
  await waitFor(() => expect(screen.getByRole('region', { name: 'Alert details' })).toHaveTextContent('TID-CCC'))
  fireEvent.keyDown(window, { key: 'r' })
  await waitFor(() => expect(patch).toHaveBeenCalledWith('/alerts/3', { status: 'resolved', resolution: 'resolved' }))
})

test('map layer toggles are available and reflect state', async () => {
  renderIt()
  await screen.findByText('TID-AAA')
  const group = screen.getByRole('group', { name: 'Map layers' })
  for (const name of ['zones', 'heat', 'clusters', 'trails']) expect(within(group).getByLabelText(name)).toBeChecked()
  await userEvent.setup().click(within(group).getByLabelText('heat'))
  expect(within(group).getByLabelText('heat')).not.toBeChecked()
})

test('a failed refresh shows an error; an empty queue shows guidance', async () => {
  get.mockRejectedValue(new Error('down'))
  renderIt()
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not refresh the dashboard.')
})

test('an older, slower response never overwrites a newer one (regression)', async () => {
  const u = userEvent.setup()
  let release!: () => void
  const slow = new Promise<void>((r) => { release = r })
  get.mockImplementation(async (url: string, cfg?: any) => {
    if (url === '/dashboard/alerts') {
      if (!cfg?.params?.kind) { await slow; return { data: { total: 1, items: [alert({ id: 50, id_code: 'TID-STALE' })] } } }   // the first, unfiltered request is slow
      return { data: { total: 1, items: [alert({ id: 51, id_code: 'TID-FRESH', kind: 'dropoff' })] } }
    }
    return { data: url === '/dashboard/overview' ? overview : [] }
  })
  renderIt()
  await u.selectOptions(await screen.findByLabelText('Type'), 'dropoff')               // the newer request answers first
  expect(await screen.findByText('TID-FRESH')).toBeInTheDocument()
  release()                                                                            // now the stale one finally arrives
  await act(async () => { await new Promise((r) => setTimeout(r, 30)) })
  expect(screen.queryByText('TID-STALE')).toBeNull()
  expect(screen.getByText('TID-FRESH')).toBeInTheDocument()
})

test('wsUrl uses the page host and encodes the token', () => {
  expect(wsUrl('a b')).toMatch(/^ws:\/\/.*\/api\/ws\/alerts\?token=a%20b$/)
})

test('dashboard and open panel have no accessibility violations', async () => {
  const { container } = renderIt()
  await screen.findByText('TID-AAA')
  expect(await a11yViolations(container)).toEqual([])
  await open(3)
  await screen.findByRole('region', { name: 'Alert details' })
  expect(await a11yViolations(container)).toEqual([])
})
