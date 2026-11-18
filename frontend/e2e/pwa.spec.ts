import { expect, test, type APIRequestContext } from '@playwright/test'

// These run against the PRODUCTION build (vite preview): the service worker only exists there.
const API = process.env.E2E_API ?? 'http://127.0.0.1:8100/api'
const login = async (r: APIRequestContext, email: string, pw: string) =>
  (await (await r.post(`${API}/auth/login`, { form: { username: email, password: pw } })).json()).access_token as string

test('manifest, icons and service worker are served', async ({ page, request, baseURL }) => {
  await page.goto('/login')
  const href = await page.locator('link[rel="manifest"]').getAttribute('href')
  expect(href).toBeTruthy()
  const manifest = await (await request.get(`${baseURL}${href}`)).json()
  expect(manifest).toMatchObject({ name: 'Smart Tourist Safety', display: 'standalone', start_url: '/tourist' })
  expect(manifest.icons.map((i: any) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']))
  expect(manifest.icons.some((i: any) => i.purpose === 'maskable')).toBeTruthy()
  for (const icon of manifest.icons) expect((await request.get(`${baseURL}${icon.src}`)).ok()).toBeTruthy()
  await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.ready).active?.state)).toBe('activated')
})

test('the app shell opens with no network at all', async ({ page, context }) => {
  await page.goto('/login')
  await page.evaluate(() => navigator.serviceWorker.ready)
  await page.reload()                                                  // now controlled by the service worker
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await context.setOffline(false)
})

test('a signed-in tourist can open the app and their ID offline; logout wipes the cached API data', async ({ browser, request }) => {
  const admin = await login(request, 'admin@tourist.local', 'Admin@12345')
  await request.post(`${API}/auth/staff`, { headers: { Authorization: `Bearer ${admin}` }, data: { email: 'pwa-officer@example.com', full_name: 'Officer', password: 'password123', role: 'officer' } })
  await request.post(`${API}/auth/register`, { data: { email: 'pwa-tourist@example.com', full_name: 'Pia Pwa', password: 'password123' } })
  const off = await login(request, 'pwa-officer@example.com', 'password123')
  const issued = await (await request.post(`${API}/ledger/issue`, { headers: { Authorization: `Bearer ${off}` }, data: {
    tourist_email: 'pwa-tourist@example.com', kyc_number: 'PASS-777', route: [], stops: [{ name: 'Hotel', lat: 25.5788, lon: 91.8933, hotel: true }],
    contacts: [{ name: 'Dad', phone: '+912222222222' }], valid_from: '2020-01-01T00:00:00Z', valid_to: '2099-01-01T00:00:00Z' } })).json()

  const ctx = await browser.newContext({ geolocation: { latitude: 25.5788, longitude: 91.8933 }, permissions: ['geolocation'] })
  const page = await ctx.newPage()
  await page.goto('/login')
  await page.evaluate(() => navigator.serviceWorker.ready)
  await page.getByLabel('Email').fill('pwa-tourist@example.com')
  await page.getByLabel('Password').fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'My Safety' })).toBeVisible()
  await page.getByRole('navigation', { name: 'Tabs' }).getByRole('link', { name: 'ID' }).click()
  await expect(page.getByText(issued.id_code, { exact: true }).first()).toBeVisible()      // credential fetched online and cached
  await page.reload()                                                     // make sure the worker controls the page
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)

  await ctx.setOffline(true)
  await page.reload()
  await expect(page.getByText(issued.id_code, { exact: true }).first()).toBeVisible()      // ID card still available with no network
  await ctx.setOffline(false)

  // signing out removes the cached API responses so the next person on this phone cannot see them
  expect(await page.evaluate(() => caches.has('api-cache'))).toBe(true)
  await page.getByRole('button', { name: 'Log out' }).click()
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  expect(await page.evaluate(() => caches.has('api-cache'))).toBe(false)
  await ctx.close()
})
