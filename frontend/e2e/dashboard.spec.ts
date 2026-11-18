import { expect, test, type APIRequestContext } from '@playwright/test'
import fs from 'node:fs'

const API = process.env.E2E_API ?? 'http://127.0.0.1:8100/api'
const login = async (r: APIRequestContext, email: string, pw: string) =>
  (await (await r.post(`${API}/auth/login`, { form: { username: email, password: pw } })).json()).access_token as string

test('control-room workflow: filter, select, trail, assign, note, resolve as false alarm, bulk, export, analytics', async ({ browser, request }) => {
  const admin = await login(request, 'admin@tourist.local', 'Admin@12345')
  const A = { Authorization: `Bearer ${admin}` }
  await request.post(`${API}/auth/staff`, { headers: A, data: { email: 'cr-police@example.com', full_name: 'Casey Control', password: 'password123', role: 'police' } })
  await request.post(`${API}/auth/staff`, { headers: A, data: { email: 'cr-police2@example.com', full_name: 'Robin Relief', password: 'password123', role: 'police' } })
  await request.post(`${API}/demo/reset`, { headers: A })
  await request.post(`${API}/demo/seed`, { headers: A })
  for (const [email, scenario] of [['demo1@tourist.local', 'panic'], ['demo2@tourist.local', 'dropoff'], ['demo3@tourist.local', 'zone_entry'], ['demo1@tourist.local', 'inactivity']]) {
    expect((await request.post(`${API}/demo/scenario`, { headers: A, data: { scenario, email } })).ok()).toBeTruthy()
  }

  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto('/login')
  await page.getByLabel('Email').fill('cr-police@example.com')
  await page.getByLabel('Password').fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Police Dashboard' })).toBeVisible()
  const queue = page.getByRole('list', { name: 'Alerts' })
  await expect(queue.getByRole('listitem')).toHaveCount(4)

  // filters
  await page.getByLabel('Type').selectOption('dropoff')
  await expect(queue.getByRole('listitem')).toHaveCount(1)
  await page.getByLabel('Type').selectOption('')
  await expect(queue.getByRole('listitem')).toHaveCount(4)
  await page.getByLabel('Search ID code').fill('zzzz')
  await expect(page.getByText('No alerts', { exact: true })).toBeVisible()
  await page.getByLabel('Search ID code').fill('')

  // open the drop-off alert: trail, assign to me
  await page.getByLabel('Type').selectOption('dropoff')
  await queue.getByRole('button', { name: /^Open alert/ }).first().click()
  const panel = page.getByRole('region', { name: 'Alert details' })
  await expect(panel).toBeVisible()
  await expect(panel.getByLabel('Replay position')).toBeVisible()                 // the replayed track loaded (scenario fixes)
  await panel.getByRole('button', { name: 'Assign to me' }).click()
  await expect(queue.getByText('Casey Control')).toBeVisible()
  await panel.getByRole('button', { name: 'Acknowledge' }).click()

  // incident timeline + note
  await expect(panel.getByRole('list', { name: 'Incident timeline' })).toContainText('ack')
  await panel.getByLabel('Add a note').fill('Phoned the hotel; guest checked out at 14:00')
  await panel.getByRole('button', { name: 'Add note' }).click()
  await expect(panel.getByRole('list', { name: 'Incident timeline' })).toContainText('Phoned the hotel')
  await expect(panel.getByRole('list', { name: 'Incident timeline' })).toContainText('Casey Control')

  // resolve as a false alarm (feeds the analytics precision numbers)
  await panel.getByRole('button', { name: 'Dispatch' }).click()
  await panel.getByLabel('Outcome').selectOption('false_alarm')
  await panel.getByRole('button', { name: 'Resolve' }).click()
  await expect(panel).toHaveCount(0)                                              // resolved alerts leave the active queue, closing the panel
  await page.getByLabel('Status').selectOption('resolved')
  await expect(queue.getByText(/false alarm/)).toBeVisible()

  // bulk acknowledge the remaining open alerts
  await page.getByLabel('Type').selectOption('')
  await page.getByLabel('Status').selectOption('open')
  await expect(queue.getByRole('listitem')).toHaveCount(3)                       // panic, zone entry, inactivity are still open
  for (const box of await page.getByLabel(/^Select alert/).all()) await box.check()
  await page.getByRole('button', { name: /^Acknowledge \d+ open/ }).click()
  await expect(page.getByText(/\d+ acknowledged/).first()).toBeVisible()
  await expect(page.getByText('No alerts', { exact: true })).toBeVisible()

  // keyboard shortcuts: J selects the first, R resolves it
  await page.getByLabel('Status').selectOption('acknowledged')
  await expect(queue.getByRole('listitem').first()).toBeVisible()
  await page.keyboard.press('j')
  await expect(panel).toBeVisible()
  const before = await queue.getByRole('listitem').count()
  await page.keyboard.press('r')
  await expect(queue.getByRole('listitem')).toHaveCount(before - 1)

  // CSV export downloads a real file with a header and no formulas
  await page.getByLabel('Status').selectOption('all')
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export CSV' }).click()])
  expect(dl.suggestedFilename()).toBe('alerts.csv')
  const csv = fs.readFileSync((await dl.path())!, 'utf-8')
  expect(csv.split('\n')[0]).toContain('id,created_at,id_code,kind')
  expect(csv.split('\n').filter(Boolean).length).toBeGreaterThanOrEqual(5)

  // analytics shows the work just done
  await page.getByRole('link', { name: 'Analytics' }).first().click()
  await expect(page.getByRole('heading', { level: 1, name: 'Analytics' })).toBeVisible()
  await expect(page.getByText('Median time to acknowledge')).toBeVisible()
  await expect(page.getByText('Detector accuracy in the field')).toBeVisible()
  const det = page.getByText('Detector accuracy in the field').locator('xpath=ancestor::div[contains(@class,"card")]')
  await expect(det.getByRole('row', { name: /dropoff/ })).toContainText('100%')            // the one drop-off alert was judged a false alarm
  await page.getByRole('button', { name: 'View as table' }).first().click()
  await expect(page.getByRole('table').first()).toContainText('Panic alerts')
  await ctx.close()
  await request.post(`${API}/demo/reset`, { headers: A })
})
