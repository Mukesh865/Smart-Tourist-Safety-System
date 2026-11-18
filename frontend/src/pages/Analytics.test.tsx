import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, expect, test, vi } from 'vitest'
import { api } from '../api'
import { useAuth } from '../store'
import { a11yViolations } from '../test-utils'
import { ThemeProvider, ToastProvider } from '../ui'
import Analytics, { fmtDuration } from './Analytics'

const summary = (o: any = {}) => ({
  days: 14, total_alerts: 11,
  per_day: [{ date: '2026-06-01', panic: 1, movement: 2, zone: 3 }, { date: '2026-06-02', panic: 0, movement: 4, zone: 1 }],
  response: { median_ack_s: 75, median_resolve_s: 640, n_ack: 9, n_resolved: 7 },
  rules: [
    { kind: 'dropoff', total: 6, open: 1, genuine: 2, false_alarm: 3, cancelled: 0, judged: 5, false_alarm_ratio: 0.6 },
    { kind: 'panic', total: 3, open: 0, genuine: 2, false_alarm: 0, cancelled: 1, judged: 2, false_alarm_ratio: 0 },
    { kind: 'zone_entry', total: 2, open: 2, genuine: 0, false_alarm: 0, cancelled: 0, judged: 0, false_alarm_ratio: null },
  ],
  zones: [{ zone_id: 1, name: 'Cliff Edge', count: 4 }, { zone_id: 2, name: 'River Bank', count: 2 }],
  active_tourists: [{ date: '2026-06-01', count: 5 }, { date: '2026-06-02', count: 7 }],
  ...o,
})

let get: any
const renderIt = () => render(<ThemeProvider><ToastProvider><MemoryRouter><Analytics /></MemoryRouter></ToastProvider></ThemeProvider>)

beforeEach(() => {
  vi.restoreAllMocks()
  useAuth.setState({ loading: false, user: { id: 1, email: 'p@x.com', full_name: 'P', role: 'police', language: 'en' } })
  get = vi.spyOn(api, 'get').mockResolvedValue({ data: summary() })
})

test('duration formatting', () => {
  expect(fmtDuration(null)).toBe('-')
  expect(fmtDuration(45)).toBe('45 s')
  expect(fmtDuration(75)).toBe('1 min 15 s')
  expect(fmtDuration(125)).toBe('2 min 05 s')
  expect(fmtDuration(3725)).toBe('1 h 2 min')
})

test('shows headline numbers: alerts, response times and the overall false-alarm rate', async () => {
  renderIt()
  expect(await screen.findByText('Median time to acknowledge')).toBeInTheDocument()
  expect(screen.getByText('11')).toBeInTheDocument()
  expect(screen.getByText('1 min 15 s')).toBeInTheDocument()
  expect(screen.getByText('10 min 40 s')).toBeInTheDocument()
  expect(screen.getByText('43%')).toBeInTheDocument()                    // 3 false alarms of 7 judged
  expect(screen.getByText('3 of 7 judged')).toBeInTheDocument()
})

test('the detector table flags noisy rules and says when nothing has been judged yet', async () => {
  renderIt()
  await screen.findByText('Detector accuracy in the field')
  const table = within(screen.getByText('Detector accuracy in the field').closest('.card') as HTMLElement)
  expect(table.getByText('60%')).toBeInTheDocument()
  expect(table.getByText('0%')).toBeInTheDocument()
  expect(table.getByText('not judged yet')).toBeInTheDocument()
})

test('every chart has a legend or title and a table alternative with the same numbers', async () => {
  renderIt()
  await screen.findByText('Alerts per day')
  const u = userEvent.setup()
  const buttons = screen.getAllByRole('button', { name: 'View as table' })
  expect(buttons).toHaveLength(3)
  await u.click(buttons[0])
  const card = screen.getByText('Alerts per day').closest('.card') as HTMLElement
  const t = within(card).getByRole('table')
  expect(within(t).getByText('Panic alerts')).toBeInTheDocument()
  expect(within(t).getAllByRole('row')).toHaveLength(3)                  // header + 2 days
  expect(within(t).getByText('Jun 1')).toBeInTheDocument()
  await u.click(screen.getByRole('button', { name: 'View as chart' }))
  expect(screen.getByRole('img', { name: /Alerts per day chart/ })).toBeInTheDocument()
})

test('zone chart table lists the busiest zones', async () => {
  renderIt()
  await screen.findByText('Busiest risk zones')
  const card = screen.getByText('Busiest risk zones').closest('.card') as HTMLElement
  await userEvent.setup().click(within(card).getByRole('button', { name: 'View as table' }))
  expect(within(card).getByRole('cell', { name: 'Cliff Edge' })).toBeInTheDocument()
  expect(within(card).getByRole('cell', { name: 'River Bank' })).toBeInTheDocument()
})

test('changing the range asks the server for that many days', async () => {
  renderIt()
  await screen.findByText('Alerts per day')
  await userEvent.setup().click(screen.getByRole('tab', { name: '30 days' }))
  await waitFor(() => expect(get).toHaveBeenLastCalledWith('/analytics/summary', { params: { days: 30 } }))
})

test('an empty period shows guidance instead of empty charts', async () => {
  get.mockResolvedValue({ data: summary({ total_alerts: 0, per_day: [], rules: [], zones: [], active_tourists: [{ date: '2026-06-01', count: 0 }], response: { median_ack_s: null, median_resolve_s: null, n_ack: 0, n_resolved: 0 } }) })
  renderIt()
  expect(await screen.findByText('No data in this period')).toBeInTheDocument()
})

test('no judged alerts yet: the false-alarm tile explains how to get a number', async () => {
  get.mockResolvedValue({ data: summary({ rules: [{ kind: 'zone_entry', total: 2, open: 2, genuine: 0, false_alarm: 0, cancelled: 0, judged: 0, false_alarm_ratio: null }] }) })
  renderIt()
  expect(await screen.findByText(/resolve alerts as genuine \/ false alarm/)).toBeInTheDocument()
})

test('a failed load shows an error toast', async () => {
  get.mockRejectedValue(new Error('down'))
  renderIt()
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load analytics')
})

test('has no accessibility violations', async () => {
  const { container } = renderIt()
  await screen.findByText('Alerts per day')
  expect(await a11yViolations(container)).toEqual([])
})
