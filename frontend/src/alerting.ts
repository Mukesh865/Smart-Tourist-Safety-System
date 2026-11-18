/** Audible and desktop notification for new panic alerts while the dashboard is open. Both are opt-in and
 *  every call is guarded: browsers block audio until the user has interacted, and Notification may be absent. */
const SOUND_KEY = 'ts_alert_sound'

export const soundEnabled = (): boolean => {
  try { return localStorage.getItem(SOUND_KEY) !== 'off' } catch { return true }
}
export const setSoundEnabled = (on: boolean) => {
  try { localStorage.setItem(SOUND_KEY, on ? 'on' : 'off') } catch { /* storage blocked */ }
}

let ctx: AudioContext | null = null

/** Two short rising tones, generated with WebAudio (no audio file needed). Returns false if it could not play. */
export function beep(): boolean {
  try {
    const AC = (window as any).AudioContext ?? (window as any).webkitAudioContext
    if (!AC) return false
    ctx = ctx ?? new AC()
    if (ctx!.state === 'suspended') void ctx!.resume()
    const now = ctx!.currentTime
    for (const [i, freq] of [660, 880].entries()) {
      const osc = ctx!.createOscillator()
      const gain = ctx!.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, now + i * 0.22)
      gain.gain.exponentialRampToValueAtTime(0.25, now + i * 0.22 + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.22 + 0.2)
      osc.connect(gain).connect(ctx!.destination)
      osc.start(now + i * 0.22)
      osc.stop(now + i * 0.22 + 0.22)
    }
    return true
  } catch { return false }
}

export const notificationsSupported = () => typeof Notification !== 'undefined'
export const notificationPermission = (): NotificationPermission | 'unsupported' =>
  notificationsSupported() ? Notification.permission : 'unsupported'

export async function askNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!notificationsSupported()) return 'unsupported'
  try { return await Notification.requestPermission() } catch { return Notification.permission }
}

export function notify(title: string, body: string): boolean {
  try {
    if (!notificationsSupported() || Notification.permission !== 'granted') return false
    new Notification(title, { body, tag: 'panic-alert', requireInteraction: true })
    return true
  } catch { return false }
}
