import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { api, TOKEN_KEY } from '../api'
import { useAuth } from '../store'
import Evaluation from './Evaluation'

const rows = [
  { measure: 'ID check time', limit: '< 1,000 us', measured: 106.2, unit: 'us', status: 'met', note: 'x' },
  { measure: 'False anomaly alerts / 100 days', limit: '<= 5', measured: 12, unit: '', status: 'NOT MET', note: 'y' },
  { measure: 'SUS usability score', limit: '>= 71.4', measured: '-', unit: '', status: 'next stage', note: 'z' },
]

beforeEach(() => {
  vi.restoreAllMocks()
  useAuth.setState({ loading: false, user: { id: 1, email: 'p@x.com', full_name: 'P', role: 'police', language: 'en' } })
})

test('runs quick checks and shows met / not met / next stage rows', async () => {
  const get = vi.spyOn(api, 'get').mockResolvedValue({ data: { rows } })
  render(<MemoryRouter><Evaluation /></MemoryRouter>)
  await userEvent.setup().click(screen.getByRole('button', { name: 'Run quick checks' }))
  await waitFor(() => expect(screen.getByText('ID check time')).toBeInTheDocument())
  expect(get.mock.calls[0][0]).toBe('/evaluation/table5?detection=false')
  expect(screen.getByText('met')).toBeInTheDocument()
  expect(screen.getByText('NOT MET')).toBeInTheDocument()
  expect(screen.getByText('next stage')).toBeInTheDocument()
})

test('detection button requests the long benchmark; errors are shown', async () => {
  const get = vi.spyOn(api, 'get').mockRejectedValue(new Error('x'))
  render(<MemoryRouter><Evaluation /></MemoryRouter>)
  await userEvent.setup().click(screen.getByRole('button', { name: /Include detection benchmark/ }))
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not run'))
  expect(get.mock.calls[0][0]).toBe('/evaluation/table5?detection=true')
})

test('a 401 from any API call signs the user out', async () => {
  localStorage.setItem(TOKEN_KEY, 'expired')
  const adapter = vi.fn().mockRejectedValue({ response: { status: 401 }, config: { url: '/zones' } })
  await expect(api.get('/zones', { adapter } as any)).rejects.toBeTruthy()
  expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
  expect(useAuth.getState().user).toBeNull()
})

test('a wrong password on the login call does not trigger sign-out handling', async () => {
  localStorage.setItem(TOKEN_KEY, 'still-valid')
  const adapter = vi.fn().mockRejectedValue({ response: { status: 401 }, config: { url: '/auth/login' } })
  await expect(api.post('/auth/login', {}, { adapter } as any)).rejects.toBeTruthy()
  expect(localStorage.getItem(TOKEN_KEY)).toBe('still-valid')
})
