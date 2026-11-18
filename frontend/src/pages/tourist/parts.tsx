import { useT } from '../../i18n'
import { smsLink } from '../../sms'
import { Button, Card } from '../../ui'
import { useTourist } from './TouristContext'

const CONTROL_ROOM = '112' // India's emergency number; SMS fallback target

export function ScoreRing({ score }: { score: number | null }) {
  const R = 40, C = 2 * Math.PI * R
  const v = score ?? 0
  const color = score == null ? 'stroke-muted' : v >= 70 ? 'stroke-ok' : v >= 40 ? 'stroke-warn' : 'stroke-danger'
  return (
    <div className="relative h-24 w-24 shrink-0">
      <svg viewBox="0 0 100 100" className="-rotate-90" aria-hidden>
        <circle cx="50" cy="50" r={R} fill="none" strokeWidth="9" className="stroke-sunken" />
        <circle cx="50" cy="50" r={R} fill="none" strokeWidth="9" strokeLinecap="round" className={`${color} transition-all`}
                strokeDasharray={C} strokeDashoffset={C * (1 - v / 100)} />
      </svg>
      <span className="absolute inset-0 grid place-items-center text-2xl font-bold" aria-label="safety score">{score ?? '--'}</span>
    </div>
  )
}

export function OfflineBanner() {
  const t = useT()
  const { online, pendingFixes } = useTourist()
  if (online && pendingFixes === 0) return null
  return (
    <div role="status" className="rounded-lg border border-warn/40 bg-warn/10 p-3 text-sm">
      {!online ? t('offlineBanner') : null}
      {pendingFixes > 0 && <p className={online ? '' : 'mt-1'}><b>{pendingFixes}</b> {t('saved')}</p>}
    </div>
  )
}

/** Delivery status of the last panic request: saved offline -> sent -> seen by control room -> help on the way. */
export function PanicStatus() {
  const t = useT()
  const { panic, contacts, cancelPanic, dismissPanic } = useTourist()
  if (panic.phase === 'idle') return null
  const steps: Record<string, string> = {
    queued: t('panicQueued'), sent: t('panicSent'), acknowledged: t('panicAck'), dispatched: t('panicDispatched'),
    resolved: t('panicResolved'), cancelled: t('panicCancelled'),
  }
  const closed = panic.phase === 'resolved' || panic.phase === 'cancelled'
  const numbers = [CONTROL_ROOM, ...contacts.map((c) => c.phone)]
  return (
    <Card role="alert" className={`space-y-3 p-4 ${closed ? '' : 'border-danger/60 bg-danger/10'}`} aria-live="assertive">
      <p className="font-semibold">{steps[panic.phase]}</p>
      <ol className="flex gap-1 text-[11px]" aria-hidden>
        {['queued', 'sent', 'acknowledged', 'dispatched'].map((p, i) => {
          const order = ['queued', 'sent', 'acknowledged', 'dispatched']
          const reached = order.indexOf(panic.phase) >= i || closed
          return <li key={p} className={`h-1.5 flex-1 rounded ${reached ? 'bg-danger' : 'bg-sunken'}`} />
        })}
      </ol>
      {panic.phase === 'queued' && (
        <div>
          <p className="mb-2 text-sm text-muted">{t('panicFail')}</p>
          <a className="inline-block rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold text-white" href={smsLink(panic.lat, panic.lon, numbers)}>{t('sendSms')}</a>
        </div>
      )}
      {panic.phase === 'sent' && (
        <div className="space-y-2">
          <Button variant="secondary" size="sm" onClick={cancelPanic}>{t('mistake')}</Button>
          {panic.cancelError && <p role="alert" className="text-sm text-danger">{panic.cancelError}</p>}
        </div>
      )}
      {closed && <Button variant="secondary" size="sm" onClick={dismissPanic}>OK</Button>}
    </Card>
  )
}
