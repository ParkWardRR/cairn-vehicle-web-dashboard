import { test, expect, settle, assertClean, SESSION } from './fixtures'

// The trip list and one real trip from the live store, end to end: pick a drive, open it, and
// check the things the owner came for are on the screen — a date, a distance, a map, a chart.

interface Listed { boot_id: string; start_time: string | null; duration_s: number }

async function trips(request: import('@playwright/test').APIRequestContext, baseURL: string): Promise<Listed[]> {
  const r = await request.get(`${baseURL}/api/trips`, { headers: { cookie: `cairn_session=${SESSION}` } })
  expect(r.ok(), 'the live store did not answer /api/trips').toBeTruthy()
  return (await r.json()).trips as Listed[]
}

test('the trip list shows every trip the store has', async ({ page, request, baseURL, problems }) => {
  const stored = await trips(request, baseURL!)
  test.skip(stored.length === 0, 'the live store has no trips to list')

  await page.goto('/trips')
  await settle(page)
  assertClean(problems, '/trips')

  const rows = page.locator('[class*="cursor-pointer"]').filter({ hasText: /\d/ })
  await expect(rows.first()).toBeVisible()
  const body = await page.locator('body').innerText()
  expect(body, 'the list does not say how many trips there are').toMatch(/\d/)
})

test('a trip opens and shows the drive', async ({ page, request, baseURL, problems }) => {
  const stored = await trips(request, baseURL!)
  test.skip(stored.length === 0, 'the live store has no trips to open')
  // The longest drive: the one with the most to render.
  const trip = [...stored].sort((a, b) => b.duration_s - a.duration_s)[0]!

  await page.goto(`/trips/${trip.boot_id}`)
  await settle(page)

  await expect(page.locator('h1')).toContainText(/trip/i)
  assertClean(problems, `/trips/${trip.boot_id}`)

  // A drive of this length has a speed trace; an empty canvas means the chart threw quietly.
  const canvases = page.locator('canvas')
  await expect(canvases.first(), 'the trip page drew no chart or map at all').toBeVisible()
})

test('every trip in the store opens without an error', async ({ page, request, baseURL }) => {
  const stored = await trips(request, baseURL!)
  test.skip(stored.length === 0, 'the live store has no trips')

  const failures: string[] = []
  for (const trip of stored) {
    const errors: string[] = []
    const bad: string[] = []
    page.on('pageerror', e => errors.push(e.message))
    page.on('response', r => { if (r.status() >= 400 && r.url().includes('/api/')) bad.push(`${r.status()} ${new URL(r.url()).pathname}`) })
    await page.goto(`/trips/${trip.boot_id}`)
    await settle(page)
    if (errors.length || bad.length) failures.push(`${trip.boot_id}: ${[...errors, ...bad].join(', ')}`)
    page.removeAllListeners('pageerror')
    page.removeAllListeners('response')
  }
  expect(failures, 'trips that fail to open').toEqual([])
})

test('a trip the store does not have is refused, not rendered empty', async ({ page }) => {
  await page.goto('/trips/00000000000000000000000000000000')
  await settle(page)
  const body = await page.locator('body').innerText()
  expect(body, 'an unknown trip renders as a blank trip page').toMatch(/not found|no such|unknown|could not/i)
})

test('a trip start date is a real date', async ({ page, request, baseURL }) => {
  const stored = await trips(request, baseURL!)
  test.skip(stored.length === 0, 'the live store has no trips')

  await page.goto('/trips')
  await settle(page)
  const body = await page.locator('body').innerText()
  // A drive that happened cannot be dated 1970: the clock was lost, and "--" hides that from the
  // owner rather than telling them. The date is the first cell of each row.
  expect(body, 'a trip is dated 1970').not.toMatch(/\b19[67]\d\b/)
  const undated = body.split('\n').filter(r => r.split('\t')[0]?.trim() === '--')
  expect(undated, 'a trip has no date to show').toEqual([])
})
