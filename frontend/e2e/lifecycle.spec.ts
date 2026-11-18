import { expect, test, type Browser, type Page } from '@playwright/test'

const API = process.env.E2E_API ?? 'http://127.0.0.1:8100/api'

async function ui(page: Page, email: string, pw: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(pw)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).not.toHaveURL(/\/login/)
}
const api = async (request: any, email: string, pw: string) =>
  (await (await request.post(`${API}/auth/login`, { form: { username: email, password: pw } })).json()).access_token as string

async function verifyOnPage(browser: Browser, payload: string) {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto('/verify')
  await page.getByPlaceholder(/paste the QR text/i).fill(payload)
  await page.getByRole('button', { name: 'Verify', exact: true }).click()
  const card = page.locator('[role=status]', { hasText: /VALID/ })      // skip the loading spinner, which is also a status region
  const verdict = await card.textContent()
  await ctx.close()
  return verdict ?? ''
}

test('ID lifecycle in the browser: batch ID cards, revoke from the explorer, extend, itinerary', async ({ browser, request }) => {
  const admin = await api(request, 'admin@tourist.local', 'Admin@12345')
  const H = { Authorization: `Bearer ${admin}` }
  for (const [email, role] of [['lc-officer@example.com', 'officer'], ['lc-police@example.com', 'police']]) {
    await request.post(`${API}/auth/staff`, { headers: H, data: { email, full_name: role, password: 'password123', role } })
  }
  await request.post(`${API}/auth/register`, { data: { email: 'lc-tourist@example.com', full_name: 'Lena Lifecycle', password: 'password123' } })

  // officer issues through the wizard; check the ID card appears with a print button
  const off = await browser.newContext()
  const officer = await off.newPage()
  await ui(officer, 'lc-officer@example.com', 'password123')
  await officer.getByLabel('Tourist account email').fill('lc-tourist@example.com')
  await officer.getByRole('button', { name: 'Next' }).click()
  await officer.getByLabel('Passport / Aadhaar number').fill('PASSPORT-777')
  await officer.getByRole('button', { name: 'Next' }).click()
  // itinerary step: add a second stop by clicking the map, then use the stops as the route
  const map = officer.locator('.leaflet-container').first()
  await expect(map).toBeVisible()
  await map.click({ position: { x: 200, y: 120 } })
  await expect(officer.getByLabel('Stop 2 name')).toBeVisible()
  await officer.getByRole('button', { name: 'Use stops as route' }).click()
  await expect(officer.getByText('2 route point(s)')).toBeVisible()
  await officer.getByRole('button', { name: 'Next' }).click()
  await officer.getByLabel('Emergency contact name').fill('Dad')
  await officer.getByLabel('Emergency contact phone').fill('+911234567890')
  await officer.getByRole('button', { name: 'Next' }).click()
  await officer.getByRole('button', { name: 'Issue ID' }).click()
  const id1 = ((await officer.getByText(/^Issued TID-/).textContent()) ?? '').replace('Issued ', '').trim()
  await expect(officer.getByRole('button', { name: 'Print ID card' })).toBeVisible()
  const tok = await api(request, 'lc-tourist@example.com', 'password123')
  const cred1 = await (await request.get(`${API}/ledger/my-credential`, { headers: { Authorization: `Bearer ${tok}` } })).json()
  expect(cred1.id_code).toBe(id1)
  expect(await verifyOnPage(browser, cred1.payload)).toContain('VALID ID')

  // officer extends from the Tourists page -> new ID, old one is superseded
  await officer.goto('/tourists')
  await officer.getByLabel('Search name, email or ID code').fill('Lena')
  await officer.getByRole('button', { name: 'Extend ID for Lena Lifecycle' }).click()
  await officer.getByRole('dialog').getByRole('button', { name: 'Extend' }).click()
  await expect(officer.getByText(/Extended\. New ID TID-/)).toBeVisible()
  const cred2 = await (await request.get(`${API}/ledger/my-credential`, { headers: { Authorization: `Bearer ${tok}` } })).json()
  expect(cred2.id_code).not.toBe(id1)
  const oldVerdict = await verifyOnPage(browser, cred1.payload)
  expect(oldVerdict).toContain('NOT VALID')
  expect(oldVerdict).toContain('superseded by')
  expect(await verifyOnPage(browser, cred2.payload)).toContain('VALID ID')

  // the new ID card opens in a dialog after extending; close it, then edit the itinerary (rename the first stop)
  await officer.getByRole('dialog', { name: 'Digital tourist ID' }).getByRole('button', { name: 'Close' }).click()
  await officer.getByRole('button', { name: 'Itinerary for Lena Lifecycle' }).click()
  const dlg = officer.getByRole('dialog', { name: /Itinerary for/ })
  await dlg.getByLabel('Stop 1 name').fill('Mountain Lodge')
  await dlg.getByRole('button', { name: 'Save itinerary' }).click()
  await expect(officer.getByText('Itinerary saved')).toBeVisible()
  const tid = (await (await request.get(`${API}/tourists?q=Lena`, { headers: { Authorization: `Bearer ${await api(request, 'lc-officer@example.com', 'password123')}` } })).json()).items[0].tourist_id
  const det = await (await request.get(`${API}/tourists/${tid}`, { headers: { Authorization: `Bearer ${await api(request, 'lc-officer@example.com', 'password123')}` } })).json()
  expect(det.itinerary.stops[0].name).toBe('Mountain Lodge')

  // police revoke the current ID from the ledger explorer; verification fails and the tourist app says so
  const pol = await browser.newContext({ geolocation: { latitude: 25.5788, longitude: 91.8933 }, permissions: ['geolocation'] })
  const police = await pol.newPage()
  await ui(police, 'lc-police@example.com', 'password123')
  await police.goto('/ledger')
  await expect(police.getByText('Chain verified')).toBeVisible()
  await police.getByRole('button', { name: /^Open block/ }).first().click()
  await police.getByRole('button', { name: `Revoke ${cred2.id_code}` }).click()
  await police.getByRole('dialog', { name: /^Revoke TID/ }).getByLabel('Reason').fill('Reported lost')
  await police.getByRole('dialog', { name: /^Revoke TID/ }).getByRole('button', { name: 'Revoke ID' }).click()
  await expect(police.getByText('ID revoked')).toBeVisible()
  const revoked = await verifyOnPage(browser, cred2.payload)
  expect(revoked).toContain('NOT VALID')
  expect(revoked).toContain('Reported lost')
  await police.getByRole('dialog', { name: /^Block #/ }).getByRole('button', { name: 'Close' }).click()
  await police.getByRole('tab', { name: 'Revocation list' }).click()
  await expect(police.getByText('Reported lost')).toBeVisible()
  await expect(police.getByText('Chain verified')).toBeVisible()                  // revocation list still verifies

  const tourist = await browser.newContext()
  const tpage = await tourist.newPage()
  await ui(tpage, 'lc-tourist@example.com', 'password123')
  await expect(tpage.getByRole('alert').filter({ hasText: 'revoked' })).toContainText('Reported lost')
  await expect(tpage.getByRole('button', { name: 'PANIC' })).toBeEnabled()         // panic must keep working even when the ID is revoked

  for (const c of [off, pol, tourist]) await c.close()
})
