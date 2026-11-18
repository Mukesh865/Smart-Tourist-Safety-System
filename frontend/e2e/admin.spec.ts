import { expect, test, type Page } from '@playwright/test'

async function login(page: Page, email: string, pw: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(pw)
  await page.getByRole('button', { name: 'Sign in' }).click()
}

test('admin creates, disables and resets an account; the user is locked out live; password change ends other sessions', async ({ browser }) => {
  const adminCtx = await browser.newContext()
  const admin = await adminCtx.newPage()
  await login(admin, 'admin@tourist.local', 'Admin@12345')
  await expect(admin).toHaveURL(/\/dashboard/)
  await admin.getByRole('link', { name: 'Administration' }).click()
  await expect(admin.getByRole('heading', { level: 1, name: 'Administration' })).toBeVisible()

  // create an officer from the UI
  await admin.getByRole('button', { name: 'Add staff account' }).click()
  const dlg = admin.getByRole('dialog', { name: 'Add staff account' })
  await dlg.getByLabel('Full name').fill('Olive Officer')
  await dlg.getByLabel('Email').fill('olive@example.com')
  await dlg.getByLabel('Initial password').fill('Start#1234')
  await dlg.getByRole('button', { name: 'Create account' }).click()
  await expect(admin.getByText('Olive Officer')).toBeVisible()

  // the officer signs in and keeps working
  const offCtx = await browser.newContext()
  const officer = await offCtx.newPage()
  await login(officer, 'olive@example.com', 'Start#1234')
  await expect(officer.getByRole('heading', { level: 1, name: 'Issue Digital Tourist ID' })).toBeVisible()

  // admin disables the account (with confirmation) -> the officer's very next request is refused and they are signed out
  const row = admin.getByRole('row', { name: /Olive Officer/ })
  await row.getByRole('button', { name: 'Disable' }).click()
  await admin.getByRole('dialog').getByRole('button', { name: 'Disable' }).click()
  await expect(row.getByText('Disabled')).toBeVisible()
  await officer.reload()
  await expect(officer.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  await login(officer, 'olive@example.com', 'Start#1234')
  await expect(officer.getByRole('alert')).toContainText('disabled')

  // re-enable and reset the password: shown once, old password stops working
  await row.getByRole('button', { name: 'Enable' }).click()
  await admin.getByRole('dialog').getByRole('button', { name: 'Enable' }).click()
  await expect(row.getByText('Active')).toBeVisible()
  await row.getByRole('button', { name: 'Reset password' }).click()
  await admin.getByRole('dialog').getByRole('button', { name: 'Reset' }).click()
  const temp = (await admin.getByLabel('temporary password', { exact: true }).textContent())!.trim()
  expect(temp.length).toBeGreaterThanOrEqual(10)
  await admin.getByRole('button', { name: 'Done' }).click()
  await login(officer, 'olive@example.com', 'Start#1234')
  await expect(officer.getByRole('alert')).toContainText('Incorrect email or password')
  await login(officer, 'olive@example.com', temp)
  await expect(officer.getByRole('heading', { level: 1, name: 'Issue Digital Tourist ID' })).toBeVisible()

  // second session of the same officer; changing the password on one ends the other
  const second = await (await browser.newContext()).newPage()
  await login(second, 'olive@example.com', temp)
  await expect(second.getByRole('heading', { level: 1, name: 'Issue Digital Tourist ID' })).toBeVisible()
  await officer.getByRole('link', { name: 'Profile' }).click()
  await officer.getByLabel('Current password').fill(temp)
  await officer.getByLabel('New password', { exact: true }).fill('Brand#New99')
  await officer.getByLabel('Repeat new password').fill('Brand#New99')
  await officer.getByRole('button', { name: 'Update password' }).click()
  await expect(officer.getByText(/other devices were signed out/i)).toBeVisible()
  await officer.reload()                                           // this session continues with its fresh token
  await expect(officer.getByRole('heading', { level: 1, name: 'Profile' })).toBeVisible()
  await second.reload()                                            // the other session is gone
  await expect(second.getByRole('heading', { name: 'Sign in' })).toBeVisible()

  // audit log shows the admin's actions with their name
  await admin.getByRole('tab', { name: 'Audit log' }).click()
  await expect(admin.getByRole('cell', { name: 'admin_reset_password' })).toBeVisible()
  await expect(admin.getByRole('cell', { name: 'System Admin' }).first()).toBeVisible()

  // system tab: chain check and stats
  await admin.getByRole('tab', { name: 'System' }).click()
  await admin.getByRole('button', { name: 'Verify ledger chain' }).click()
  await expect(admin.getByText(/Chain intact|block\(s\) verified/)).toBeVisible()

  for (const c of [adminCtx, offCtx]) await c.close()
})

test('non-admin cannot reach the administration page', async ({ page }) => {
  await page.goto('/register')
  await page.getByLabel('Full name').fill('Plain Tourist')
  await page.getByLabel('Email').fill('plain@example.com')
  await page.getByLabel('Password').fill('password123')
  await page.getByRole('button', { name: 'Register' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'My Safety' })).toBeVisible()
  await page.goto('/admin')
  await expect(page.getByRole('heading', { level: 1, name: 'My Safety' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Administration' })).toHaveCount(0)
})
