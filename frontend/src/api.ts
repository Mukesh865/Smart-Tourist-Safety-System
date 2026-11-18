import axios from 'axios'

export const TOKEN_KEY = 'ts_token'

// Empty in local dev (Vite proxies /api). In production set VITE_API_URL=https://<your-service>.onrender.com
export const API_ORIGIN: string = ((import.meta.env.VITE_API_URL as string | undefined) ?? '').replace(/\/+$/, '')

export const api = axios.create({ baseURL: `${API_ORIGIN}/api` })

api.interceptors.request.use((cfg) => {
  const t = localStorage.getItem(TOKEN_KEY)
  if (t) cfg.headers.Authorization = `Bearer ${t}`
  return cfg
})
