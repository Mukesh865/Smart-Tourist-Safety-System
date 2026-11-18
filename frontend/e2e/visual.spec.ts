import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

const API = process.env.E2E_API ?? 'http://127.0.0.1:8100/api'
const SIZES = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } }
const THEMES = ['light', 'dark'] as const

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.addInitScript((t) => localStorage.setItem('ts_theme', t), theme)
}
async function login(page: Page, email: string, pw: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(pw)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).not.toHaveURL(/\/login/)   // wait for the redirect so the token is stored
}
async function contrast(page: Page, label: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).disableRules(['region']).analyze()
  const bad = r.violations.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes[0]?.html.slice(0, 90)} :: ${(v.nodes[0]?.any[0]?.message ?? '').slice(0, 160)}`)
  expect.soft(bad, `${label} accessibility`).toEqual([])
}
async function shot(page: Page, name: string) {
  await page.waitForTimeout(400)   // let map tiles/animations settle
  await page.screenshot({ path: `e2e/screenshots/${name}.png`, fullPage: false })
}

test('seed data via API', async ({ request }) => {
  const admin = (await (await request.post(`${API}/auth/login`, { form: { username: 'admin@tourist.local', password: 'Admin@12345' } })).json()).access_token
  const H = { Authorization: `Bearer ${admin}` }
  await request.post(`${API}/demo/seed`, { headers: H })
  for (const sc of ['zone_entry', 'dropoff', 'panic']) {
    const r = await request.post(`${API}/demo/scenario`, { headers: H, data: { scenario: sc, email: sc === 'dropoff' ? 'demo2@tourist.local' : sc === 'panic' ? 'demo3@tourist.local' : 'demo1@tourist.local' } })
    expect(r.ok()).toBeTruthy()
  }
})

for (const [sizeName, size] of Object.entries(SIZES)) {
  for (const theme of THEMES) {
    test(`login + register ${sizeName} ${theme}`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: size })
      const page = await ctx.newPage()
      await setTheme(page, theme)
      await page.goto('/login')
      await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
      await shot(page, `login-${sizeName}-${theme}`)
      await contrast(page, `login ${sizeName} ${theme}`)
      await page.goto('/register')
      await page.getByLabel('Password').fill('Abcdefgh1!')
      await shot(page, `register-${sizeName}-${theme}`)
      await contrast(page, `register ${sizeName} ${theme}`)
      await ctx.close()
    })

    test(`staff pages ${sizeName} ${theme}`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: size })
      const page = await ctx.newPage()
      await setTheme(page, theme)
      await login(page, 'admin@tourist.local', 'Admin@12345')
      for (const [path, heading] of [['/dashboard', 'Police Dashboard'], ['/zones', 'Risk Zones'], ['/officer', 'Issue Digital Tourist ID'], ['/evaluation', 'Evaluation vs paper Table V'], ['/admin', 'Administration'], ['/profile', 'Profile'], ['/tourists', 'Tourists'], ['/ledger', 'Ledger explorer'], ['/analytics', 'Analytics'], ['/calibration', 'Detection calibration']] as const) {
        await page.goto(path)
        await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
        await shot(page, `${path.slice(1)}-${sizeName}-${theme}`)
        await contrast(page, `${path} ${sizeName} ${theme}`)
      }
      await ctx.close()
    })

    test(`tourist page ${sizeName} ${theme}`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: size, geolocation: { latitude: 25.5788, longitude: 91.8933 }, permissions: ['geolocation'] })
      const page = await ctx.newPage()
      await setTheme(page, theme)
      await login(page, 'demo1@tourist.local', 'Demo@12345')
      await expect(page.getByRole('heading', { level: 1, name: 'My Safety' })).toBeVisible()
      await shot(page, `tourist-${sizeName}-${theme}`)
      await contrast(page, `tourist home ${sizeName} ${theme}`)
      for (const [tab, heading] of [['Map', 'Map'], ['Safety', 'Safety'], ['ID', 'My Digital ID'], ['Settings', 'Settings']] as const) {
        await page.getByRole('navigation', { name: 'Tabs' }).getByRole('link', { name: tab }).click()
        await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible()
        if (tab === 'ID') await expect(page.getByText(/^TID-[0-9A-F]{10}$/).first()).toBeVisible()
        await shot(page, `tourist-${tab.toLowerCase()}-${sizeName}-${theme}`)
        await contrast(page, `tourist ${tab} ${sizeName} ${theme}`)
      }
      await ctx.close()
    })
  }
}
