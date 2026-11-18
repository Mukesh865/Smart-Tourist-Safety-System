import { expect, test, type APIRequestContext } from '@playwright/test'

const API = process.env.E2E_API ?? 'http://127.0.0.1:8100/api'
const login = async (r: APIRequestContext, email: string, pw: string) =>
  (await (await r.post(`${API}/auth/login`, { form: { username: email, password: pw } })).json()).access_token as string

test('offline: locations and a panic request are saved on the phone and delivered when the network returns', async ({ browser, request }) => {
  // staff + a tourist with an issued ID, all through the API
  const admin = await login(request, 'admin@tourist.local', 'Admin@12345')
  const A = { Authorization: `Bearer ${admin}` }
  for (const [email, role] of [['off-officer@example.com', 'officer'], ['off-police@example.com', 'police']]) {
    await request.post(`${API}/auth/staff`, { headers: A, data: { email, full_name: role, password: 'password123', role } })
  }
  await request.post(`${API}/auth/register`, { data: { email: 'off-tourist@example.com', full_name: 'Olga Offline', password: 'password123' } })
  const off = await login(request, 'off-officer@example.com', 'password123')
  const issued = await request.post(`${API}/ledger/issue`, {
    headers: { Authorization: `Bearer ${off}` },
    data: { tourist_email: 'off-tourist@example.com', kyc_number: 'PASS-0001', route: [[25.5788, 91.8933], [25.59, 91.9]],
      stops: [{ name: 'Hotel', lat: 25.5788, lon: 91.8933, hotel: true }], contacts: [{ name: 'Mum', phone: '+911111111111' }],
      valid_from: '2020-01-01T00:00:00Z', valid_to: '2099-01-01T00:00:00Z' },
  })
  expect(issued.ok()).toBeTruthy()

  const ctx = await browser.newContext({ geolocation: { latitude: 25.5788, longitude: 91.8933, accuracy: 8 }, permissions: ['geolocation'] })
  const page = await ctx.newPage()
  await page.clock.install()                                   // lets the test fast-forward the app's 60 s tracking timer
  await page.goto('/login')
  await page.getByLabel('Email').fill('off-tourist@example.com')
  await page.getByLabel('Password').fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'My Safety' })).toBeVisible()
  await expect(page.getByText(/safe area|risk area/)).toBeVisible()          // GPS fix received

  // the network drops
  await ctx.setOffline(true)
  await expect(page.getByText(/You are offline/)).toBeVisible()
  for (let i = 0; i < 3; i += 1) {
    await page.clock.runFor(61_000)                                          // one tracking cycle with no network
    await page.waitForTimeout(600)                                           // let the (real-time) queue write and failed send finish
  }
  await expect(page.getByText(/saved to send/)).toBeVisible()
  const waiting = Number(((await page.getByText(/saved to send/).textContent()) ?? '').match(/(\d+)/)?.[1])
  expect(waiting).toBeGreaterThanOrEqual(2)

  // an emergency while offline: kept safely, with an SMS fallback offered
  await page.getByRole('button', { name: /Can't hold/ }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Send now' }).click()
  await expect(page.getByText(/No connection. Your request is saved/)).toBeVisible()
  await expect(page.getByRole('link', { name: 'Send SMS' })).toHaveAttribute('href', /sms:112,\+911111111111/)

  // the network returns: the queued request and the backlog of locations are delivered
  await ctx.setOffline(false)
  await expect(page.getByText('Help request sent to the control room.')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText(/saved to send/)).toHaveCount(0, { timeout: 20_000 })

  // police now see the panic alert and the tourist's replayed position
  const pol = await login(request, 'off-police@example.com', 'password123')
  const P = { Authorization: `Bearer ${pol}` }
  const queue = await (await request.get(`${API}/dashboard/alerts`, { headers: P })).json()
  expect(queue.some((a: any) => a.kind === 'panic' && a.detail.includes('Olga Offline'))).toBeTruthy()
  const overview = await (await request.get(`${API}/dashboard/overview`, { headers: P })).json()
  expect(overview.positions.some((p: any) => p.open_alerts >= 1)).toBeTruthy()

  // the tourist cancels the accidental request is no longer possible once police acknowledge; here it is still open
  await page.getByRole('button', { name: /It was a mistake/ }).click()
  await expect(page.getByText('Request cancelled.')).toBeVisible()
  const after = await (await request.get(`${API}/dashboard/alerts`, { headers: P })).json()
  expect(after.some((a: any) => a.kind === 'panic')).toBeFalsy()             // cancelled alerts leave the queue
  await ctx.close()
})
