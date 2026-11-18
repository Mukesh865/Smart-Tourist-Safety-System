import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import AppShell from '../components/AppShell'
import { Badge, Button, Card, EmptyState, Modal, Skeleton, StatCard, Tabs, TextInput, useToast } from '../ui'

interface Block { height: number; ts: number; prev_hash: string; merkle_root: string; records: number; signature_ok: boolean; root_ok: boolean }
interface Rev { id_code: string; reason: string; ts: number; entry_hash: string }

const short = (h: string) => `${h.slice(0, 8)}…${h.slice(-6)}`
const when = (ts: number) => new Date(ts * 1000).toLocaleString()
const errText = (e: any, d: string) => (typeof e?.response?.data?.detail === 'string' ? e.response.data.detail : d)
const PAGE = 15

/** Ledger explorer: hashes and counts only (the ledger never holds personal data). */
export default function Ledger() {
  const toast = useToast()
  const [tab, setTab] = useState<'blocks' | 'revocations'>('blocks')
  const [chain, setChain] = useState<{ ok: boolean; blocks: number; broken_at: number | null } | null>(null)
  const [revAudit, setRevAudit] = useState<{ ok: boolean; entries: number } | null>(null)
  const [blocks, setBlocks] = useState<{ total: number; items: Block[] } | null>(null)
  const [offset, setOffset] = useState(0)
  const [detail, setDetail] = useState<any>(null)
  const [revs, setRevs] = useState<Rev[] | null>(null)
  const [revokeCode, setRevokeCode] = useState<string | null>(null)
  const [reason, setReason] = useState('')

  const loadAll = useCallback(async () => {
    try {
      const [c, r, b, l] = await Promise.all([api.get('/ledger/chain'), api.get('/ledger/revocations/audit'),
        api.get('/ledger/blocks', { params: { limit: PAGE, offset } }), api.get('/ledger/revocations')])
      setChain(c.data); setRevAudit(r.data); setBlocks(b.data); setRevs(l.data.entries)
    } catch (e) { toast(errText(e, 'Could not load the ledger'), { kind: 'error' }) }
  }, [offset, toast])
  useEffect(() => { loadAll() }, [loadAll])

  async function open(h: number) {
    try { const { data } = await api.get(`/ledger/blocks/${h}`); setDetail(data) }
    catch (e) { toast(errText(e, 'Could not load the block'), { kind: 'error' }) }
  }

  async function revoke() {
    if (!revokeCode) return
    try {
      await api.post(`/ledger/${revokeCode}/revoke`, { reason })
      toast('ID revoked', { kind: 'success' })
      setRevokeCode(null); setReason('')
      await loadAll(); if (detail) await open(detail.height)
    } catch (e) { toast(errText(e, 'Could not revoke'), { kind: 'error' }) }
  }

  const healthy = chain?.ok && revAudit?.ok
  return (
    <AppShell title="Ledger explorer" actions={chain && revAudit && (
      <Badge tone={healthy ? 'ok' : 'danger'}>{healthy ? 'Chain verified' : 'INTEGRITY PROBLEM'}</Badge>)}>
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Blocks" value={chain?.blocks ?? '-'} />
        <StatCard label="Revocations" value={revAudit?.entries ?? '-'} />
        <StatCard label="Block chain" value={chain ? (chain.ok ? 'Intact' : `Broken at ${chain.broken_at}`) : '-'} tone={chain ? (chain.ok ? 'ok' : 'danger') : undefined} />
        <StatCard label="Revocation list" value={revAudit ? (revAudit.ok ? 'Intact' : 'Tampered') : '-'} tone={revAudit ? (revAudit.ok ? 'ok' : 'danger') : undefined} />
      </div>
      <p className="mb-4 max-w-3xl text-sm text-muted">
        Each block holds salted-hash commitments only. An ID verifies by recomputing the Merkle root from its path (about log2 of the block size
        hashes) and checking the authority signature on the block header; revoked IDs are rejected through the signed revocation list.
      </p>
      <div className="mb-4"><Tabs label="Ledger sections" value={tab} onChange={setTab} tabs={[{ id: 'blocks', label: 'Blocks' }, { id: 'revocations', label: 'Revocation list' }]} /></div>

      {tab === 'blocks' && (!blocks ? <Skeleton className="h-40" /> : blocks.items.length === 0 ? (
        <EmptyState title="No blocks yet" hint="Blocks appear when the first digital ID is issued." />
      ) : (
        <>
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead><tr className="border-b text-left text-xs uppercase text-muted"><th className="p-3">Height</th><th>Time</th><th>Records</th><th>Merkle root</th><th>Checks</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>{blocks.items.map((b) => (
                <tr key={b.height} className="border-b last:border-0">
                  <td className="p-3 font-semibold">#{b.height}</td><td className="text-xs">{when(b.ts)}</td><td>{b.records}</td>
                  <td className="font-mono text-xs">{short(b.merkle_root)}</td>
                  <td>{b.signature_ok && b.root_ok ? <Badge tone="ok">Signature + root OK</Badge> : <Badge tone="danger">{!b.signature_ok ? 'Bad signature' : 'Root mismatch'}</Badge>}</td>
                  <td className="pr-3 text-right"><Button size="sm" variant="secondary" aria-label={`Open block ${b.height}`} onClick={() => open(b.height)}>Open</Button></td>
                </tr>))}</tbody>
            </table>
          </Card>
          {blocks.total > PAGE && (
            <div className="mt-3 flex items-center justify-between text-sm">
              <span className="text-muted">{offset + 1}-{Math.min(offset + PAGE, blocks.total)} of {blocks.total}</span>
              <div className="space-x-2">
                <Button size="sm" variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Newer</Button>
                <Button size="sm" variant="secondary" disabled={offset + PAGE >= blocks.total} onClick={() => setOffset(offset + PAGE)}>Older</Button>
              </div>
            </div>
          )}
        </>
      ))}

      {tab === 'revocations' && (!revs ? <Skeleton className="h-32" /> : revs.length === 0 ? (
        <EmptyState title="Nothing revoked" hint="Revoked IDs are listed here, signed and hash-chained, so check-posts can mirror the list." />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <thead><tr className="border-b text-left text-xs uppercase text-muted"><th className="p-3">ID</th><th>Reason</th><th>Time</th><th>Entry hash</th></tr></thead>
            <tbody>{revs.map((r) => (
              <tr key={r.entry_hash} className="border-b last:border-0"><td className="p-3 font-mono text-xs">{r.id_code}</td><td>{r.reason}</td><td className="text-xs">{when(r.ts)}</td><td className="font-mono text-xs">{short(r.entry_hash)}</td></tr>))}</tbody>
          </table>
        </Card>
      ))}

      <Modal open={!!detail} title={`Block #${detail?.height ?? ''}`} onClose={() => setDetail(null)} footer={<Button onClick={() => setDetail(null)}>Close</Button>}>
        {detail && (
          <>
            <dl className="grid gap-1 text-xs">
              <div><dt className="inline text-muted">Time: </dt><dd className="inline">{when(detail.ts)}</dd></div>
              <div><dt className="inline text-muted">Previous header hash: </dt><dd className="inline break-all font-mono">{detail.prev_hash}</dd></div>
              <div><dt className="inline text-muted">Merkle root: </dt><dd className="inline break-all font-mono">{detail.merkle_root}</dd></div>
              <div><dt className="inline text-muted">Merkle path length: </dt><dd className="inline">{detail.records.length > 1 ? Math.ceil(Math.log2(detail.records.length)) : 0} hash(es) for {detail.records.length} record(s)</dd></div>
            </dl>
            <ul className="space-y-2" aria-label="Records in this block">
              {detail.records.map((r: any) => (
                <li key={r.id_code} className="rounded-lg border border-line p-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-sm font-semibold">{r.id_code}</span>
                    {r.revoked ? <Badge tone="danger">Revoked</Badge> : <Button size="sm" variant="danger" aria-label={`Revoke ${r.id_code}`} onClick={() => setRevokeCode(r.id_code)}>Revoke</Button>}
                  </div>
                  <p className="mt-1 break-all text-muted">leaf {short(r.leaf_hash)} · {r.commitments.length} salted commitments (no personal data)</p>
                </li>
              ))}
            </ul>
          </>
        )}
      </Modal>

      <Modal open={!!revokeCode} title={`Revoke ${revokeCode ?? ''}`} onClose={() => setRevokeCode(null)}
             footer={<><Button variant="secondary" onClick={() => setRevokeCode(null)}>Cancel</Button><Button variant="danger" disabled={reason.trim().length < 3} onClick={revoke}>Revoke ID</Button></>}>
        <p className="text-sm text-muted">The ID will fail verification everywhere and tracking will stop. This cannot be undone.</p>
        <TextInput label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} hint="Recorded in the public revocation list and the audit log." />
      </Modal>
    </AppShell>
  )
}
