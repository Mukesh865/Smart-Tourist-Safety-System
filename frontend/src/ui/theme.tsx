import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type ThemePref = 'light' | 'dark' | 'system'
const KEY = 'ts_theme'

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch { /* storage blocked */ }
  return 'system'
}

export const systemPrefersDark = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches

export function resolve(pref: ThemePref): 'light' | 'dark' {
  return pref === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : pref
}

interface Ctx { pref: ThemePref; theme: 'light' | 'dark'; setPref: (p: ThemePref) => void; toggle: () => void }
const ThemeCtx = createContext<Ctx>({ pref: 'system', theme: 'light', setPref: () => {}, toggle: () => {} })

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(readPref)
  const [theme, setTheme] = useState<'light' | 'dark'>(() => resolve(readPref()))

  useEffect(() => {
    const apply = () => {
      const t = resolve(pref)
      setTheme(t)
      document.documentElement.classList.toggle('dark', t === 'dark')
    }
    apply()
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    mq?.addEventListener?.('change', apply)   // follow the OS while the preference is "system"
    return () => mq?.removeEventListener?.('change', apply)
  }, [pref])

  const setPref = useCallback((p: ThemePref) => {
    setPrefState(p)
    try { localStorage.setItem(KEY, p) } catch { /* ignore */ }
  }, [])
  const toggle = useCallback(() => setPref(resolve(pref) === 'dark' ? 'light' : 'dark'), [pref, setPref])
  const value = useMemo(() => ({ pref, theme, setPref, toggle }), [pref, theme, setPref, toggle])
  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>
}

export const useTheme = () => useContext(ThemeCtx)
