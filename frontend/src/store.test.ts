import { beforeEach, describe, expect, test, vi } from 'vitest'
import { api, TOKEN_KEY } from './api'
import { useAuth } from './store'

const user = { id: 1, email: 't@x.com', full_name: 'Tess', role: 'tourist' as const, language: 'en' }

beforeEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
  useAuth.setState({ user: null, loading: true })
})

describe('restore (app start / reload)', () => {
  test('no token: finishes loading signed out', async () => {
    await useAuth.getState().restore()
    expect(useAuth.getState()).toMatchObject({ user: null, loading: false })
  })

  test('valid token: loads the profile and caches it', async () => {
    localStorage.setItem(TOKEN_KEY, 'tok')
    vi.spyOn(api, 'get').mockResolvedValue({ data: user })
    await useAuth.getState().restore()
    expect(useAuth.getState().user).toEqual(user)
    expect(JSON.parse(localStorage.getItem('ts_user')!)).toEqual(user)
  })

  test('OFFLINE: a network error keeps the session and uses the cached profile (regression: used to sign out)', async () => {
    localStorage.setItem(TOKEN_KEY, 'tok')
    localStorage.setItem('ts_user', JSON.stringify(user))
    vi.spyOn(api, 'get').mockRejectedValue(Object.assign(new Error('Network Error'), { response: undefined }))
    await useAuth.getState().restore()
    expect(useAuth.getState()).toMatchObject({ user, loading: false })
    expect(localStorage.getItem(TOKEN_KEY)).toBe('tok')
  })

  test('server down (5xx) behaves like offline', async () => {
    localStorage.setItem(TOKEN_KEY, 'tok')
    localStorage.setItem('ts_user', JSON.stringify(user))
    vi.spyOn(api, 'get').mockRejectedValue({ response: { status: 503 } })
    await useAuth.getState().restore()
    expect(useAuth.getState().user).toEqual(user)
  })

  test('offline with no cached profile: signed out for now but the token is kept for later', async () => {
    localStorage.setItem(TOKEN_KEY, 'tok')
    vi.spyOn(api, 'get').mockRejectedValue(new Error('Network Error'))
    await useAuth.getState().restore()
    expect(useAuth.getState().user).toBeNull()
    expect(localStorage.getItem(TOKEN_KEY)).toBe('tok')
  })

  test.each([401, 403])('a %i from the server really signs out and wipes the cache', async (status) => {
    localStorage.setItem(TOKEN_KEY, 'tok')
    localStorage.setItem('ts_user', JSON.stringify(user))
    vi.spyOn(api, 'get').mockRejectedValue({ response: { status } })
    await useAuth.getState().restore()
    expect(useAuth.getState().user).toBeNull()
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
    expect(localStorage.getItem('ts_user')).toBeNull()
  })

  test('a corrupt cached profile is ignored', async () => {
    localStorage.setItem(TOKEN_KEY, 'tok')
    localStorage.setItem('ts_user', '{not json')
    vi.spyOn(api, 'get').mockRejectedValue(new Error('Network Error'))
    await useAuth.getState().restore()
    expect(useAuth.getState().user).toBeNull()
  })
})

describe('login / logout', () => {
  test('login stores the token and the profile; logout removes both and the API cache', async () => {
    vi.spyOn(api, 'post').mockResolvedValue({ data: { access_token: 'tok', user } })
    const del = vi.fn().mockResolvedValue(true)
    ;(globalThis as any).caches = { delete: del }
    await useAuth.getState().login('t@x.com', 'password123')
    expect(localStorage.getItem(TOKEN_KEY)).toBe('tok')
    expect(localStorage.getItem('ts_user')).not.toBeNull()
    useAuth.getState().logout()
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
    expect(localStorage.getItem('ts_user')).toBeNull()
    expect(del).toHaveBeenCalledWith('api-cache')
    expect(useAuth.getState().user).toBeNull()
    delete (globalThis as any).caches
  })

  test('logout works where the Cache API does not exist', () => {
    delete (globalThis as any).caches
    localStorage.setItem(TOKEN_KEY, 'tok')
    expect(() => useAuth.getState().logout()).not.toThrow()
  })
})
