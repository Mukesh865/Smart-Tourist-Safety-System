/** Durable outbox for things the phone could not send (no signal in a gorge, tunnel, flight mode).
 *  Stored in IndexedDB so it survives closing the app; falls back to memory if IndexedDB is unavailable
 *  (some private-browsing modes). Fixes are replayed oldest-first in batches; panic alerts are sent first. */
import { get, set } from 'idb-keyval'

export interface QueuedFix { lat: number; lon: number; accuracy: number; ts: string }
export interface QueuedPanic { lat: number | null; lon: number | null; ts: string }

const FIXES = 'ts_fix_queue'
const PANICS = 'ts_panic_queue'
export const MAX_QUEUED_FIXES = 2000   // about 33 h at one fix a minute; the server rejects anything older than 48 h

const memory = new Map<string, unknown>()

async function read<T>(key: string): Promise<T[]> {
  try { return ((await get(key)) as T[] | undefined) ?? [] } catch { return (memory.get(key) as T[] | undefined) ?? [] }
}
async function write<T>(key: string, value: T[]): Promise<void> {
  try { await set(key, value) } catch { memory.set(key, value) }
}

// Serialise queue operations so concurrent flush/enqueue calls cannot lose items.
let chain: Promise<unknown> = Promise.resolve()
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.catch(() => undefined)
  return run
}

export const enqueueFix = (f: QueuedFix) => exclusive(async () => {
  const q = await read<QueuedFix>(FIXES)
  if (q.some((x) => x.ts === f.ts)) return          // never queue the same device timestamp twice
  q.push(f)
  if (q.length > MAX_QUEUED_FIXES) q.splice(0, q.length - MAX_QUEUED_FIXES)   // drop the oldest, keep the most recent
  await write(FIXES, q)
})

export const enqueuePanic = (p: QueuedPanic) => exclusive(async () => {
  const q = await read<QueuedPanic>(PANICS)
  q.push(p)
  await write(PANICS, q)
})

export const pendingFixes = () => exclusive(async () => (await read<QueuedFix>(FIXES)).length)
export const pendingPanics = () => exclusive(async () => (await read<QueuedPanic>(PANICS)).length)

export interface FlushResult { sent: number; remaining: number; error?: unknown }

/** Send queued fixes oldest-first in batches. A batch is removed only after the server accepted it; the first failure
 *  stops the flush (the rest stays queued for the next attempt). Re-sending after a lost response is safe because the
 *  server de-duplicates by device timestamp. */
export const flushFixes = (send: (batch: QueuedFix[]) => Promise<void>, batchSize = 100) => exclusive(async (): Promise<FlushResult> => {
  let q = await read<QueuedFix>(FIXES)
  let sent = 0
  while (q.length) {
    const batch = [...q].sort((a, b) => a.ts.localeCompare(b.ts)).slice(0, batchSize)
    try { await send(batch) } catch (error) { return { sent, remaining: q.length, error } }
    const done = new Set(batch.map((b) => b.ts))
    q = q.filter((x) => !done.has(x.ts))
    await write(FIXES, q)
    sent += batch.length
  }
  return { sent, remaining: 0 }
})

export const flushPanics = (send: (p: QueuedPanic) => Promise<void>) => exclusive(async (): Promise<FlushResult> => {
  let q = await read<QueuedPanic>(PANICS)
  let sent = 0
  while (q.length) {
    try { await send(q[0]) } catch (error) { return { sent, remaining: q.length, error } }
    q = q.slice(1)
    await write(PANICS, q)
    sent++
  }
  return { sent, remaining: 0 }
})

export const clearQueues = () => exclusive(async () => { await write(FIXES, []); await write(PANICS, []) })
