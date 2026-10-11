import { test, expect, settle, assertClean } from './fixtures'

// The controls, not just the first paint: period tabs, search, the theme switch, the sidebar,
// the trip scrubber, and the same pages on a phone-sized screen.

test('the statistics period tabs each load their period', async ({ page, problems }) => {
  await page.goto('/stats')
  await settle(page)
  for (const name of ['Week', 'Quarter', 'Year']) {
    await page.getByRole('tab', { name, exact: true }).click()
    await page.waitForTimeout(2500)
    const label = await page.locator('h1').first().innerText()
    expect(label, `${name} lost the heading`).toBeTruthy()
    const body = await page.locator('body').innerText()
    expect(body, `${name} shows nothing`).toMatch(/TRIPS|DISTANCE/i)
  }
  assertClean(problems, '/stats period tabs')
})

test('stepping back a period keeps the page working', async ({ page, problems }) => {
  await page.goto('/stats')
  await settle(page)
  const before = await page.locator('span.min-w-32').innerText()
  await page.getByLabel('Earlier').click()
  await page.waitForTimeout(2500)
  const after = await page.locator('span.min-w-32').innerText()
  expect(after, 'the period label did not change when stepping back').not.toBe(before)
  assertClean(problems, '/stats step back')
})

test('searching the trips list narrows it and clears again', async ({ page, problems }) => {
  await page.goto('/trips')
  await settle(page)
  const all = await page.locator('body').innerText()

  await page.getByLabel('Search trips').fill('zzz-no-such-note')
  await page.waitForTimeout(2500)
  const none = await page.locator('body').innerText()
  expect(none, 'a search that matches nothing says nothing about it').toMatch(/no trips|nothing|0 trips/i)

  await page.getByRole('button', { name: 'Clear' }).click()
  await page.waitForTimeout(2500)
  expect(await page.locator('body').innerText(), 'clearing the search did not restore the list').toContain(
    all.match(/(\d+) trips/)?.[0] ?? '3 trips',
  )
  assertClean(problems, '/trips search')
})

test('the theme switch holds across a reload', async ({ page }) => {
  await page.goto('/')
  await settle(page)
  const toggle = page.locator('button').filter({ hasText: /^(auto|light|dark)$/i }).first()
  await expect(toggle, 'no theme switch on the page').toBeVisible()
  const first = (await toggle.innerText()).trim().toLowerCase()
  await toggle.click()
  await page.waitForTimeout(500)
  const second = (await toggle.innerText()).trim().toLowerCase()
  expect(second, 'clicking the theme switch changed nothing').not.toBe(first)
  await page.reload()
  await settle(page)
  const after = (await page.locator('button').filter({ hasText: /^(auto|light|dark)$/i }).first().innerText()).trim().toLowerCase()
  expect(after, 'the theme choice was forgotten on reload').toBe(second)
})

test('the sidebar collapses and stays collapsed', async ({ page }) => {
  await page.goto('/')
  await settle(page)
  const nav = page.locator('nav').first()
  const wide = (await nav.boundingBox())!.width
  await nav.locator('button').first().click()
  await page.waitForTimeout(600)
  const narrow = (await nav.boundingBox())!.width
  expect(narrow, 'the sidebar did not collapse').toBeLessThan(wide)
  await page.reload()
  await settle(page)
  const afterReload = (await page.locator('nav').first().boundingBox())!.width
  expect(afterReload, 'the collapsed sidebar reopened on reload').toBeLessThan(wide)
})

test('a trip plays back from the scrubber', async ({ page, request, baseURL, problems }) => {
  const r = await request.get(`${baseURL}/api/trips`, { headers: { cookie: `cairn_session=${process.env.CAIRN_E2E_SESSION}` } })
  const stored = (await r.json()).trips as Array<{ boot_id: string; duration_s: number }>
  test.skip(stored.length === 0, 'no trips to play back')
  const trip = [...stored].sort((a, b) => b.duration_s - a.duration_s)[0]!

  await page.goto(`/trips/${trip.boot_id}`)
  await settle(page)
  const clock = page.locator('text=/\\d+:\\d\\d \\/ \\d+:\\d\\d/').first()
  await expect(clock, 'the trip has no playback clock').toBeVisible()
  const at0 = await clock.innerText()

  await page.getByRole('button', { name: '60×' }).click()
  await page.getByRole('button', { name: 'Play' }).click()
  await page.waitForTimeout(4000)
  expect(await clock.innerText(), 'playback did not advance').not.toBe(at0)
  assertClean(problems, 'trip playback')
})

test('the pages work on a phone-sized screen', async ({ page, problems }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  for (const path of ['/', '/trips', '/stats', '/places']) {
    await page.goto(path)
    await settle(page)
    await expect(page.locator('h1').first(), `${path}: no heading at phone width`).toBeVisible()
    // Nothing may spill sideways: a horizontal scrollbar on a phone is a broken layout.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow, `${path}: the layout is wider than a phone screen`).toBeLessThanOrEqual(2)
  }
  assertClean(problems, 'phone width')
})
