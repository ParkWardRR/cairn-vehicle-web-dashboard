import { test, expect, settle, SESSION } from './fixtures'

// The same drives, read off different pages, must add up to the same story. These compare what
// one page says with what another says about the same facts.

const auth = { headers: { cookie: `cairn_session=${SESSION}` } }

test('a drive falls on the day the trip list says it does', async ({ page, request, baseURL }) => {
  const list = await (await request.get(`${baseURL}/api/trips`, auth)).json()
  const dated = (list.trips as Array<{ start_time: string | null }>)
    .filter(t => t.start_time && new Date(t.start_time).getFullYear() > 2000)
  test.skip(dated.length === 0, 'no trip with a usable timestamp')

  // The day the owner is shown on /trips, in their own time zone.
  await page.goto('/trips')
  await settle(page)
  const shown = (await page.locator('body').innerText())
    .match(/([A-Z][a-z]{2} \d{1,2}, \d{4})/g) ?? []
  expect(shown.length, '/trips shows no dates').toBeGreaterThan(0)

  // The day Statistics counts it under.
  const month = await (await request.get(`${baseURL}/api/stats/period?period=month&date=${new Date().toISOString().slice(0, 10)}`, auth)).json()
  const buckets = (month.series as Array<{ bucket: string; trips: number }>).filter(b => b.trips > 0)
  test.skip(buckets.length === 0, 'this month has no trips to compare')

  const asStats = buckets.map(b => new Date(`${b.bucket}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }))
  for (const day of asStats) {
    expect(shown, `Statistics counts a drive under ${day}, which is not a day the trip list shows`).toContain(day)
  }
})

test('the pages agree on how many trips there are', async ({ page, request, baseURL }) => {
  const total: number = (await (await request.get(`${baseURL}/api/trips`, auth)).json()).total

  await page.goto('/trips')
  await settle(page)
  expect(await page.locator('body').innerText(), 'the trip list disagrees with the store').toContain(`${total} trip`)

  await page.goto('/')
  await settle(page)
  const home = await page.locator('body').innerText()
  const homeTotal = Number(home.match(/TOTAL TRIPS\s+([\d,]+)/)?.[1]?.replace(/,/g, ''))
  expect(homeTotal, 'Home disagrees with the trip list about the number of trips').toBe(total)

  // Places counts visits, Phones counts what the vehicle server carried. Neither may claim more
  // drives than the owner can actually open.
  await page.goto('/places')
  await settle(page)
  const places = await page.locator('body').innerText()
  const inHistory = Number(places.match(/([\d,]+) trips in the visit history/)?.[1]?.replace(/,/g, ''))
  expect(inHistory, 'Places claims more trips than the trip list has').toBeLessThanOrEqual(total)
  const perPlace = [...places.matchAll(/· (\d+) trips? ·/g)].map(m => Number(m[1]))
  for (const n of perPlace) {
    expect(n, 'a single place claims more trips than exist').toBeLessThanOrEqual(total)
  }
})

test('a trip page and the trip list date a drive the same way', async ({ page, request, baseURL }) => {
  const list = await (await request.get(`${baseURL}/api/trips`, auth)).json()
  const trips = list.trips as Array<{ boot_id: string; start_time: string | null }>
  test.skip(trips.length === 0, 'no trips')

  await page.goto('/trips')
  await settle(page)
  const rows = (await page.locator('body').innerText()).split('\n')

  for (const trip of trips) {
    await page.goto(`/trips/${trip.boot_id}`)
    await settle(page)
    const subtitle = (await page.locator('h1').first().locator('xpath=following-sibling::p').innerText().catch(() => '')).trim()
    const usable = trip.start_time && new Date(trip.start_time).getFullYear() > 2000
    if (usable) continue
    // The list writes "--" for a timestamp it will not stand behind; the trip page must not then
    // print a date of its own for the same drive.
    expect(rows.some(r => r.split('\t')[0]?.trim() === '--'), 'the list hides this trip date').toBeTruthy()
    expect(subtitle, `the trip page dates a drive the list refuses to date: "${subtitle}"`).not.toMatch(/\d{4}|\d{1,2}:\d{2}/)
  }
})
