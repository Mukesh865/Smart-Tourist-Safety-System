import { useState, type ReactNode } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { api } from '../api'
import { homeFor, useAuth, type Role } from '../store'
import { useT, type Key } from '../i18n'
import { IconChart, IconCog, IconMap as IconMapTab, IconUsers, IconClipboard, IconHome, IconLogout, IconMap, IconMenu, IconMoon, IconQr, IconShield, IconSun, useTheme } from '../ui'

interface NavItem { to: string; label: string; icon: ReactNode; roles: Role[]; end?: boolean; key?: Key }

const NAV: NavItem[] = [
  { to: '/dashboard', label: 'Dashboard', icon: <IconShield />, roles: ['police', 'admin'] },
  { to: '/zones', label: 'Risk zones', icon: <IconMap />, roles: ['police', 'admin'] },
  { to: '/officer', label: 'Issue ID', icon: <IconClipboard />, roles: ['officer', 'admin'] },
  { to: '/tourists', label: 'Tourists', icon: <IconUsers />, roles: ['officer', 'admin'] },
  { to: '/ledger', label: 'Ledger', icon: <IconShield />, roles: ['police', 'admin'] },
  { to: '/analytics', label: 'Analytics', icon: <IconChart />, roles: ['police', 'admin'] },
  { to: '/evaluation', label: 'Evaluation', icon: <IconChart />, roles: ['police', 'admin'] },
  { to: '/verify', label: 'Verify ID', icon: <IconQr />, roles: ['police', 'officer', 'admin'] },
  { to: '/calibration', label: 'Calibration', icon: <IconCog />, roles: ['admin'] },
  { to: '/admin', label: 'Administration', icon: <IconUsers />, roles: ['admin'] },
  { to: '/profile', label: 'Profile', icon: <IconCog />, roles: ['police', 'officer', 'admin'] },
]
const TOURIST_TABS: NavItem[] = [
  { to: '/tourist', label: 'Home', key: 'tabHome', icon: <IconHome />, roles: ['tourist'], end: true },
  { to: '/tourist/map', label: 'Map', key: 'tabMap', icon: <IconMapTab />, roles: ['tourist'] },
  { to: '/tourist/safety', label: 'Safety', key: 'tabSafety', icon: <IconShield />, roles: ['tourist'] },
  { to: '/tourist/id', label: 'ID', key: 'tabId', icon: <IconQr />, roles: ['tourist'] },
  { to: '/tourist/settings', label: 'Settings', key: 'tabSettings', icon: <IconCog />, roles: ['tourist'] },
]

const linkCls = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${isActive ? 'bg-brand/15 text-brand-ink' : 'text-muted hover:bg-sunken hover:text-ink'}`

export function ThemeToggle() {
  const { theme, toggle } = useTheme()
  return (
    <button onClick={toggle} className="grid h-10 w-10 place-items-center rounded-lg text-muted hover:bg-sunken hover:text-ink"
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
      {theme === 'dark' ? <IconSun /> : <IconMoon />}
    </button>
  )
}

function LanguageSwitch() {
  const { user } = useAuth()
  async function change(language: string) {
    try { await api.put('/me/language', { language }) } catch { /* keep UI language even if offline */ }
    useAuth.setState((s) => ({ user: s.user ? { ...s.user, language } : s.user }))
  }
  return (
    <select aria-label="Interface language" value={user?.language ?? 'en'} onChange={(e) => change(e.target.value)}
            className="h-10 rounded-lg border border-line bg-surface px-2 text-sm">
      <option value="en">EN</option>
      <option value="hi">हिं</option>
    </select>
  )
}

function Brand() {
  return (
    <span className="flex items-center gap-2 font-bold">
      <span className="grid h-8 w-8 place-items-center rounded-lg bg-brand text-white dark:text-slate-950"><IconShield width={18} height={18} /></span>
      Tourist Safety
    </span>
  )
}

export default function AppShell({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  const { user, logout } = useAuth()
  const nav = useNavigate()
  const t = useT()
  const [open, setOpen] = useState(false)
  const isTourist = user?.role === 'tourist'
  const items = isTourist ? TOURIST_TABS : NAV.filter((n) => user && n.roles.includes(user.role))
  const signOut = () => { logout(); nav('/login') }

  const sidebar = (
    <nav aria-label="Main" className="flex flex-col gap-1">
      {items.map((n) => (
        <NavLink key={n.to} to={n.to} className={linkCls} onClick={() => setOpen(false)}>{n.icon}{n.label}</NavLink>
      ))}
    </nav>
  )

  return (
    <div className="min-h-full">
      <a href="#content" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:p-2">Skip to content</a>

      {!isTourist && (
        <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-line bg-surface p-4 md:flex">
          <div className="mb-6 px-1"><Brand /></div>
          {sidebar}
          <div className="mt-auto rounded-lg bg-sunken p-3 text-xs text-muted">
            <p className="font-semibold text-ink">{user?.full_name}</p>
            <p className="capitalize">{user?.role}</p>
          </div>
        </aside>
      )}

      {!isTourist && open && (
        <div className="fixed inset-0 z-40 md:hidden" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-black/50" />
          <aside className="absolute inset-y-0 left-0 w-64 bg-surface p-4" onClick={(e) => e.stopPropagation()}>
            <div className="mb-6"><Brand /></div>
            {sidebar}
          </aside>
        </div>
      )}

      <div className={isTourist ? '' : 'md:pl-60'}>
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-line bg-surface/90 px-3 backdrop-blur sm:px-5">
          {!isTourist && (
            <button className="grid h-10 w-10 place-items-center rounded-lg hover:bg-sunken md:hidden" aria-label="Open menu" onClick={() => setOpen(true)}><IconMenu /></button>
          )}
          {isTourist && <Brand />}
          <div className="ml-auto flex items-center gap-1">
            <LanguageSwitch />
            <ThemeToggle />
            <button onClick={signOut} aria-label="Log out" className="flex h-10 items-center gap-2 rounded-lg px-3 text-sm text-muted hover:bg-sunken hover:text-ink">
              <IconLogout /><span className="hidden sm:inline">Log out</span>
            </button>
          </div>
        </header>

        <main id="content" className={`mx-auto w-full p-4 sm:p-6 ${isTourist ? 'max-w-2xl pb-28' : 'max-w-7xl'}`}>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
            {actions}
          </div>
          {children}
        </main>
      </div>

      {isTourist && (
        <nav aria-label="Tabs" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
          {items.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end}
                     className={({ isActive }) => `flex min-h-[3.5rem] flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${isActive ? 'text-brand-ink' : 'text-muted'}`}>
              {n.icon}{n.key ? t(n.key) : n.label}
            </NavLink>
          ))}
        </nav>
      )}
    </div>
  )
}

export { homeFor }
