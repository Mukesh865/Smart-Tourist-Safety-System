import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import ItineraryEditor, { type Itinerary } from './ItineraryEditor'

const start: Itinerary = { route: [], stops: [{ name: 'Hotel', lat: 25.5, lon: 91.8, hotel: true }, { name: 'View', lat: 25.6, lon: 91.9, hotel: false }] }

function Harness({ initial = start, spy }: { initial?: Itinerary; spy?: (v: Itinerary) => void }) {
  const [v, setV] = useState(initial)
  return <ItineraryEditor value={v} onChange={(x) => { setV(x); spy?.(x) }} />
}

test('lists stops and lets the officer rename one', async () => {
  const spy = vi.fn()
  render(<Harness spy={spy} />)
  const u = userEvent.setup()
  const name = screen.getByLabelText('Stop 2 name')
  await u.clear(name)
  await u.type(name, 'Waterfall')
  expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ stops: [expect.anything(), expect.objectContaining({ name: 'Waterfall' })] }))
})

test('exactly one stop is the hotel; choosing another moves the flag', async () => {
  const spy = vi.fn()
  render(<Harness spy={spy} />)
  const radios = screen.getAllByRole('radio')
  await userEvent.setup().click(radios[1])
  expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ stops: [expect.objectContaining({ hotel: false }), expect.objectContaining({ hotel: true })] }))
})

test('removing the hotel promotes the next stop to hotel', async () => {
  const spy = vi.fn()
  render(<Harness spy={spy} />)
  await userEvent.setup().click(screen.getByRole('button', { name: 'Remove stop 1' }))
  const last = spy.mock.calls.at(-1)![0] as Itinerary
  expect(last.stops).toHaveLength(1)
  expect(last.stops[0]).toMatchObject({ name: 'View', hotel: true })
})

test('use stops as route copies the stops in order; clear route empties it', async () => {
  const spy = vi.fn()
  render(<Harness spy={spy} />)
  const u = userEvent.setup()
  await u.click(screen.getByRole('button', { name: 'Use stops as route' }))
  expect((spy.mock.calls.at(-1)![0] as Itinerary).route).toEqual([[25.5, 91.8], [25.6, 91.9]])
  expect(screen.getByText('2 route point(s)')).toBeInTheDocument()
  await u.click(screen.getByRole('button', { name: 'Clear route' }))
  expect((spy.mock.calls.at(-1)![0] as Itinerary).route).toEqual([])
})

test('use-stops-as-route needs two stops; mode switch changes the hint', async () => {
  render(<Harness initial={{ route: [], stops: [start.stops[0]] }} />)
  expect(screen.getByRole('button', { name: 'Use stops as route' })).toBeDisabled()
  expect(screen.getByText(/add a planned stop/i)).toBeInTheDocument()
  await userEvent.setup().click(screen.getByRole('tab', { name: 'Draw route' }))
  expect(screen.getByText(/points along the planned route/i)).toBeInTheDocument()
})
