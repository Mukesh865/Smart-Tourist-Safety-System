import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../store'
import Zones from './Zones'

const zone = { id: 5, name: 'Cliff Edge', polygon: [[25.57, 91.89], [25.58, 91.89], [25.58, 91.9]] as [number, number][], risk_weight: 0.8, no_entry: false }

beforeEach(() => {
  vi.restoreAllMocks()
  useAuth.setState({ loading: false, user: { id: 1, email: 'p@x.com', full_name: 'P', role: 'police', language: 'en' } })
})

const renderIt = () => render(<MemoryRouter><Zones /></MemoryRouter>)

test('lists existing zones', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ data: [zone] })
  renderIt()
  await waitFor(() => expect(screen.getByText('Cliff Edge')).toBeInTheDocument())
  expect(screen.getByText(/risk 0\.8/)).toBeInTheDocument()
})

test('save is disabled until a name and 3 corners exist', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ data: [] })
  renderIt()
  await waitFor(() => expect(screen.getByText('No zones yet.')).toBeInTheDocument())
  const u = userEvent.setup()
  await u.type(screen.getByLabelText(/^name/i), 'New')
  expect(screen.getByRole('button', { name: 'Save zone' })).toBeDisabled() // no corners clicked
})

test('delete calls the API and reloads', async () => {
  const get = vi.spyOn(api, 'get').mockResolvedValueOnce({ data: [zone] }).mockResolvedValueOnce({ data: [] })
  const del = vi.spyOn(api, 'delete').mockResolvedValue({})
  renderIt()
  const u = userEvent.setup()
  await u.click(await screen.findByRole('button', { name: 'Delete Cliff Edge' }))
  expect(del).not.toHaveBeenCalled()                                         // asks first
  await u.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
  expect(del).toHaveBeenCalledWith('/zones/5')
  await waitFor(() => expect(screen.getByText('No zones yet.')).toBeInTheDocument())
  expect(get).toHaveBeenCalledTimes(2)
})

test('edit loads the zone into the form and saves with PUT; presets set the risk', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ data: [zone] })
  const put = vi.spyOn(api, 'put').mockResolvedValue({ data: {} })
  renderIt()
  const u = userEvent.setup()
  await u.click(await screen.findByRole('button', { name: 'Edit Cliff Edge' }))
  expect(screen.getByRole('heading', { name: 'Edit zone: Cliff Edge' })).toBeInTheDocument()
  const name = screen.getByLabelText(/^name/i)
  expect(name).toHaveValue('Cliff Edge')
  await u.clear(name); await u.type(name, 'Cliff Edge North')
  await u.click(screen.getByRole('button', { name: 'High' }))
  await u.click(screen.getByRole('button', { name: 'Update zone' }))
  expect(put).toHaveBeenCalledWith('/zones/5', expect.objectContaining({ name: 'Cliff Edge North', risk_weight: 0.8, polygon: zone.polygon }))
  await waitFor(() => expect(screen.getByRole('heading', { name: 'New zone' })).toBeInTheDocument())
})

test('duplicate prepares a new zone from an existing one', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ data: [zone] })
  const post = vi.spyOn(api, 'post').mockResolvedValue({ data: {} })
  renderIt()
  const u = userEvent.setup()
  await u.click(await screen.findByRole('button', { name: 'Duplicate Cliff Edge' }))
  expect(screen.getByLabelText(/^name/i)).toHaveValue('Cliff Edge copy')
  await u.click(screen.getByRole('button', { name: 'Save zone' }))
  expect(post).toHaveBeenCalledWith('/zones', expect.objectContaining({ name: 'Cliff Edge copy' }))
})

test('import reports the outcome and failures; export is disabled with no zones', async () => {
  vi.spyOn(api, 'get').mockResolvedValue({ data: [] })
  const post = vi.spyOn(api, 'post').mockResolvedValueOnce({ data: { added: 2, skipped: 1 } })
  renderIt()
  const u = userEvent.setup()
  expect(await screen.findByRole('button', { name: 'Export GeoJSON' })).toBeDisabled()
  const file = (txt: string) => new File([txt], 'z.geojson', { type: 'application/json' })
  await u.upload(screen.getByLabelText('GeoJSON file'), file('{"type":"FeatureCollection","features":[]}'))
  expect(await screen.findByText('Imported 2 zone(s), skipped 1 with an existing name.')).toBeInTheDocument()
  post.mockRejectedValueOnce({ response: { data: { detail: 'Feature 2: only Polygon geometries are supported' } } })
  await u.upload(screen.getByLabelText('GeoJSON file'), file('{"type":"FeatureCollection","features":[]}'))
  expect(await screen.findByText(/Import failed: Feature 2/)).toBeInTheDocument()
  await u.upload(screen.getByLabelText('GeoJSON file'), file('not json'))
  expect(await screen.findByText(/not valid GeoJSON/)).toBeInTheDocument()
})
