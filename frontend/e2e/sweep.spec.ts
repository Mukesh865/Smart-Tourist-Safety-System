import { expect, test, type APIRequestContext } from '@playwright/test'

const API = process.env.E2E_API ?? 'http://127.0.0.1:8100/api'
const login = async (r: APIRequestContext, email: string, pw: string) =>
  (await (await r.post(`${API}/auth/login`, { form: { username: email, password: pw } })).json()).access_token as string

test('sweep: family link, Hindi UI, unknown pages, session persistence, public pages, zone editing', async ({ browser, request }) => {
  const admin = await login(request, 'admin@tourist.local', 'Admin@12345')
  const A = { Authorization: `Bearer ${admin}` }
  await request.post(`${API}/auth/staff`, { headers: A, data: { email: 'sw-police@example.com', full_name: 'Sweep Police', password: 'password123', role: 'police' } })

  // a visitor outside Shillong: the hotel pin must start at their real position, not at a fixed demo location
  const ctx = await browser.newContext({ geolocation: { latitude: 12.9716, longitude: 77.5946, accuracy: 5 }, permissions: ['geolocation'] })
  const page = await ctx.newPage()
  await page.goto('/register')
  await page.getByLabel('Full name').fill('Fay Family')
  await page.getByLabel('Email').fill('fay@example.com')
  await page.getByLabel('Password').fill('password123')
  await page.getByRole('button', { name: 'Register' }).click()
  await expect(page.getByRole('heading', { name: 'Get your digital ID' })).toBeVisible()
  await expect(page.getByText(/12\.9716, 77\.5946/)).toBeVisible({ timeout: 15_000 })
  await page.getByLabel('Passport number').fill('SW-9988776')
  await page.getByLabel('Contact 1 name').fill('Mum')
  await page.getByLabel('Contact 1 phone').fill('+919876543210')
  await page.getByRole('checkbox', { name: /I confirm/ }).check()
  await page.getByRole('button', { name: 'Create my digital ID' }).click()
  await expect(page.getByRole('button', { name: 'PANIC' })).toBeVisible({ timeout: 15_000 })

  // family sharing: turn on, open the link as an anonymous person, turn off, the link stops working
  await page.getByRole('navigation', { name: 'Tabs' }).getByRole('link', { name: 'Settings' }).click()
  await page.getByRole('checkbox', { name: 'share with family' }).click()
  await expect(page.getByRole('checkbox', { name: 'share with family' })).toBeChecked()
  const linkText = await page.getByText(/\/family\//).textContent()
  const url = linkText!.match(/https?:\/\/\S+\/family\/\S+/)![0]
  const anon = await browser.newContext()
  const fam = await anon.newPage()
  await fam.goto(url.replace(/^https?:\/\/[^/]+/, ''))
  await expect(fam.getByRole('heading', { name: /Fay's live location/ })).toBeVisible()
  await page.getByRole('checkbox', { name: 'share with family' }).click()
  await expect(page.getByRole('checkbox', { name: 'share with family' })).not.toBeChecked()
  await fam.reload()
  await expect(fam.getByText(/not active/)).toBeVisible()
  await anon.close()

  // Hindi interface, saved on the account
  await page.getByRole('combobox', { name: 'Interface language' }).selectOption('hi')
  await expect(page.getByRole('link', { name: 'नक्शा' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('link', { name: 'नक्शा' })).toBeVisible()
  await page.getByRole('combobox', { name: 'Interface language' }).selectOption('en')

  // unknown URL goes home; session survives reload; after logout protected pages redirect; public page works signed out
  await page.goto('/this/does/not/exist')
  await expect(page).toHaveURL(/\/tourist/)
  await page.reload()
  await expect(page.getByRole('button', { name: 'PANIC' })).toBeVisible()
  await page.getByRole('button', { name: 'Log out' }).click()
  await page.goto('/tourist')
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await page.goto('/verify')
  await page.getByPlaceholder(/paste the QR text/i).fill('garbage')
  await page.getByRole('button', { name: 'Verify', exact: true }).click()
  await expect(page.getByText('NOT VALID')).toBeVisible()
  await ctx.close()

  // police: zone editing in the browser
  const pc = await browser.newContext()
  const p = await pc.newPage()
  await p.goto('/login')
  await p.getByLabel('Email').fill('sw-police@example.com')
  await p.getByLabel('Password').fill('password123')
  await p.getByRole('button', { name: 'Sign in' }).click()
  await expect(p).not.toHaveURL(/\/login/)
  await p.goto('/zones')
  const map = p.locator('.leaflet-container').first()
  for (const pos of [{ x: 200, y: 120 }, { x: 320, y: 120 }, { x: 260, y: 220 }]) await map.click({ position: pos })
  await p.getByLabel(/^Name/).fill('Sweep Zone')
  await p.getByRole('button', { name: 'High' }).click()
  await p.getByRole('button', { name: 'Save zone' }).click()
  await expect(p.getByText(/Sweep Zone/)).toBeVisible()
  await p.getByRole('button', { name: 'Edit Sweep Zone' }).click()
  await p.getByLabel(/^Name/).fill('Sweep Zone North')
  await p.getByRole('button', { name: 'Update zone' }).click()
  await expect(p.getByText(/Sweep Zone North/)).toBeVisible()
  await p.getByRole('button', { name: 'Duplicate Sweep Zone North' }).click()
  await p.getByRole('button', { name: 'Save zone' }).click()
  await expect(p.getByText('Sweep Zone North copy')).toBeVisible()
  await p.getByRole('button', { name: 'Delete Sweep Zone North copy' }).click()
  await p.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
  await expect(p.getByText('Sweep Zone North copy')).toHaveCount(0)
  await pc.close()
})
