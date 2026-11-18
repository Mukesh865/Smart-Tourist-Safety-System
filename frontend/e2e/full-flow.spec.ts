import { expect, test, type Browser, type Page } from '@playwright/test'
import fs from 'node:fs'

const API = process.env.E2E_API ?? 'http://127.0.0.1:8100/api'
const TOURIST = { email: 'tess@example.com', name: 'Tess Traveller', password: 'password123' }
const KYC = 'AADHAAR-9999-8888'

async function apiLogin(request: any, email: string, password: string): Promise<string> {
  const r = await request.post(`${API}/auth/login`, { form: { username: email, password } })
  expect(r.ok()).toBeTruthy()
  return (await r.json()).access_token
}

async function uiLogin(page: Page, email: string, password: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

async function newPage(browser: Browser, opts: any = {}) {
  const ctx = await browser.newContext(opts)
  return { ctx, page: await ctx.newPage() }
}

test('issue ID -> verify -> tourist panic -> police live alert -> case -> e-FIR', async ({ browser, request }) => {
  // staff accounts are created by the admin (public registration only makes tourists)
  const admin = await apiLogin(request, 'admin@tourist.local', 'Admin@12345')
  for (const [email, role] of [['officer@example.com', 'officer'], ['police@example.com', 'police']]) {
    const r = await request.post(`${API}/auth/staff`, {
      headers: { Authorization: `Bearer ${admin}` },
      data: { email, full_name: role.toUpperCase(), password: 'password123', role },
    })
    expect(r.status()).toBe(201)
  }

  // 1. tourist registers in the UI and has no ID yet
  const t = await newPage(browser, { geolocation: { latitude: 25.5788, longitude: 91.8933, accuracy: 8 }, permissions: ['geolocation'] })
  await t.page.goto('/register')
  await t.page.getByLabel('Full name').fill(TOURIST.name)
  await t.page.getByLabel('Email').fill(TOURIST.email)
  await t.page.getByLabel('Password').fill(TOURIST.password)
  await t.page.getByRole('button', { name: 'Register' }).click()
  await expect(t.page.getByRole('heading', { name: 'My Safety' })).toBeVisible()
  await expect(t.page.getByRole('heading', { name: 'Get your digital ID' })).toBeVisible()      // new visitors can self-serve; here an officer issues instead

  // 2. officer issues the ID in the UI
  const o = await newPage(browser)
  await uiLogin(o.page, 'officer@example.com', 'password123')
  await expect(o.page.getByRole('heading', { name: 'Issue Digital Tourist ID' })).toBeVisible()
  await o.page.getByLabel('Tourist account email').fill(TOURIST.email)
  await o.page.getByRole('button', { name: 'Next' }).click()
  await o.page.getByLabel('Passport / Aadhaar number').fill(KYC)
  await o.page.getByRole('button', { name: 'Next' }).click()
  await o.page.getByLabel('Hotel name').fill('Hotel Polo')
  await o.page.getByRole('button', { name: 'Next' }).click()
  await o.page.getByLabel('Emergency contact name').fill('Mum')
  await o.page.getByLabel('Emergency contact phone').fill('+919876543210')
  await o.page.getByRole('button', { name: 'Next' }).click()
  await expect(o.page.getByText(`${TOURIST.name} (${TOURIST.email})`)).toBeVisible()      // review step names the visitor
  await expect(o.page.getByText(KYC)).toHaveCount(0)                                       // identity number is masked
  await o.page.getByRole('button', { name: 'Issue ID' }).click()
  const issued = await o.page.getByText(/^Issued TID-/).textContent()
  const idCode = issued!.replace('Issued ', '').trim()
  expect(idCode).toMatch(/^TID-[0-9A-F]{10}$/)

  // 3. the ID verifies on the public page; a tampered one does not
  const tok = await apiLogin(request, TOURIST.email, TOURIST.password)
  const cred = await (await request.get(`${API}/ledger/my-credential`, { headers: { Authorization: `Bearer ${tok}` } })).json()
  expect(cred.id_code).toBe(idCode)
  expect(cred.payload).not.toContain(KYC)
  const v = await newPage(browser)
  await v.page.goto('/verify')
  await v.page.getByPlaceholder(/paste the QR text/i).fill(cred.payload)
  await v.page.getByRole('button', { name: 'Verify', exact: true }).click()
  await expect(v.page.getByText('VALID ID')).toBeVisible()
  await v.page.getByPlaceholder(/paste the QR text/i).fill(cred.payload.replace('"t":', '"t":9'))
  await v.page.getByRole('button', { name: 'Verify', exact: true }).click()
  await expect(v.page.getByText('NOT VALID')).toBeVisible()

  // 4. police open the live dashboard
  const p = await newPage(browser)
  await uiLogin(p.page, 'police@example.com', 'password123')
  await expect(p.page.getByRole('heading', { name: 'Police Dashboard' })).toBeVisible()
  await expect(p.page.getByText('Live', { exact: true })).toBeVisible({ timeout: 15_000 })

  // 5. tourist (now with an ID) shares GPS and presses panic
  await t.page.reload()
  await t.page.getByRole('navigation', { name: 'Tabs' }).getByRole('link', { name: 'ID' }).click()
  await expect(t.page.getByText(idCode, { exact: true }).first()).toBeVisible()
  await t.page.getByRole('navigation', { name: 'Tabs' }).getByRole('link', { name: 'Home' }).click()
  const panicBtn = t.page.getByRole('button', { name: 'PANIC' })
  await expect(panicBtn).toBeEnabled()
  // a quick tap must NOT send anything (hold-to-send protects against pocket presses)
  await panicBtn.click()
  await t.page.waitForTimeout(300)
  await expect(t.page.getByText(/help request sent/i)).toHaveCount(0)
  // press and hold for the full duration
  const box = (await panicBtn.boundingBox())!
  await t.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await t.page.mouse.down()
  await t.page.waitForTimeout(1800)
  await t.page.mouse.up()
  await expect(t.page.getByText(/help request sent/i)).toBeVisible()

  // 6. the alert reaches the police dashboard live, panic first
  await expect(p.page.getByRole('alert').filter({ hasText: 'PANIC' })).toBeVisible({ timeout: 10_000 })      // a new panic is announced as an alert
  const card = p.page.getByTestId(/alert-/).first()
  await expect(card).toContainText(idCode)
  await card.getByRole('button', { name: 'Acknowledge' }).click()
  // the tourist's phone shows that the control room has seen the request (delivery status polling)
  await expect(t.page.getByText('The control room has seen your request.')).toBeVisible({ timeout: 15_000 })
  await expect(t.page.getByRole('button', { name: /It was a mistake/ })).toHaveCount(0)      // too late to cancel now

  // 7. open the alert: the case panel offers personal details (active incident only) and the e-FIR draft
  await card.getByRole('button', { name: /^Open alert/ }).click()
  await expect(p.page.getByRole('region', { name: 'Alert details' })).toBeVisible()
  await p.page.getByRole('button', { name: 'Open personal details' }).click()
  const panel = p.page.getByLabel('case details')
  await expect(panel).toContainText(KYC)
  await expect(panel).toContainText(TOURIST.name)
  const [download] = await Promise.all([
    p.page.waitForEvent('download'),
    p.page.getByRole('button', { name: 'Draft e-FIR (PDF)' }).click(),
  ])
  expect(download.suggestedFilename()).toMatch(/^draft-efir-\d+\.pdf$/)
  const file = await download.path()
  expect(fs.readFileSync(file!).subarray(0, 4).toString()).toBe('%PDF')

  // 8. workflow to resolution; the audit log (admin) records the sensitive actions
  await p.page.getByRole('button', { name: 'Dispatch' }).click()
  await p.page.getByRole('button', { name: 'Resolve' }).click()
  await expect(p.page.getByText('No alerts', { exact: true })).toBeVisible()
  const audit = await (await request.get(`${API}/audit`, { headers: { Authorization: `Bearer ${admin}` } })).json()
  expect(audit.map((a: any) => a.action)).toEqual(expect.arrayContaining(['ack', 'reveal_pii', 'efir', 'dispatch', 'resolve']))

  for (const x of [t, o, v, p]) await x.ctx.close()
})

test('role guards: a tourist cannot open staff pages; wrong password shows an error', async ({ page }) => {
  await uiLogin(page, 'nobody@example.com', 'wrongpassword')
  await expect(page.getByRole('alert')).toContainText('Incorrect email or password')
  await page.goto('/dashboard')
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
})

test('demo mode: scenario produces an alert on the dashboard', async ({ browser, request }) => {
  const admin = await apiLogin(request, 'admin@tourist.local', 'Admin@12345')
  const p = await newPage(browser)
  await uiLogin(p.page, 'admin@tourist.local', 'Admin@12345')
  await expect(p.page).toHaveURL(/\/dashboard/)      // admin lands on the dashboard; login finished
  await p.page.goto('/dashboard')
  await p.page.getByText('Demo mode (simulated tourists)').click()
  await p.page.getByRole('button', { name: 'Seed demo data' }).click()
  await expect(p.page.getByRole('status').filter({ hasText: 'Seeded' })).toBeVisible()
  await p.page.getByRole('button', { name: 'Signal drop-off' }).click()
  await expect(p.page.getByRole('status').filter({ hasText: 'Signal drop-off: dropoff' })).toBeVisible({ timeout: 30_000 })
  await expect(p.page.getByTestId(/alert-/).filter({ hasText: /dropoff/i }).first()).toBeVisible()
  await request.post(`${API}/demo/reset`, { headers: { Authorization: `Bearer ${admin}` } })
  await p.ctx.close()
})
