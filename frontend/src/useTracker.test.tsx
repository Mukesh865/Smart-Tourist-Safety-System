import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { api } from './api'
import { clearQueues, pendingFixes } from './offline/queue'
import { useTracker } from './useTracker'

let watchCb: ((p: any) => void) | null = null
const position = (lat = 25.5, lon = 91.8) => ({ coords: { latitude: lat, longitude: lon, accuracy: 6 } })

beforeEach(async () => {
  vi.restoreAllMocks()
  await clearQueues()
  watchCb = null
  ;(navigator as any).geolocation = { watchPosition: (ok: any) => { watchCb = ok; return 7 }, clearWatch: vi.fn() }
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => { vi.useRealTimers() })

const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

test('stores each fix with a device timestamp and sends it as a batch', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { accepted: 1, alerts: [], next_interval_s: 60 } })
  const { result } = renderHook(() => useTracker(true))
  act(() => watchCb!(position()))
  await tick(2500)
  expect(post).toHaveBeenCalledWith('/location/batch', { fixes: [expect.objectContaining({ lat: 25.5, lon: 91.8, ts: expect.stringMatching(/^\d{4}-/) })] })
  expect(result.current.lastSent).not.toBeNull()
  expect(await pendingFixes()).toBe(0)
})

test('offline: fixes pile up in the outbox, then are replayed oldest-first when the network returns', async () => {
  const post = vi.spyOn(api, 'post').mockRejectedValue(Object.assign(new Error('Network Error'), { response: undefined }))
  const { result } = renderHook(() => useTracker(true))
  act(() => watchCb!(position(25.5)))
  await tick(2500)                                                  // 1st fix, send fails
  await tick(15000)                                                 // 2nd
  await tick(15000)                                                 // 3rd
  await waitFor(() => expect(result.current.pending).toBeGreaterThanOrEqual(3))
  post.mockResolvedValue({ data: { accepted: 3, alerts: [{ kind: 'zone_entry', detail: 'Entered X' }], next_interval_s: 15 } })
  await act(async () => { window.dispatchEvent(new Event('online')); await vi.advanceTimersByTimeAsync(50) })
  const sent = (post.mock.calls.at(-1)![1] as any).fixes as { ts: string }[]
  expect(sent.length).toBeGreaterThanOrEqual(3)
  expect(sent.map((f) => f.ts)).toEqual([...sent.map((f) => f.ts)].sort())
  await waitFor(() => expect(result.current.pending).toBe(0))
})

test('alerts returned by a replayed batch reach the callback', async () => {
  vi.spyOn(api, 'post').mockResolvedValue({ data: { accepted: 1, alerts: [{ kind: 'zone_entry', detail: 'Entered Cliff' }], next_interval_s: 15 } })
  const onAlerts = vi.fn()
  renderHook(() => useTracker(true, onAlerts))
  act(() => watchCb!(position()))
  await tick(2500)
  expect(onAlerts).toHaveBeenCalledWith([{ kind: 'zone_entry', detail: 'Entered Cliff' }])
})

test('a 403 (revoked ID) stops the tracker instead of retrying forever', async () => {
  vi.spyOn(api, 'post').mockRejectedValue({ response: { status: 403, data: { detail: 'This ID has been revoked.' } } })
  const { result } = renderHook(() => useTracker(true))
  act(() => watchCb!(position()))
  await tick(2500)
  await waitFor(() => expect(result.current.stopped).toBe('revoked'))
})

test('uses the interval the server asks for', async () => {
  const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { accepted: 1, alerts: [], next_interval_s: 60 } })
  renderHook(() => useTracker(true))
  act(() => watchCb!(position()))
  await tick(2500)
  const calls = post.mock.calls.length
  await tick(30000)
  expect(post.mock.calls.length).toBe(calls)                         // 60 s interval: nothing in 30 s
  await tick(31000)
  expect(post.mock.calls.length).toBeGreaterThan(calls)
})

test('GPS errors are reported and nothing is queued without a position', async () => {
  const post = vi.spyOn(api, 'post')
  ;(navigator as any).geolocation = { watchPosition: (_ok: any, err: any) => { err({ code: 1 }); return 1 }, clearWatch: vi.fn() }
  const { result } = renderHook(() => useTracker(true))
  await tick(3000)
  expect(result.current.error).toBe('denied')
  expect(post).not.toHaveBeenCalled()
  expect(await pendingFixes()).toBe(0)
})

test('disabled tracker does not watch or send', async () => {
  const post = vi.spyOn(api, 'post')
  renderHook(() => useTracker(false))
  await tick(5000)
  expect(watchCb).toBeNull(); expect(post).not.toHaveBeenCalled()
})

test('the trail keeps only the latest positions', async () => {
  vi.spyOn(api, 'post').mockResolvedValue({ data: { accepted: 1, alerts: [], next_interval_s: 60 } })
  const { result } = renderHook(() => useTracker(true))
  for (let i = 0; i < 130; i += 1) act(() => watchCb!(position(25 + i / 1000)))
  expect(result.current.trail.length).toBe(120)
  expect(result.current.trail.at(-1)![0]).toBeCloseTo(25.129, 3)
})
