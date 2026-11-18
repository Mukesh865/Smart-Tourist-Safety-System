import { Link } from 'react-router-dom'
import AppShell from '../../components/AppShell'
import IdCard from '../../components/IdCard'
import { useAuth } from '../../store'
import { useT } from '../../i18n'
import { Card } from '../../ui'
import ApplyId from './ApplyId'
import { useTourist } from './TouristContext'

export default function TouristId() {
  const t = useT()
  const user = useAuth((s) => s.user)
  const { cred, credLoaded } = useTourist()
  return (
    <AppShell title={t('myId')}>
      {!cred ? (credLoaded ? <ApplyId /> : <p>…</p>) : (
        <div className="space-y-4">
          {cred.revoked && <p role="alert" className="rounded-lg bg-danger/15 p-3 text-sm font-semibold text-danger">{t('revokedBanner')}{cred.revoked_reason ? `: ${cred.revoked_reason}` : ''}</p>}
          {cred.verification === 'self_declared' && <p role="status" className="rounded-lg bg-warn/15 p-3 text-sm text-warn">Self-declared ID: an officer has not yet checked your document. Show your document at any check-post to get it verified.</p>}
          {cred.verification === 'officer' && <p role="status" className="rounded-lg bg-ok/15 p-3 text-sm text-ok">Verified by an officer.</p>}
          <Card className="p-5">
            <IdCard name={user?.full_name} idCode={cred.id_code} payload={cred.payload} validFrom={cred.valid_from} validTo={cred.valid_to} revoked={cred.revoked} />
            <p className="mt-3 text-center text-xs text-muted">{t('validTo')} {new Date(cred.valid_to).toLocaleDateString()}</p>
          </Card>
          <p className="text-center text-sm text-muted">{t('idHelp')}</p>
          <p className="text-center"><Link className="text-sm font-medium text-brand-ink underline" to="/verify">{t('verifyLink')}</Link></p>
        </div>
      )}
    </AppShell>
  )
}
