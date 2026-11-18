import { useEffect, useRef, useState, type FormEvent } from 'react'
import { api } from '../../api'
import ItineraryEditor, { DEFAULT_CENTER, type Itinerary } from '../../components/ItineraryEditor'
import { Badge, Button, Card, TextInput, useToast } from '../../ui'
import { useTourist } from './TouristContext'

// the visitor's LOCAL calendar date (toISOString would give yesterday's date for anyone ahead of UTC just after midnight)
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const today = () => ymd(new Date())
const plus = (d: number) => ymd(new Date(Date.now() + d * 864e5))
const errText = (e: any) => {
  const d = e?.response?.data?.detail
  if (typeof d === 'string') return d
  if (Array.isArray(d) && d[0]?.msg) return String(d[0].msg).replace(/^Value error, /, '')
  return 'Could not create your ID. Check the details and try again.'
}

/** Self-service digital ID: no visit to an office. The ID is "self-declared" until an officer checks the document. */
export default function ApplyId() {
  const toast = useToast()
  const { reloadCred } = useTourist()
  const [kycType, setKycType] = useState('Passport')
  const [kyc, setKyc] = useState('')
  const [from, setFrom] = useState(today())
  const [to, setTo] = useState(plus(7))
  const [itin, setItin] = useState<Itinerary>({ route: [], stops: [{ name: 'Hotel', lat: DEFAULT_CENTER[0], lon: DEFAULT_CENTER[1], hotel: true }] })
  const [contacts, setContacts] = useState([{ name: '', phone: '' }])
  const [agree, setAgree] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const touched = useRef(false)                 // true once the visitor has moved/added a stop themselves

  // Start the hotel pin at the visitor's real position instead of a fixed demo location (wrong anywhere but Shillong,
  // and it would make route/inactivity alerts fire from the first minute).
  useEffect(() => {
    if (!('geolocation' in navigator) || typeof navigator.geolocation.getCurrentPosition !== 'function') return
    try { navigator.geolocation.getCurrentPosition((p) => {
      if (touched.current) return
      setItin((v) => ({ ...v, stops: v.stops.map((s, i) => (i === 0 ? { ...s, lat: +p.coords.latitude.toFixed(6), lon: +p.coords.longitude.toFixed(6) } : s)) }))
    }, () => {}, { timeout: 8000 }) } catch { /* location unavailable: the visitor places the pin by hand */ }
  }, [])

  const badDates = to < from || from < today()
  const ready = kyc.trim().length >= 4 && !badDates && itin.stops.length > 0 && itin.stops.every((s) => s.name.trim())
    && contacts.every((c) => c.name.trim() && c.phone.trim().length >= 5) && agree

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      await api.post('/ledger/apply', {
        kyc_number: kyc, route: itin.route, stops: itin.stops, contacts, declaration: agree,
        valid_from: `${from}T00:00:00Z`, valid_to: `${to}T23:59:59Z`,
      })
      toast('Your digital ID is ready', { kind: 'success' })
      await reloadCred()
    } catch (err) { setError(errText(err)) }
    finally { setBusy(false) }
  }

  return (
    <form onSubmit={submit} className="space-y-4" aria-label="Create your digital ID">
      <Card className="space-y-2 p-4">
        <div className="flex items-center gap-2"><h2 className="text-lg font-bold">Get your digital ID</h2><Badge tone="brand">No office visit</Badge></div>
        <p className="text-sm text-muted">Create your tourist ID in a few minutes. Only salted hashes are stored on the ledger; your details stay encrypted and are erased after your trip.
          Your ID is marked <b>self-declared</b> until an officer checks your document at any check-post.</p>
      </Card>

      <Card className="space-y-3 p-4">
        <h3 className="font-semibold">1. Identity document</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1 text-sm font-medium">Document type
            <select className="input" value={kycType} onChange={(e) => setKycType(e.target.value)}>
              <option>Passport</option><option>Aadhaar</option><option>Driving licence</option><option>Voter ID</option>
            </select></label>
          <TextInput label={`${kycType} number`} value={kyc} onChange={(e) => setKyc(e.target.value)} autoComplete="off" required minLength={4} maxLength={40}
                     hint="One document can have only one active ID." />
        </div>
      </Card>

      <Card className="space-y-3 p-4">
        <h3 className="font-semibold">2. Dates of your visit</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInput label="Valid from" type="date" value={from} min={today()} onChange={(e) => setFrom(e.target.value)} required />
          <TextInput label="Valid to" type="date" value={to} min={from} max={plus(90)} onChange={(e) => setTo(e.target.value)} required
                     error={to < from ? 'Must be on or after the start date' : undefined} hint="Up to 90 days." />
        </div>
      </Card>

      <Card className="space-y-3 p-4">
        <h3 className="font-semibold">3. Where are you staying and going?</h3>
        <p className="text-xs text-muted">Tap the map to place your hotel (first stop) and places you plan to visit. Alerts for going missing or leaving your route use this plan.</p>
        <ItineraryEditor key={`${itin.stops[0]?.lat}`} value={itin} onChange={(v) => { touched.current = true; setItin(v) }} height="h-64" />
      </Card>

      <Card className="space-y-3 p-4">
        <h3 className="font-semibold">4. Emergency contacts</h3>
        {contacts.map((c, i) => (
          <div key={i} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <TextInput label={`Contact ${i + 1} name`} value={c.name} required onChange={(e) => setContacts(contacts.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} />
            <TextInput label={`Contact ${i + 1} phone`} value={c.phone} required minLength={5} inputMode="tel" onChange={(e) => setContacts(contacts.map((x, k) => (k === i ? { ...x, phone: e.target.value } : x)))} />
            {i > 0 && <Button type="button" variant="ghost" onClick={() => setContacts(contacts.filter((_, k) => k !== i))}>Remove</Button>}
          </div>
        ))}
        {contacts.length < 3 && <Button type="button" size="sm" variant="secondary" onClick={() => setContacts([...contacts, { name: '', phone: '' }])}>Add another contact</Button>}
      </Card>

      <Card className="space-y-3 p-4">
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          <span>I confirm these details are true and that they belong to me. I understand my location is shared with the tourism control room during my visit, and my details are deleted after it ends.</span>
        </label>
        {error && <p role="alert" className="rounded-lg bg-danger/10 p-2 text-sm text-danger">{error}</p>}
        <Button type="submit" loading={busy} disabled={!ready} className="w-full">Create my digital ID</Button>
      </Card>
    </form>
  )
}
