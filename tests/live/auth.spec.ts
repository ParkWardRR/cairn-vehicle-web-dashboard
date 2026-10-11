import { test as base, expect } from '@playwright/test'
import { settle } from './fixtures'

// What a stranger gets. These run without the session cookie on purpose: no fixture, no identity.

const test = base.extend({
  context: async ({ browser }, use) => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true })
    await use(context)
    await context.close()
  },
})

const PRIVATE = ['/', '/trips', '/stats', '/system', '/places', '/phones', '/security']

for (const path of PRIVATE) {
  test(`${path} is not served to a stranger`, async ({ page }) => {
    await page.goto(path)
    await settle(page)
    expect(page.url(), `${path} was served without a session`).toMatch(/\/login/)
    const body = await page.locator('body').innerText()
    // Nothing from the owner's drives may be on the page behind the sign-in prompt.
    expect(body, `${path} leaked data to the sign-in page`).not.toMatch(/\bkm\/h\b|\bRPM\b|boot_id/)
  })
}

test('the sign-in page offers a passkey', async ({ page }) => {
  await page.goto('/login')
  await settle(page)
  const body = await page.locator('body').innerText()
  expect(body).toMatch(/passkey|sign in/i)
  await expect(page.locator('button').filter({ hasText: /passkey|sign in/i }).first()).toBeVisible()
})

test('the API refuses a stranger', async ({ request, baseURL }) => {
  for (const path of ['/api/trips', '/api/dashboard/stats', '/api/auth/audit', '/api/phones']) {
    const r = await request.get(`${baseURL}${path}`)
    expect(r.status(), `${path} answered a request with no credential`).toBe(401)
  }
})

test('a forged session cookie is refused', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  await context.addCookies([{ name: 'cairn_session', value: 'a'.repeat(43), url: baseURL!, secure: true }])
  const page = await context.newPage()
  await page.goto('/trips')
  await settle(page)
  expect(page.url(), 'a made-up session cookie was accepted').toMatch(/\/login/)
  await context.close()
})
