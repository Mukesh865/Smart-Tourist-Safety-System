import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { askNotificationPermission, beep, notificationPermission, notify, setSoundEnabled, soundEnabled } from './alerting'

beforeEach(() => { localStorage.clear() })
afterEach(() => { vi.unstubAllGlobals(); delete (window as any).AudioContext })

describe('sound preference', () => {
  test('defaults to on, can be switched off and back, survives broken storage', () => {
    expect(soundEnabled()).toBe(true)
    setSoundEnabled(false)
    expect(soundEnabled()).toBe(false)
    setSoundEnabled(true)
    expect(soundEnabled()).toBe(true)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
    expect(soundEnabled()).toBe(true)
    vi.restoreAllMocks()
  })
})

describe('beep', () => {
  test('returns false where WebAudio is missing', () => {
    expect(beep()).toBe(false)
  })

  test('plays two tones with a fading envelope and resumes a suspended context', () => {
    const osc = { type: '', frequency: { value: 0 }, connect: vi.fn().mockReturnThis(), start: vi.fn(), stop: vi.fn() }
    const gain = { gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: vi.fn().mockReturnThis() }
    const resume = vi.fn()
    class Ctx { state = 'suspended'; currentTime = 1; destination = {}; resume = resume; createOscillator = () => osc; createGain = () => gain }
    ;(window as any).AudioContext = Ctx
    expect(beep()).toBe(true)
    expect(resume).toHaveBeenCalled()
    expect(osc.start).toHaveBeenCalledTimes(2)
    expect(gain.gain.exponentialRampToValueAtTime).toHaveBeenCalledTimes(4)
  })

  test('never throws if the audio engine fails', async () => {
    vi.resetModules()                                   // a fresh module has no cached audio context
    const fresh = await import('./alerting')
    ;(window as any).AudioContext = class { constructor() { throw new Error('blocked') } }
    expect(fresh.beep()).toBe(false)
  })
})

describe('desktop notifications', () => {
  test('unsupported browsers are handled', async () => {
    vi.stubGlobal('Notification', undefined)
    expect(notificationPermission()).toBe('unsupported')
    expect(await askNotificationPermission()).toBe('unsupported')
    expect(notify('t', 'b')).toBe(false)
  })

  test('only fires when permission was granted', async () => {
    const ctor = vi.fn()
    const N: any = function (this: any, ...a: any[]) { ctor(...a) }
    N.permission = 'default'
    N.requestPermission = vi.fn(async () => { N.permission = 'granted'; return 'granted' })
    vi.stubGlobal('Notification', N)
    expect(notify('PANIC', 'x')).toBe(false)
    expect(await askNotificationPermission()).toBe('granted')
    expect(notify('PANIC', 'x')).toBe(true)
    expect(ctor).toHaveBeenCalledWith('PANIC', expect.objectContaining({ body: 'x', requireInteraction: true }))
  })

  test('a denied request is reported and the prompt error is swallowed', async () => {
    const N: any = function () {}
    N.permission = 'denied'
    N.requestPermission = vi.fn(async () => { throw new Error('nope') })
    vi.stubGlobal('Notification', N)
    expect(await askNotificationPermission()).toBe('denied')
    expect(notify('t', 'b')).toBe(false)
  })
})
