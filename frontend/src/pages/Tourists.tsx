import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import AppShell from '../components/AppShell'
import IdCard from '../components/IdCard'
import ItineraryEditor, { type Itinerary } from '../components/ItineraryEditor'
import { useAuth } from '../store'
import { Badge, Button, Card, EmptyState, Modal, Skeleton, TextInput, useToast, type Tone } from '../ui'

interface Row { verification?: string; tourist_id: number; name: string; email: string; id_code: string | null; valid_to: string | null; status: string }

const TONE: Record<string, Tone> = { active: 'ok', expiring: 'warn', expired: 'neutral', revoked: 'danger', no_id: 'neutral' }
const LABEL: Record<string, string> = { active: 'Active', expiring: 'Expiring soon', expired: 'Expired', revoked: 'Revoked', no_id: 'No ID yet' }
const FILTERS = ['', 'active', 'expiring', 'expired', 'revoked', 'no_id']
const PAGE = 15
const errText = (e: any, d: string) => (typeof e?.response?.data?.detail === 'string' ? e.response.data.detail : d)
const plus = (d: number) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10)

export default function Tourists() {
  const toast = useToast()
  const isAdmin = useAuth((s) => s.user?.role === 'admin')
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [offset, setOffset] = useState(0)
  const [data, setData] = useState<{ total: number; items: Row[] } | null>(null)
  const [card, setCard] = useState<any>(null)
  const [extend, setExtend] = useState<Row | null>(null)
  const [until, setUntil] = useState(plus(14))
  const [itinFor, setItinFor] = useState<Row | null>(null)
  const [itin, setItin] = useState<Itinerary>({ route: [], stops: [] })
  const [revokeFor, setRevokeFor] = useState<Row | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try { const { data } = await api.get('/tourists', { params: { q, status: status || undefined, limit: PAGE, offset } }); setData(data) }
    catch (e) { toast(errText(e, 'Could not load tourists'), { kind: 'error' }) }
  }, [q, status, offset, toast])
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t) }, [load])

  async function showCard(r: Row) {
    try { const { data } = await api.get(`/tourists/${r.tourist_id}/credential`); setCard(data) }
    catch (e) { toast(errText(e, 'Could not load the ID card'), { kind: 'error' }) }
  }

  async function markVerified(r: Row) {
    try { await api.post(`/tourists/${r.tourist_id}/verify-in-person`); toast('Marked as verified in person', { kind: 'success' }); await load() }
    catch (e) { toast(errText(e, 'Could not update'), { kind: 'error' }) }
  }

  async function doExtend() {
    if (!extend) return
    setBusy(true)
    try {
      const { data } = await api.post(`/tourists/${extend.tourist_id}/renew`, { valid_to: `${until}T23:59:59Z` })
      toast(`Extended. New ID ${data.id_code}; the old one is revoked.`, { kind: 'success' })
      setExtend(null); await load()
      setCard({ id_code: data.id_code, name: extend.name, payload: data.payload, valid_from: new Date().toISOString(), valid_to: `${until}T23:59:59Z`, revoked: false })
    } catch (e) { toast(errText(e, 'Could not extend the ID'), { kind: 'error' }) }
    finally { setBusy(false) }
  }

  async function openItinerary(r: Row) {
    try {
      const { data } = await api.get(`/tourists/${r.tourist_id}`)
      setItin({ route: data.itinerary.route, stops: data.itinerary.stops }); setItinFor(r)
    } catch (e) { toast(errText(e, 'Could not load the itinerary'), { kind: 'error' }) }
  }
  async function saveItinerary() {
    if (!itinFor) return
    setBusy(true)
    try { await api.put(`/tourists/${itinFor.tourist_id}/itinerary`, itin); toast('Itinerary saved', { kind: 'success' }); setItinFor(null) }
    catch (e) { toast(errText(e, 'Could not save the itinerary'), { kind: 'error' }) }
    finally { setBusy(false) }
  }

  async function doRevoke() {
    if (!revokeFor?.id_code) return
    setBusy(true)
    try { await api.post(`/ledger/${revokeFor.id_code}/revoke`, { reason }); toast('ID revoked', { kind: 'success' }); setRevokeFor(null); setReason(''); await load() }
    catch (e) { toast(errText(e, 'Could not revoke'), { kind: 'error' }) }
    finally { setBusy(false) }
  }

  return (
    <AppShell title="Tourists">
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="w-full sm:w-72"><TextInput label="Search name, email or ID code" value={q} onChange={(e) => { setQ(e.target.value); setOffset(0) }} /></div>
        <div role="group" aria-label="Filter by status" className="flex flex-wrap gap-1">
          {FILTERS.map((f) => (
            <button key={f || 'all'} aria-pressed={status === f} onClick={() => { setStatus(f); setOffset(0) }}
                    className={`rounded-full px-3 py-1.5 text-xs font-semibold ${status === f ? 'bg-brand text-white dark:text-slate-950' : 'bg-sunken text-muted hover:text-ink'}`}>
              {f ? LABEL[f] : 'All'}
            </button>
          ))}
        </div>
      </div>

      {!data ? <Skeleton className="h-40" /> : data.items.length === 0 ? (
        <EmptyState title="No tourists match" hint="Visitors appear here after they register on the website." />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead><tr className="border-b text-left text-xs uppercase text-muted"><th className="p-3">Visitor</th><th>ID</th><th>Valid until</th><th>Status</th><th className="pr-3 text-right">Actions</th></tr></thead>
            <tbody>
              {data.items.map((r) => (
                <tr key={r.tourist_id} className="border-b last:border-0">
                  <td className="p-3"><p className="font-medium">{r.name}</p><p className="text-xs text-muted">{r.email}</p></td>
                  <td className="font-mono text-xs">{r.id_code ?? '-'}</td>
                  <td>{r.valid_to ? new Date(r.valid_to).toLocaleDateString() : '-'}</td>
                  <td><Badge tone={TONE[r.status]}>{LABEL[r.status]}</Badge>{r.id_code && r.verification === 'self_declared' && <Badge tone="warn" className="ml-1">Self-declared</Badge>}</td>
                  <td className="space-x-1 whitespace-nowrap pr-3 text-right">
                    {r.id_code && r.verification === 'self_declared' && <Button size="sm" variant="secondary" aria-label={`Mark ${r.name} verified`} onClick={() => markVerified(r)}>Mark verified</Button>}
                    {r.id_code && <Button size="sm" variant="secondary" aria-label={`ID card for ${r.name}`} onClick={() => showCard(r)}>ID card</Button>}
                    {r.id_code && r.status !== 'revoked' && <Button size="sm" variant="secondary" aria-label={`Extend ID for ${r.name}`} onClick={() => { setExtend(r); setUntil(plus(14)) }}>Extend</Button>}
                    {r.id_code && <Button size="sm" variant="secondary" aria-label={`Itinerary for ${r.name}`} onClick={() => openItinerary(r)}>Itinerary</Button>}
                    {isAdmin && r.id_code && r.status !== 'revoked' && <Button size="sm" variant="danger" aria-label={`Revoke ID of ${r.name}`} onClick={() => setRevokeFor(r)}>Revoke</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {data && data.total > PAGE && (
        <div className="mt-3 flex items-center justify-between text-sm">
          <span className="text-muted">{offset + 1}-{Math.min(offset + PAGE, data.total)} of {data.total}</span>
          <div className="space-x-2">
            <Button size="sm" variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</Button>
            <Button size="sm" variant="secondary" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>Next</Button>
          </div>
        </div>
      )}

      <Modal open={!!card} title="Digital tourist ID" onClose={() => setCard(null)} footer={<Button onClick={() => setCard(null)}>Close</Button>}>
        {card && <IdCard name={card.name} idCode={card.id_code} payload={card.payload} validFrom={card.valid_from} validTo={card.valid_to} revoked={card.revoked} />}
      </Modal>

      <Modal open={!!extend} title={`Extend ID for ${extend?.name ?? ''}`} onClose={() => setExtend(null)}
             footer={<><Button variant="secondary" onClick={() => setExtend(null)}>Cancel</Button><Button onClick={doExtend} loading={busy}>Extend</Button></>}>
        <p className="text-sm text-muted">A new ID is issued with the same verified details and the old one is revoked (superseded). Available only while the encrypted details still exist.</p>
        <TextInput label="New end date" type="date" value={until} min={plus(0)} onChange={(e) => setUntil(e.target.value)} />
      </Modal>

      <Modal open={!!itinFor} title={`Itinerary for ${itinFor?.name ?? ''}`} onClose={() => setItinFor(null)}
             footer={<><Button variant="secondary" onClick={() => setItinFor(null)}>Cancel</Button><Button onClick={saveItinerary} loading={busy}>Save itinerary</Button></>}>
        <ItineraryEditor value={itin} onChange={setItin} height="h-60" />
      </Modal>

      <Modal open={!!revokeFor} title={`Revoke ID of ${revokeFor?.name ?? ''}`} onClose={() => setRevokeFor(null)}
             footer={<><Button variant="secondary" onClick={() => setRevokeFor(null)}>Cancel</Button><Button variant="danger" onClick={doRevoke} loading={busy} disabled={reason.trim().length < 3}>Revoke ID</Button></>}>
        <p className="text-sm text-muted">The ID will fail verification at every check-post and tracking stops. This cannot be undone; issue a new ID if needed.</p>
        <TextInput label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} hint="Recorded in the public revocation list and the audit log." />
      </Modal>
    </AppShell>
  )
}
