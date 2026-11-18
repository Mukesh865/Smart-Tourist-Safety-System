import { expect, test } from '@playwright/test'
import fs from 'node:fs'

const API = process.env.E2E_API ?? 'http://127.0.0.1:8100/api'

test('admin calibrates detection: invalid values blocked, preview compares, save applies, reset restores; zones export GeoJSON', async ({ browser, request }) => {
  const tok = (await (await request.post(`${API}/auth/login`, { form: { username: 'admin@tourist.local', password: 'Admin@12345' } })).json()).access_token
  const H = { Authorization: `Bearer ${tok}` }
  await request.post(`${API}/demo/seed`, { headers: H })       // creates demo zones for the export

  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto('/login')
  await page.getByLabel('Email').fill('admin@tourist.local')
  await page.getByLabel('Password').fill('Admin@12345')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.getByRole('link', { name: 'Calibration' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Detection calibration' })).toBeVisible()

  const r1 = page.getByLabel('No location for more than', { exact: true })
  await expect(r1).toHaveValue('20')
  await r1.fill('1')
  await expect(page.getByRole('alert').filter({ hasText: 'Between' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Save settings' })).toBeDisabled()

  await r1.fill('45')
  await page.getByRole('button', { name: /Preview effect/ }).click()
  await expect(page.getByLabel('Preview result')).toBeVisible({ timeout: 100_000 })
  await expect(page.getByLabel('Preview result')).toContainText('Paper defaults')

  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(page.getByText(/Settings saved/)).toBeVisible()
  const saved = await (await request.get(`${API}/admin/settings`, { headers: H })).json()
  expect(saved.values.r1_minutes).toBe(45)

  await page.getByRole('button', { name: 'Reset to paper defaults' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Reset' }).click()
  await expect(r1).toHaveValue('20')
  expect((await (await request.get(`${API}/admin/settings`, { headers: H })).json()).values.r1_minutes).toBe(20)

  await page.goto('/zones')
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export GeoJSON' }).click()])
  const fc = JSON.parse(fs.readFileSync((await dl.path())!, 'utf-8'))
  expect(fc.type).toBe('FeatureCollection')
  expect(fc.features.length).toBeGreaterThanOrEqual(2)
  expect(fc.features[0].geometry.coordinates[0][0][0]).toBeGreaterThan(90)       // longitude first
  await ctx.close()
  await request.post(`${API}/demo/reset`, { headers: H })
})
