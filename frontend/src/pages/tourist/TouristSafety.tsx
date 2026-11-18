import AppShell from '../../components/AppShell'
import { useT } from '../../i18n'
import { Badge, Card, EmptyState, IconShield } from '../../ui'
import { useTourist } from './TouristContext'

const TONE: Record<string, 'danger' | 'warn' | 'neutral'> = { panic: 'danger', zone_entry: 'warn', zone_warning: 'warn', dropoff: 'warn', inactivity: 'warn', deviation: 'warn' }

export default function TouristSafety() {
  const t = useT()
  const { alerts, score } = useTourist()
  const parts = score && [
    { label: t('partZone'), value: Math.round(score.z * 50), max: 50 },        // weights from the paper: 0.5 Z, 0.2 N, 0.3 A (x100)
    { label: t('partNight'), value: Math.round(score.night * 20), max: 20 },
    { label: t('partMove'), value: Math.round(score.a * 30), max: 30 },
  ]
  return (
    <AppShell title={t('tabSafety')}>
      <div className="space-y-4">
        <Card className="space-y-3 p-4">
          <h2 className="font-semibold">{t('scoreParts')}</h2>
          {!parts ? <p className="text-sm text-muted">-</p> : (
            <ul className="space-y-3">
              {parts.map((p) => (
                <li key={p.label}>
                  <div className="flex justify-between text-sm"><span>{p.label}</span><span className="text-muted">-{p.value}</span></div>
                  <div className="mt-1 h-2 overflow-hidden rounded bg-sunken" role="img" aria-label={`${p.label}: minus ${p.value} points`}>
                    <div className={`h-full ${p.value ? 'bg-warn' : 'bg-ok'}`} style={{ width: `${Math.max(4, (p.value / p.max) * 100)}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="space-y-2 p-4">
          <h2 className="font-semibold">{t('alerts')}</h2>
          {alerts.length === 0 ? <EmptyState icon={<IconShield />} title={t('noAlerts')} /> : (
            <ul className="space-y-2">
              {alerts.slice(0, 15).map((a) => (
                <li key={a.id} className="flex items-start gap-2 text-sm">
                  <Badge tone={TONE[a.kind] ?? 'neutral'}>{a.kind.replace('_', ' ')}</Badge>
                  <span className="flex-1">{a.detail}</span>
                  <time className="shrink-0 text-xs text-muted" dateTime={a.created_at}>{new Date(a.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="space-y-2 p-4">
          <h2 className="font-semibold">{t('tipsTitle')}</h2>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
            {(['tip1', 'tip2', 'tip3', 'tip4'] as const).map((k) => <li key={k}>{t(k)}</li>)}
          </ul>
        </Card>
      </div>
    </AppShell>
  )
}
