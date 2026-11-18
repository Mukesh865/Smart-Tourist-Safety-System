import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import { enqueueFix, flushFixes, pendingFixes, type QueuedFix } from './offline/queue'

export interface Position { lat: number; lon: number; accuracy: number }
export type GpsError = '' | 'denied' | 'unavailable'
export type TrackerStop = '' | 'revoked' | 'no_id'

const TRAIL_MAX = 120

/** Watches GPS, stores every fix with its device timestamp in the offline outbox, and flushes the outbox to the server
 *  in batches at the interval the server asks for (15 s near risk zones, 60 s elsewhere). When the network is down fixes
 *  simply stay queued and are replayed (oldest first, de-duplicated server-side) as soon as it returns. */
export function useTracker(enabled: boolean, onAlerts?: (a: { kind: string; detail: string }[]) => void) {
  const [pos, setPos] = useState<Position | null>(null)
  const [trail, setTrail] = useState<[number, number][]>([])
  const [error, setError] = useState<GpsError>('')
  const [stopped, setStopped] = useState<TrackerStop>('')
  const [lastSent, setLastSent] = useState<Date | null>(null)
  const [pending, setPending] = useState(0)
  const latest = useRef<Position | null>(null)
  const cb = useRef(onAlerts)
  cb.current = onAlerts
  const nextInterval = useRef(15)

  const flush = useCallback(async () => {
    const res = await flushFixes(async (batch: QueuedFix[]) => {
      const { data } = await api.post('/location/batch', { fixes: batch })
      nextInterval.current = data.next_interval_s ?? 60
      setLastSent(new Date())
      if (data.alerts?.length) cb.current?.(data.alerts)
    })
    setPending(await pendingFixes())
    const status = (res.error as any)?.response?.status
    if (status === 403) setStopped('revoked')       // ID revoked or missing: stop trying
    return res
  }, [])

  useEffect(() => {
    if (!enabled) return
    if (!('geolocation' in navigator)) { setError('unavailable'); return }
    let off = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const watch = navigator.geolocation.watchPosition(
      (p) => {
        const v = { lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }
        latest.current = v
        setPos(v)
        setTrail((t) => [...t.slice(-(TRAIL_MAX - 1)), [v.lat, v.lon]])
        setError('')
      },
      () => setError('denied'),
      { enableHighAccuracy: true, maximumAge: 5000 },
    )

    async function tick() {
      const p = latest.current
      if (p) {
        await enqueueFix({ ...p, ts: new Date().toISOString() })
        await flush()
      } else if ((await pendingFixes()) > 0) await flush()
      if (!off) timer = setTimeout(tick, nextInterval.current * 1000)
    }
    const onOnline = () => { void flush() }     // network is back: replay the backlog straight away
    window.addEventListener('online', onOnline)
    timer = setTimeout(tick, 2000)
    return () => {
      off = true
      navigator.geolocation.clearWatch(watch)
      window.removeEventListener('online', onOnline)
      if (timer) clearTimeout(timer)
    }
  }, [enabled, flush])

  useEffect(() => { if (stopped === '' && enabled) void pendingFixes().then(setPending) }, [enabled, stopped])

  return { pos, trail, error, lastSent, pending, stopped, flush }
}
