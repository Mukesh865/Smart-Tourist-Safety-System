import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Outlet } from 'react-router-dom'
import { api } from '../../api'
import { useOnline } from '../../hooks'
import { enqueuePanic, flushPanics, pendingPanics } from '../../offline/queue'
import { useT } from '../../i18n'
import { useToast } from '../../ui'
import { useTracker, type Position } from '../../useTracker'
import type { Zone } from '../Zones'

export interface Cred { id_code: string; payload: string; valid_from: string; valid_to: string; revoked?: boolean; revoked_reason?: string | null; verification?: string }
export interface Contact { name: string; phone: string }
export interface AlertRow { id: number; kind: string; detail: string; status: string; resolution?: string | null; created_at: string }
export interface Score { score: number; z: number; night: number; a: number; has_fix: boolean }
export interface Trip { route: [number, number][]; stops: { name: string; lat: number; lon: number; hotel: boolean }[]; valid_to?: string | null }
export type PanicPhase = 'idle' | 'queued' | 'sent' | 'acknowledged' | 'dispatched' | 'resolved' | 'cancelled'
export interface PanicState { phase: PanicPhase; alertId?: number; lat: number | null; lon: number | null; cancelError?: string }

interface Ctx {
  cred: Cred | null; credLoaded: boolean; zones: Zone[]; alerts: AlertRow[]; score: Score | null; trip: Trip | null
  contacts: Contact[]; shareToken: string | null; pos: Position | null; trail: [number, number][]
  gpsError: string; lastSent: Date | null; pendingFixes: number; trackerStopped: string
  tracking: boolean; setTracking: (v: boolean) => void; online: boolean
  panic: PanicState; triggerPanic: () => Promise<void>; cancelPanic: () => Promise<void>; dismissPanic: () => void
  setShare: (on: boolean) => Promise<void>; refresh: () => void; flushNow: () => void; reloadCred: () => Promise<void>
}

const TouristCtx = createContext<Ctx | null>(null)
export const useTourist = () => {
  const c = useContext(TouristCtx)
  if (!c) throw new Error('useTourist must be used inside TouristProvider')
  return c
}

const IDLE: PanicState = { phase: 'idle', lat: null, lon: null }

/** Holds everything the tourist tabs share, so GPS tracking, the offline outbox and panic status keep running while
 *  the user moves between tabs. */
export function TouristProvider({ children }: { children: ReactNode }) {
  const t = useT()
  const toast = useToast()
  const online = useOnline()
  const [cred, setCred] = useState<Cred | null>(null)
  const [credLoaded, setCredLoaded] = useState(false)
  const [zones, setZones] = useState<Zone[]>([])
  const [alerts, setAlerts] = useState<AlertRow[]>([])
  const [score, setScore] = useState<Score | null>(null)
  const [trip, setTrip] = useState<Trip | null>(null)
  const [contacts, setContacts] = useState<Contact[]>([])
  const [shareToken, setShareToken] = useState<string | null>(null)
  const [tracking, setTracking] = useState(true)
  const [panic, setPanic] = useState<PanicState>(IDLE)
  const panicRef = useRef(panic)
  panicRef.current = panic

  const reloadCred = useCallback(async () => {
    // after creating an ID, everything that depends on it must be loaded again
    try { setCred((await api.get('/ledger/my-credential')).data) } catch { setCred(null) }
    api.get('/me/trip').then((r) => setTrip(r.data)).catch(() => {})
    api.get('/me/contacts').then((r) => setContacts(r.data.contacts)).catch(() => {})
    api.get('/me/profile').then((r) => setShareToken(r.data.share_token)).catch(() => {})
  }, [])

  const refresh = useCallback(() => {
    api.get('/alerts/mine').then((r) => setAlerts(r.data)).catch(() => {})
    api.get('/me/score').then((r) => setScore(r.data)).catch(() => {})
  }, [])

  const tracker = useTracker(!!cred && !cred.revoked && tracking, (a) => {
    toast(a.map((x) => x.detail).join('. '), { kind: 'alert' })
    refresh()
  })

  useEffect(() => {
    api.get('/ledger/my-credential').then((r) => setCred(r.data)).catch(() => {}).finally(() => setCredLoaded(true))
    api.get('/zones').then((r) => setZones(r.data)).catch(() => {})
    api.get('/me/profile').then((r) => setShareToken(r.data.share_token)).catch(() => {})
    api.get('/me/trip').then((r) => setTrip(r.data)).catch(() => {})
    api.get('/me/contacts').then((r) => setContacts(r.data.contacts)).catch(() => {})
    refresh()
    const i = setInterval(refresh, 30000)
    return () => clearInterval(i)
  }, [refresh])

  // ----- panic -----
  const sendPanicBody = useCallback(async (body: object) => {
    const { data } = await api.post('/panic', body)
    if (data.contacts?.length) setContacts(data.contacts)
    return data as { alert_id: number; lat: number | null; lon: number | null }
  }, [])

  const triggerPanic = useCallback(async () => {
    const p = tracker.pos
    const body = { lat: p?.lat ?? undefined, lon: p?.lon ?? undefined, ts: new Date().toISOString() }
    try {
      const d = await sendPanicBody(body)
      setPanic({ phase: 'sent', alertId: d.alert_id, lat: d.lat, lon: d.lon })
    } catch (e: any) {
      if (e?.response && e.response.status < 500) {          // the server answered and refused (e.g. rate limit)
        toast(e.response.data?.detail ?? 'Could not send the request', { kind: 'error' })
        return
      }
      await enqueuePanic({ lat: p?.lat ?? null, lon: p?.lon ?? null, ts: body.ts })   // no connection: keep it safe and retry
      setPanic({ phase: 'queued', lat: p?.lat ?? null, lon: p?.lon ?? null })
    }
    refresh()
  }, [tracker.pos, sendPanicBody, toast, refresh])

  const flushQueuedPanic = useCallback(async () => {
    const res = await flushPanics(async (p) => {
      const d = await sendPanicBody(p)
      setPanic({ phase: 'sent', alertId: d.alert_id, lat: p.lat, lon: p.lon })
    })
    if (res.sent) refresh()
  }, [sendPanicBody, refresh])

  useEffect(() => {
    void pendingPanics().then((n) => { if (n > 0) setPanic((p) => (p.phase === 'idle' ? { ...p, phase: 'queued' } : p)) })
  }, [])
  useEffect(() => {
    const go = () => { void flushQueuedPanic() }
    window.addEventListener('online', go)
    const timer = setInterval(() => { if (panicRef.current.phase === 'queued') go() }, 10000)
    return () => { window.removeEventListener('online', go); clearInterval(timer) }
  }, [flushQueuedPanic])

  // delivery status: sent -> acknowledged -> dispatched -> resolved
  useEffect(() => {
    if (!['sent', 'acknowledged', 'dispatched'].includes(panic.phase) || !panic.alertId) return
    const poll = async () => {
      try {
        const { data } = await api.get('/alerts/mine')
        const a: AlertRow | undefined = data.find((x: AlertRow) => x.id === panic.alertId)
        if (!a) return
        setAlerts(data)
        const phase: PanicPhase = a.status === 'resolved' ? (a.resolution === 'cancelled_by_user' ? 'cancelled' : 'resolved')
          : a.status === 'dispatched' ? 'dispatched' : a.status === 'acknowledged' ? 'acknowledged' : 'sent'
        setPanic((p) => (p.alertId === a.id && p.phase !== phase ? { ...p, phase } : p))
      } catch { /* offline: keep the last known state */ }
    }
    const i = setInterval(poll, 5000)
    return () => clearInterval(i)
  }, [panic.phase, panic.alertId])

  const cancelPanic = useCallback(async () => {
    const id = panicRef.current.alertId
    if (!id) return
    try {
      await api.post(`/panic/${id}/cancel`)
      setPanic((p) => ({ ...p, phase: 'cancelled', cancelError: undefined }))
      refresh()
    } catch (e: any) {
      setPanic((p) => ({ ...p, cancelError: e?.response?.status === 409 ? t('cancelTooLate') : 'Could not cancel' }))
    }
  }, [refresh, t])

  const setShare = useCallback(async (on: boolean) => {
    const { data } = await api.post('/me/share', { enabled: on })
    setShareToken(data.share_token)
  }, [])

  const value = useMemo<Ctx>(() => ({
    cred, credLoaded, zones, alerts, score, trip, contacts, shareToken, pos: tracker.pos, trail: tracker.trail,
    gpsError: tracker.error, lastSent: tracker.lastSent, pendingFixes: tracker.pending, trackerStopped: tracker.stopped,
    tracking, setTracking, online, panic, triggerPanic, cancelPanic, dismissPanic: () => setPanic(IDLE), setShare, refresh, reloadCred,
    flushNow: () => { void tracker.flush() },
  }), [cred, credLoaded, zones, alerts, score, trip, contacts, shareToken, tracker.pos, tracker.trail, tracker.error, tracker.lastSent,
    tracker.pending, tracker.stopped, tracker.flush, tracking, online, panic, triggerPanic, cancelPanic, setShare, refresh, reloadCred])

  return <TouristCtx.Provider value={value}>{children}</TouristCtx.Provider>
}

export function TouristLayout() {
  return <TouristProvider><Outlet /></TouristProvider>
}
