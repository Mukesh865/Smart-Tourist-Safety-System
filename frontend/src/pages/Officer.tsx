import { useState } from 'react'
import { api } from '../api'
import AppShell from '../components/AppShell'
import IdCard from '../components/IdCard'
import ItineraryEditor, { DEFAULT_CENTER, type Itinerary } from '../components/ItineraryEditor'
import { Badge, Button, Card, IconEye, TextInput, useToast } from '../ui'

const today = () => new Date().toISOString().slice(0, 10)
const plus = (d: number) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10)

const STEPS = ['Tourist', 'Identity', 'Itinerary', 'Contacts', 'Review'] as const
type Contact = { name: string; phone: string }
interface Found { name: string; email: string; status: string }

const initialItinerary = (): Itinerary => ({ route: [], stops: [{ name: 'Hotel', lat: DEFAULT_CENTER[0], lon: DEFAULT_CENTER[1], hotel: true }] })
const errText = (e: any, d: string) => (typeof e?.response?.data?.detail === 'string' ? e.response.data.detail : d)

export default function Officer() {
  const toast = useToast()
  const [step, setStep] = useState(0)
  const [email, setEmail] = useState('')
  const [found, setFound] = useState<Found | null>(null)
  const [kyc, setKyc] = useState('')
  const [reveal, setReveal] = useState(false)
  const [itin, setItin] = useState<Itinerary>(initialItinerary)
  const [contacts, setContacts] = useState<Contact[]>([{ name: '', phone: '' }])
  const [from, setFrom] = useState(today())
  const [to, setTo] = useState(plus(7))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ id_code: string; payload: string } | null>(null)

  const hotel = itin.stops.find((s) => s.hotel) ?? itin.stops[0]
  const setHotelName = (name: string) => setItin({ ...itin, stops: itin.stops.map((s) => (s === hotel ? { ...s, name } : s)) })

  const valid = [
    email.includes('@'),
    kyc.trim().length >= 4,
    itin.stops.length >= 1 && itin.stops.every((s) => s.name.trim()),
    contacts.every((c) => c.name.trim() && c.phone.trim().length >= 5) && from <= to && to >= today(),
    true,
  ][step]

  async function next() {
    setError('')
    if (step === 0) await lookup()
    else setStep((s) => Math.min(s + 1, STEPS.length - 1))
  }

  async function lookup() {
    setBusy(true)
    try {
      const { data } = await api.get('/tourists', { params: { q: email.trim(), limit: 5 } })
      const hit = data.items.find((t: any) => t.email.toLowerCase() === email.trim().toLowerCase())
      if (!hit) setError('No tourist account with that email. Ask the visitor to register first.')
      else if (hit.status !== 'no_id') setError(`This visitor already has an ID (${hit.status}). Use Extend on the Tourists page instead.`)
      else { setFound({ name: hit.name, email: hit.email, status: hit.status }); setStep(1) }
    } catch (e) { setError(errText(e, 'Could not look up the visitor')) }
    finally { setBusy(false) }
  }

  async function issue() {
    setBusy(true); setError('')
    try {
      const { data } = await api.post('/ledger/issue', {
        tourist_email: found!.email,
        kyc_number: kyc,
        stops: itin.stops,
        route: itin.route,
        contacts,
        valid_from: `${from}T00:00:00Z`,
        valid_to: `${to}T23:59:59Z`,
      })
      setResult(data)
      toast(`ID ${data.id_code} issued`, { kind: 'success' })
    } catch (e) { setError(errText(e, 'Could not issue the ID. Check the details.')) }
    finally { setBusy(false) }
  }

  function reset() {
    setStep(0); setEmail(''); setFound(null); setKyc(''); setItin(initialItinerary()); setContacts([{ name: '', phone: '' }])
    setFrom(today()); setTo(plus(7)); setResult(null); setError('')
  }

  if (result) {
    return (
      <AppShell title="Issue Digital Tourist ID">
        <Card className="mx-auto max-w-md space-y-4 p-6 text-center">
          <Badge tone="ok">Issued</Badge>
          <p className="font-semibold">Issued {result.id_code}</p>
          <IdCard name={found?.name} idCode={result.id_code} payload={result.payload} validFrom={`${from}T00:00:00Z`} validTo={`${to}T23:59:59Z`} />
          <p className="text-xs text-muted">{result.payload.length} bytes in the QR. The tourist sees this in their app.</p>
          <Button onClick={reset}>Issue another ID</Button>
        </Card>
      </AppShell>
    )
  }

  return (
    <AppShell title="Issue Digital Tourist ID">
      <p className="mb-4 max-w-2xl text-sm text-muted">
        Verify the visitor's passport / Aadhaar in person, then issue the ID. Only salted hashes go on the ledger;
        personal details are stored encrypted off-chain and erased after the visit.
      </p>

      <ol className="mb-5 flex flex-wrap gap-2" aria-label="Progress">
        {STEPS.map((s, i) => (
          <li key={s} aria-current={i === step ? 'step' : undefined}
              className={`flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ${i === step ? 'bg-brand text-white dark:text-slate-950' : i < step ? 'bg-ok/15 text-ok' : 'bg-sunken text-muted'}`}>
            <span>{i < step ? '✓' : i + 1}</span>{s}
          </li>
        ))}
      </ol>

      <Card className="max-w-3xl space-y-4 p-5">
        {step === 0 && (
          <TextInput label="Tourist account email" type="email" required value={email}
                     onChange={(e) => { setEmail(e.target.value); setFound(null) }} hint="The visitor must have registered on the website first." />
        )}

        {step === 1 && (
          <>
            <p className="text-sm">Issuing for <b>{found?.name}</b> ({found?.email})</p>
            <div className="relative">
              <TextInput label="Passport / Aadhaar number" required minLength={4} autoComplete="off" type={reveal ? 'text' : 'password'}
                         value={kyc} onChange={(e) => setKyc(e.target.value)} hint="Checked against the original document. Stored encrypted, never on the ledger." />
              <button type="button" aria-label="Show or hide characters" aria-pressed={reveal} onClick={() => setReveal((v) => !v)}
                      className="absolute right-2 top-7 grid h-8 w-8 place-items-center rounded text-muted hover:text-ink"><IconEye width={18} height={18} /></button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <TextInput label="Hotel name" value={hotel?.name ?? ''} onChange={(e) => setHotelName(e.target.value)} />
            <p className="text-xs text-muted">The itinerary drives route-deviation and inactivity detection. Add the planned stops and route on the map.</p>
            <ItineraryEditor value={itin} onChange={setItin} />
          </>
        )}

        {step === 3 && (
          <>
            {contacts.map((c, i) => (
              <div key={i} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                <TextInput label={i === 0 ? 'Emergency contact name' : `Contact ${i + 1} name`} required value={c.name}
                           onChange={(e) => setContacts(contacts.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} />
                <TextInput label={i === 0 ? 'Emergency contact phone' : `Contact ${i + 1} phone`} required minLength={5} inputMode="tel" value={c.phone}
                           onChange={(e) => setContacts(contacts.map((x, k) => (k === i ? { ...x, phone: e.target.value } : x)))} />
                {i > 0 && <Button variant="ghost" onClick={() => setContacts(contacts.filter((_, k) => k !== i))}>Remove</Button>}
              </div>
            ))}
            {contacts.length < 3 && <Button variant="secondary" size="sm" onClick={() => setContacts([...contacts, { name: '', phone: '' }])}>Add another contact</Button>}
            <div className="grid gap-3 sm:grid-cols-2">
              <TextInput label="Valid from" type="date" required value={from} onChange={(e) => setFrom(e.target.value)} />
              <TextInput label="Valid to" type="date" required value={to} min={from} onChange={(e) => setTo(e.target.value)}
                         error={to < from ? 'Must be on or after the start date' : undefined} />
            </div>
          </>
        )}

        {step === 4 && (
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div><dt className="text-muted">Tourist</dt><dd className="font-medium">{found?.name} ({found?.email})</dd></div>
            <div><dt className="text-muted">ID document</dt><dd className="font-mono">{'•'.repeat(Math.max(0, kyc.length - 3))}{kyc.slice(-3)}</dd></div>
            <div><dt className="text-muted">Validity</dt><dd>{from} to {to}</dd></div>
            <div><dt className="text-muted">Itinerary</dt><dd>{itin.stops.length} stop(s), {itin.route.length} route point(s)</dd></div>
            <div className="sm:col-span-2"><dt className="text-muted">Emergency contacts</dt><dd>{contacts.map((c) => `${c.name} ${c.phone}`).join(', ')}</dd></div>
          </dl>
        )}

        {error && <p role="alert" className="rounded-lg bg-danger/10 p-2 text-sm text-danger">{error}</p>}

        <div className="flex justify-between pt-2">
          <Button variant="secondary" disabled={step === 0} onClick={() => { setError(''); setStep(step - 1) }}>Back</Button>
          {step < STEPS.length - 1
            ? <Button onClick={next} disabled={!valid} loading={busy}>Next</Button>
            : <Button onClick={issue} loading={busy}>Issue ID</Button>}
        </div>
      </Card>
    </AppShell>
  )
}
