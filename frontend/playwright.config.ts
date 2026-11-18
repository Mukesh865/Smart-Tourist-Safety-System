import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from '@playwright/test'

// Throw-away database and keys so E2E runs never touch development data.
const stamp = Date.now()
const db = path.join(os.tmpdir(), `tourist-e2e-${stamp}.db`).replace(/\\/g, '/')
const keys = path.join(os.tmpdir(), `tourist-e2e-keys-${stamp}`)
const here = path.dirname(fileURLToPath(import.meta.url))
const backend = path.resolve(here, '../backend')

// Separate ports so E2E never collides with a developer's running servers (8000 / 5173).
const API_PORT = 8100
const WEB_PORT = 5273
const PREVIEW_PORT = 5373   // production build, needed for the service worker / PWA tests
process.env.E2E_API = `http://127.0.0.1:${API_PORT}/api`   // inherited by the test workers

export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  workers: 1,
  reporter: 'list',
  projects: [
    { name: 'app', testIgnore: /pwa\.spec\.ts/, use: { baseURL: `http://127.0.0.1:${WEB_PORT}` } },
    { name: 'pwa', testMatch: /pwa\.spec\.ts/, use: { baseURL: `http://127.0.0.1:${PREVIEW_PORT}` } },
  ],
  use: { trace: 'retain-on-failure' },
  webServer: [
    {
      command: `"${backend}\\.venv\\Scripts\\python.exe" -m uvicorn app.main:app --port ${API_PORT}`,
      cwd: backend,
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        TS_DATABASE_URL: `sqlite:///${db}`,
        TS_KEYS_DIR: keys,
        TS_DETECTION_INTERVAL_S: '0',
        TS_RATE_LIMIT_ENABLED: 'false',
      },
    },
    {
      command: `npm run dev -- --host 127.0.0.1 --port ${WEB_PORT}`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      env: { VITE_API_TARGET: `http://127.0.0.1:${API_PORT}` },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `npm run build && npx vite preview --host 127.0.0.1 --port ${PREVIEW_PORT} --strictPort`,
      url: `http://127.0.0.1:${PREVIEW_PORT}`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: { VITE_API_TARGET: `http://127.0.0.1:${API_PORT}` },
    },
  ],
})
