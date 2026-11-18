import { QRCodeSVG } from 'qrcode.react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import AppShell from '../../components/AppShell'
import { useInstallPrompt } from '../../hooks'
import { useT } from '../../i18n'
import { useAuth } from '../../store'
import { Badge, Button, Card, useToast } from '../../ui'
import { useTourist } from './TouristContext'

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div><p className="text-sm font-medium">{label}</p>{hint && <p className="text-xs text-muted">{hint}</p>}</div>
      {children}
    </div>
  )
}

export default function TouristSettings() {
  const t = useT()
  const toast = useToast()
  const user = useAuth((s) => s.user)
  const { tracking, setTracking, shareToken, setShare, contacts, pendingFixes, flushNow, online } = useTourist()
  const install = useInstallPrompt()
  const [copied, setCopied] = useState(false)
  const link = shareToken ? `${window.location.origin}/family/${shareToken}` : ''

  async function copy() {
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 2000) }
    catch { toast(link, { kind: 'info', ms: 10000 }) }   // clipboard blocked: show the link instead
  }

  return (
    <AppShell title={t('tabSettings')}>
      <div className="space-y-4">
        <Card className="space-y-4 p-4">
          <Row label={`${t('tracking')}: ${tracking ? t('on') : t('off')}`} hint={t('trackingHelp')}>
            <input type="checkbox" className="h-5 w-5" aria-label={t('tracking')} checked={tracking} onChange={(e) => setTracking(e.target.checked)} />
          </Row>
          {pendingFixes > 0 && (
            <Row label={`${pendingFixes} ${t('saved')}`}>
              <Button size="sm" variant="secondary" disabled={!online} onClick={flushNow}>Send now</Button>
            </Row>
          )}
        </Card>

        <Card className="space-y-3 p-4">
          <Row label={t('share')} hint={t('shareHelp')}>
            <input type="checkbox" className="h-5 w-5" aria-label="share with family" checked={!!shareToken} onChange={(e) => setShare(e.target.checked)} />
          </Row>
          {shareToken && (
            <div className="flex flex-col items-center gap-2 rounded-lg bg-sunken p-3">
              <p className="break-all text-center text-xs text-muted">{t('shareLink')}: {link}</p>
              <QRCodeSVG value={link} size={120} title="Family link QR code" />
              <Button size="sm" variant="secondary" onClick={copy}>{copied ? t('copied') : t('copyLink')}</Button>
            </div>
          )}
        </Card>

        <Card className="space-y-2 p-4">
          <h2 className="font-semibold">{t('contacts')}</h2>
          {contacts.length === 0 ? <p className="text-sm text-muted">{t('noContacts')}</p> : (
            <ul className="space-y-1 text-sm">{contacts.map((c) => <li key={c.phone} className="flex justify-between"><span>{c.name}</span><a className="text-brand-ink underline" href={`tel:${c.phone}`}>{c.phone}</a></li>)}</ul>
          )}
        </Card>

        <Card className="space-y-3 p-4">
          <Row label={t('installApp')} hint={t('installHelp')}>
            {install.installed ? <Badge tone="ok">{t('installed')}</Badge>
              : <Button size="sm" disabled={!install.canInstall} onClick={() => install.install()}>{t('installApp')}</Button>}
          </Row>
          <Row label={user?.full_name ?? ''} hint={user?.email}>
            <Link className="text-sm font-medium text-brand-ink underline" to="/profile">{t('account')}</Link>
          </Row>
        </Card>
      </div>
    </AppShell>
  )
}
