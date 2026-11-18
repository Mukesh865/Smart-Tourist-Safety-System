import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import HoldButton from './HoldButton'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms) })

test('completes only after being held for the full duration', () => {
  const done = vi.fn()
  render(<HoldButton onComplete={done}>PANIC</HoldButton>)
  fireEvent.pointerDown(screen.getByRole('button', { name: 'PANIC' }))
  advance(1400)
  expect(done).not.toHaveBeenCalled()
  advance(300)
  expect(done).toHaveBeenCalledTimes(1)
})

test('releasing early cancels, and a later full hold still works', () => {
  const done = vi.fn()
  render(<HoldButton onComplete={done}>PANIC</HoldButton>)
  const b = screen.getByRole('button', { name: 'PANIC' })
  fireEvent.pointerDown(b); advance(1000); fireEvent.pointerUp(b); advance(2000)
  expect(done).not.toHaveBeenCalled()
  fireEvent.pointerDown(b); advance(1600)
  expect(done).toHaveBeenCalledTimes(1)
})

test('sliding the finger off the button cancels', () => {
  const done = vi.fn()
  render(<HoldButton onComplete={done}>PANIC</HoldButton>)
  const b = screen.getByRole('button', { name: 'PANIC' })
  fireEvent.pointerDown(b); advance(1000); fireEvent.pointerLeave(b); advance(2000)
  expect(done).not.toHaveBeenCalled()
})

test('works from the keyboard (hold Space or Enter) and ignores key repeat', () => {
  const done = vi.fn()
  render(<HoldButton onComplete={done}>PANIC</HoldButton>)
  const b = screen.getByRole('button', { name: 'PANIC' })
  fireEvent.keyDown(b, { key: ' ' })
  fireEvent.keyDown(b, { key: ' ', repeat: true })
  advance(1000)
  fireEvent.keyUp(b, { key: ' ' })
  advance(2000)
  expect(done).not.toHaveBeenCalled()                          // released early
  fireEvent.keyDown(b, { key: 'Enter' }); advance(1600)
  expect(done).toHaveBeenCalledTimes(1)
})

test('fires once per hold even if the user keeps pressing', () => {
  const done = vi.fn()
  render(<HoldButton onComplete={done}>PANIC</HoldButton>)
  fireEvent.pointerDown(screen.getByRole('button'))
  advance(5000)
  expect(done).toHaveBeenCalledTimes(1)
})

test('a disabled button never fires; losing focus cancels the hold', () => {
  const done = vi.fn()
  const { rerender } = render(<HoldButton onComplete={done} disabled>PANIC</HoldButton>)
  fireEvent.pointerDown(screen.getByRole('button')); advance(2000)
  expect(done).not.toHaveBeenCalled()
  rerender(<HoldButton onComplete={done}>PANIC</HoldButton>)
  const b = screen.getByRole('button')
  fireEvent.pointerDown(b); advance(800); fireEvent.blur(b); advance(2000)
  expect(done).not.toHaveBeenCalled()
})

test('vibrates when the hold completes (where supported)', () => {
  const vibrate = vi.fn()
  Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true })
  render(<HoldButton onComplete={() => {}}>PANIC</HoldButton>)
  fireEvent.pointerDown(screen.getByRole('button')); advance(1600)
  expect(vibrate).toHaveBeenCalled()
})
