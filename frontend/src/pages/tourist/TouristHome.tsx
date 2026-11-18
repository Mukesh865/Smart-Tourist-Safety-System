import { useState } from 'react'
import AppShell from '../../components/AppShell'
import HoldButton from '../../components/HoldButton'
import { fmtDistance, haversine, zoneStatus } from '../../geo'
import { useT } from '../../i18n'
import { Badge, Card, ConfirmDialog } from '../../ui'
import ApplyId from './ApplyId'
import { OfflineBanner, PanicStatus, ScoreRing } from './parts'
import { useTourist } from './TouristContext'

export default function TouristHome() {
  const t = useT()
  const { cred, credLoaded, pos, zones, score, trip, triggerPanic, panic, trackerStopped, gpsError, tracking, lastSent } = useTourist()
  const [confirm, setConfirm] = useState(false)
  const [renewing, setRenewing] = useState(false)

  const zs = pos ? zoneStatus([pos.lat, pos.lon], zones) : null
  const status = !pos ? { tone: 'neutral' as const, text: t('statusNoGps') }
    : zs?.inside ? { tone: 'danger' as const, text: t('statusInside') }
    : zs ? { tone: 'warn' as const, text: t('statusNear') }
    : { tone: 'ok' as const, text: t('statusSafe') }

  const next = pos && trip ? trip.stops.filter((s) => !s.hotel).map((s) => ({ s, d: haversine([pos.lat, pos.lon], [s.lat, s.lon]) })).sort((a, b) => a.d - b.d)[0] : null
  const blocked = !cred || !!cred.revoked
  const busy = panic.phase !== 'idle' && panic.phase !== 'resolved' && panic.phase !== 'cancelled'

  const ended = !!cred && (!!cred.revoked || new Date(cred.valid_to).getTime() < Date.now())
  if ((credLoaded && !cred) || (ended && renewing)) return <AppShell title={t('title')}><ApplyId /></AppShell>

  return (
    <AppShell title={t('title')}>
      <div className="space-y-4">
        {cred?.revoked && (
          <p role="alert" className="rounded-lg bg-danger/15 p-3 text-sm font-semibold text-danger">
            {t('revokedBanner')}{cred.revoked_reason ? `: ${cred.revoked_reason}` : ''}.
          </p>
        )}
        {cred && !cred.revoked && ended && <p role="alert" className="rounded-lg bg-warn/15 p-3 text-sm text-warn">Your digital ID has expired.</p>}
        {ended && <button className="btn w-full" onClick={() => setRenewing(true)}>Create a new digital ID</button>}
        {trackerStopped === 'revoked' && !cred?.revoked && <p role="alert" className="rounded-lg bg-danger/15 p-3 text-sm text-danger">{t('revokedBanner')}.</p>}
        <OfflineBanner />

        <Card className="flex items-center gap-4 p-4">
          <ScoreRing score={score?.score ?? null} />
          <div className="min-w-0 flex-1 space-y-2">
            <Badge tone={status.tone}>{status.text}</Badge>
            <p className="text-sm text-muted">{t('score')}</p>
            {gpsError && <p className="text-sm text-danger">{t('noGps')}</p>}
            {tracking && lastSent && <p className="text-xs text-muted">{t('lastSent')}: {lastSent.toLocaleTimeString()}</p>}
          </div>
        </Card>

        <PanicStatus />

        <div className="flex flex-col items-center gap-3 py-2">
          <HoldButton onComplete={triggerPanic} disabled={blocked && !cred ? true : busy} describedBy="panic-help" className="h-44 w-44">{t('panic')}</HoldButton>
          <p id="panic-help" className="max-w-xs text-center text-sm text-muted">{t('holdHint')}</p>
          <button className="text-sm font-medium text-brand-ink underline disabled:opacity-50" disabled={!cred || busy} onClick={() => setConfirm(true)}>{t('cantHold')}</button>
        </div>

        <Card className="p-4">
          <h2 className="mb-1 text-sm font-semibold">{t('nextStop')}</h2>
          {next ? <p className="text-sm">{next.s.name} · {fmtDistance(next.d)}</p> : <p className="text-sm text-muted">{trip && trip.stops.length ? '-' : t('noTrip')}</p>}
        </Card>
      </div>

      <ConfirmDialog open={confirm} title={t('confirmTitle')} message={t('confirmMsg')} confirmLabel={t('sendNow')} danger
                     onConfirm={() => { setConfirm(false); void triggerPanic() }} onCancel={() => setConfirm(false)} />
    </AppShell>
  )
}
