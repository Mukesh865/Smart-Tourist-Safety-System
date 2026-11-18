import { useEffect, useState } from 'react'

export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine))
  useEffect(() => {
    const up = () => setOnline(true), down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down) }
  }, [])
  return online
}

interface InstallEvent extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }

/** "Add to home screen". Only available where the browser offers the install prompt (Chrome/Edge/Android). */
export function useInstallPrompt() {
  const [ev, setEv] = useState<InstallEvent | null>(null)
  const [installed, setInstalled] = useState(false)
  useEffect(() => {
    const onPrompt = (e: Event) => { e.preventDefault(); setEv(e as InstallEvent) }
    const onInstalled = () => { setInstalled(true); setEv(null) }
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => { window.removeEventListener('beforeinstallprompt', onPrompt); window.removeEventListener('appinstalled', onInstalled) }
  }, [])
  const standalone = typeof window !== 'undefined' && !!window.matchMedia?.('(display-mode: standalone)').matches
  return {
    canInstall: !!ev && !installed && !standalone,
    installed: installed || standalone,
    async install() {
      if (!ev) return
      await ev.prompt()
      const { outcome } = await ev.userChoice
      if (outcome === 'accepted') setEv(null)
    },
  }
}
