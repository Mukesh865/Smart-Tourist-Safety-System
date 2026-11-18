import { beforeEach, describe, expect, test, vi } from 'vitest'
import { clearQueues, enqueueFix, enqueuePanic, flushFixes, flushPanics, MAX_QUEUED_FIXES, pendingFixes, pendingPanics, type QueuedFix } from './queue'

const fix = (i: number): QueuedFix => ({ lat: 25 + i / 1000, lon: 91, accuracy: 5, ts: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() })

beforeEach(async () => { await clearQueues() })

describe('fix outbox', () => {
  test('queues fixes and reports the count', async () => {
    await enqueueFix(fix(1)); await enqueueFix(fix(2))
    expect(await pendingFixes()).toBe(2)
  })

  test('never queues the same device timestamp twice', async () => {
    await enqueueFix(fix(1)); await enqueueFix(fix(1))
    expect(await pendingFixes()).toBe(1)
  })

  test('concurrent enqueues do not lose items', async () => {
    await Promise.all(Array.from({ length: 50 }, (_, i) => enqueueFix(fix(i))))
    expect(await pendingFixes()).toBe(50)
  })

  test('keeps only the most recent fixes when the cap is exceeded', async () => {
    for (let i = 0; i < MAX_QUEUED_FIXES + 5; i += 1) await enqueueFix({ ...fix(0), ts: new Date(i * 1000).toISOString() })
    expect(await pendingFixes()).toBe(MAX_QUEUED_FIXES)
    const seen: string[] = []
    await flushFixes(async (b) => { seen.push(...b.map((x) => x.ts)) }, 5000)
    expect(seen[0]).toBe(new Date(5 * 1000).toISOString())          // the 5 oldest were dropped
  }, 30000)

  test('flush sends oldest first, in batches, and empties the queue', async () => {
    for (const i of [5, 1, 3, 2, 4]) await enqueueFix(fix(i))        // enqueued out of order
    const batches: string[][] = []
    const res = await flushFixes(async (b) => { batches.push(b.map((x) => x.ts)) }, 2)
    expect(res).toEqual({ sent: 5, remaining: 0 })
    expect(batches.map((b) => b.length)).toEqual([2, 2, 1])
    expect(batches.flat()).toEqual([...batches.flat()].sort())        // globally chronological
    expect(await pendingFixes()).toBe(0)
  })

  test('a failed batch stays queued and stops the flush; later success resends it (server de-duplicates)', async () => {
    for (let i = 0; i < 5; i += 1) await enqueueFix(fix(i))
    const send = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('offline'))
    const res = await flushFixes(send, 2)
    expect(res.sent).toBe(2); expect(res.remaining).toBe(3); expect(res.error).toBeInstanceOf(Error)
    expect(await pendingFixes()).toBe(3)
    const ok = vi.fn().mockResolvedValue(undefined)
    expect((await flushFixes(ok, 10)).sent).toBe(3)
    expect(await pendingFixes()).toBe(0)
  })

  test('fixes recorded while a flush is in flight are kept', async () => {
    await enqueueFix(fix(1))
    let release!: () => void
    const slow = flushFixes(() => new Promise<void>((r) => { release = r }))
    const late = enqueueFix(fix(2))                                   // arrives mid-flush
    await new Promise((r) => setTimeout(r, 10))
    release()
    await slow; await late
    expect(await pendingFixes()).toBe(1)
  })

  test('flushing an empty queue is a no-op', async () => {
    const send = vi.fn()
    expect(await flushFixes(send)).toEqual({ sent: 0, remaining: 0 })
    expect(send).not.toHaveBeenCalled()
  })
})

describe('panic outbox', () => {
  const p = (n: number) => ({ lat: 25 + n, lon: 91, ts: new Date(n * 1000).toISOString() })

  test('panics are sent in order, one at a time', async () => {
    await enqueuePanic(p(1)); await enqueuePanic(p(2))
    expect(await pendingPanics()).toBe(2)
    const order: number[] = []
    const res = await flushPanics(async (x) => { order.push(x.lat!) })
    expect(res.sent).toBe(2); expect(order).toEqual([26, 27])
    expect(await pendingPanics()).toBe(0)
  })

  test('a failure keeps the unsent panic for the next attempt', async () => {
    await enqueuePanic(p(1)); await enqueuePanic(p(2))
    const send = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('offline'))
    const res = await flushPanics(send)
    expect(res.sent).toBe(1); expect(res.remaining).toBe(1)
    expect(await pendingPanics()).toBe(1)
  })
})
