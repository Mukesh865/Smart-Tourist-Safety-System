import { QRCodeSVG } from 'qrcode.react'
import { Badge, Button } from '../ui'

/** Printable ID card. The QR is the signed credential; it carries no personal data. */
export default function IdCard({ name, idCode, payload, validFrom, validTo, revoked }:
  { name?: string; idCode: string; payload: string; validFrom?: string | null; validTo?: string | null; revoked?: boolean }) {
  const fmt = (d?: string | null) => (d ? new Date(d).toLocaleDateString() : '-')
  return (
    <div className="space-y-3">
      <div className="print-area mx-auto w-full max-w-xs rounded-2xl border-2 border-brand bg-white p-5 text-center text-slate-900 shadow">
        <p className="text-xs font-bold uppercase tracking-widest text-teal-800">Digital Tourist ID</p>
        {name && <p className="mt-1 text-lg font-bold">{name}</p>}
        <div className="my-3 flex justify-center">
          <QRCodeSVG value={payload} size={200} level="L" title={`QR code for ${idCode}`} />
        </div>
        <p className="font-mono text-base font-semibold">{idCode}</p>
        <p className="mt-1 text-xs text-slate-600">Valid {fmt(validFrom)} to {fmt(validTo)}</p>
        {revoked && <p className="mt-2 text-sm font-bold text-red-700">REVOKED - do not accept</p>}
        <p className="mt-3 text-[10px] text-slate-500">Verify at a check-post or on the Verify page. Contains no personal data.</p>
      </div>
      <div className="flex justify-center print:hidden"><Button variant="secondary" onClick={() => window.print()}>Print ID card</Button></div>
      {revoked && <div className="flex justify-center print:hidden"><Badge tone="danger">This ID is revoked</Badge></div>}
    </div>
  )
}
