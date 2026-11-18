import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

const API = process.env.E2E_API ?? 'http://127.0.0.1:8100/api'
const login = async (r: APIRequestContext, email: string, pw: string) =>
  (await (await r.post(`${API}/auth/login`, { form: { username: email, password: pw } })).json()).access_token as string

async function register(page: Page, name: string, email: string) {
  await page.goto('/register')
  await page.getByLabel('Full name').fill(name)
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill('password123')
  await page.getByRole('button', { name: 'Register' }).click()
  await expect(page.getByRole('heading', { name: 'Get your digital ID' })).toBeVisible()
}

async function applyOnline(page: Page, passport: string) {
  await page.getByLabel('Passport number').fill(passport)
  await page.locator('.leaflet-container').first().click({ position: { x: 150, y: 100 } })      // add a second planned stop on the map
  await expect(page.getByLabel('Stop 2 name')).toBeVisible()
  await page.getByLabel('Contact 1 name').fill('Mum')
  await page.getByLabel('Contact 1 phone').fill('+919876543210')
  await expect(page.getByRole('button', { name: 'Create my digital ID' })).toBeDisabled()        // declaration not yet ticked
  await page.getByRole('checkbox', { name: /I confirm these details are true/ }).check()
  await page.getByRole('button', { name: 'Create my digital ID' }).click()
}

test('a visitor gets a digital ID entirely on the website and everything works with it', async ({ browser, request }) => {
  const admin = await login(request, 'admin@tourist.local', 'Admin@12345')
  const A = { Authorization: `Bearer ${admin}` }
  for (const [email, role] of [['ss-officer@example.com', 'officer'], ['ss-police@example.com', 'police']]) {
    await request.post(`${API}/auth/staff`, { headers: A, data: { email, full_name: role, password: 'password123', role } })
  }
  const zone = { name: 'SS Landslide', risk_weight: 0.8, no_entry: false, polygon: [[25.5778, 91.8923], [25.5778, 91.8943], [25.5798, 91.8943], [25.5798, 91.8923]] }
  expect((await request.post(`${API}/zones`, { headers: A, data: zone })).ok()).toBeTruthy()

  const ctx = await browser.newContext({ geolocation: { latitude: 25.5788, longitude: 91.8933, accuracy: 6 }, permissions: ['geolocation'] })
  const page = await ctx.newPage()
  await register(page, 'Sam Selfserve', 'sam@example.com')
  await applyOnline(page, 'ZP-4455667')

  // the home screen switches to the safety dashboard with no reload
  await expect(page.getByRole('button', { name: 'PANIC' })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Next planned stop')).toBeVisible()
  await expect(page.getByText(/risk area|safe area/)).toBeVisible()

  // ID tab: QR card plus the self-declared notice
  await page.getByRole('navigation', { name: 'Tabs' }).getByRole('link', { name: 'ID' }).click()
  await expect(page.getByText(/Self-declared ID/)).toBeVisible()
  const idCode = (await page.getByText(/^TID-[0-9A-F]{10}$/).first().textContent())!.trim()

  // anyone can verify it: valid, but flagged as not yet checked by an officer
  const tok = await login(request, 'sam@example.com', 'password123')
  const cred = await (await request.get(`${API}/ledger/my-credential`, { headers: { Authorization: `Bearer ${tok}` } })).json()
  expect(cred.id_code).toBe(idCode)
  expect(cred.payload).not.toContain('ZP-4455667')
  const v = await ctx.newPage()
  await v.goto('/verify')
  await v.getByPlaceholder(/paste the QR text/i).fill(cred.payload)
  await v.getByRole('button', { name: 'Verify', exact: true }).click()
  await expect(v.getByText('VALID ID')).toBeVisible()
  await expect(v.getByText(/Self-declared: identity document not yet checked/)).toBeVisible()
  await v.close()

  // tracking works: the visitor stands inside the zone, so police receive a zone-entry alert
  const pol = await login(request, 'ss-police@example.com', 'password123')
  await expect.poll(async () => {
    const q = await (await request.get(`${API}/dashboard/alerts`, { headers: { Authorization: `Bearer ${pol}` } })).json()
    return q.some((a: any) => a.kind === 'zone_entry' && a.id_code === idCode)
  }, { timeout: 60_000, intervals: [2000] }).toBe(true)

  // a second account cannot reuse the same passport (even written differently)
  const other = await browser.newContext()
  const op = await other.newPage()
  await register(op, 'Dan Duplicate', 'dan@example.com')
  await op.getByLabel('Passport number').fill('zp 4455667')
  await op.getByLabel('Contact 1 name').fill('Dad')
  await op.getByLabel('Contact 1 phone').fill('+911111111111')
  await op.getByRole('checkbox', { name: /I confirm/ }).check()
  await op.getByRole('button', { name: 'Create my digital ID' }).click()
  await expect(op.getByRole('alert')).toContainText('identity document')
  await other.close()

  // an officer later checks the original document and marks it verified
  const off = await browser.newContext()
  const o = await off.newPage()
  await o.goto('/login')
  await o.getByLabel('Email').fill('ss-officer@example.com')
  await o.getByLabel('Password').fill('password123')
  await o.getByRole('button', { name: 'Sign in' }).click()
  await o.getByRole('link', { name: 'Tourists' }).click()
  await o.getByLabel('Search name, email or ID code').fill('Sam')
  await expect(o.getByText('Self-declared').first()).toBeVisible()
  await o.getByRole('button', { name: 'Mark Sam Selfserve verified' }).click()
  await expect(o.getByText('Marked as verified in person')).toBeVisible()
  await expect(o.getByText('Self-declared')).toHaveCount(0)
  await off.close()
  await page.reload()
  await page.getByRole('navigation', { name: 'Tabs' }).getByRole('link', { name: 'ID' }).click()
  await expect(page.getByText('Verified by an officer.')).toBeVisible()
  await ctx.close()
})
