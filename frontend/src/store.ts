import { create } from 'zustand'
import { api, TOKEN_KEY } from './api'

export type Role = 'tourist' | 'officer' | 'police' | 'admin'
export interface User {
  id: number
  email: string
  full_name: string
  role: Role
  language: string
}

const USER_KEY = 'ts_user'   // last known profile, so the installed app can open with no network

const readCachedUser = (): User | null => {
  try { return JSON.parse(localStorage.getItem(USER_KEY) ?? 'null') } catch { return null }
}
const cacheUser = (u: User | null) => {
  try { u ? localStorage.setItem(USER_KEY, JSON.stringify(u)) : localStorage.removeItem(USER_KEY) } catch { /* storage blocked */ }
}
const clearSession = () => {
  localStorage.removeItem(TOKEN_KEY)
  cacheUser(null)
  try { void caches?.delete('api-cache') } catch { /* Cache API unavailable */ }    // the service worker caches some API reads
}

interface AuthState {
  user: User | null
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  register: (email: string, full_name: string, password: string) => Promise<void>
  logout: () => void
  restore: () => Promise<void>
}

export const useAuth = create<AuthState>((set, get) => ({
  user: null,
  loading: true,
  async login(email, password) {
    const body = new URLSearchParams({ username: email, password })
    const { data } = await api.post('/auth/login', body)
    localStorage.setItem(TOKEN_KEY, data.access_token)
    cacheUser(data.user)
    set({ user: data.user })
  },
  async register(email, full_name, password) {
    await api.post('/auth/register', { email, full_name, password })
    await get().login(email, password)
  },
  logout() {
    clearSession()
    set({ user: null })
  },
  async restore() {
    if (!localStorage.getItem(TOKEN_KEY)) return set({ loading: false })
    try {
      const { data } = await api.get('/auth/me')
      cacheUser(data)
      set({ user: data, loading: false })
    } catch (e: any) {
      const status = e?.response?.status
      if (status === 401 || status === 403) {            // the server rejected the token: really signed out
        clearSession()
        set({ user: null, loading: false })
      } else {                                           // no network / server down: keep the session, use the cached profile
        const cached = readCachedUser()
        set({ user: cached, loading: false })
      }
    }
  },
}))

/** Home route for each role. */
export const homeFor = (r: Role) =>
  ({ tourist: '/tourist', officer: '/officer', police: '/dashboard', admin: '/dashboard' })[r]

// An expired or revoked token anywhere in the app signs the user out instead of leaving a broken page.
api.interceptors.response.use(
  (r) => r,
  (err) => {
    const url: string = err?.config?.url ?? ''
    if (err?.response?.status === 401 && !url.includes('/auth/login') && localStorage.getItem(TOKEN_KEY)) {
      clearSession()
      useAuth.setState({ user: null, loading: false })
    }
    return Promise.reject(err)
  },
)
