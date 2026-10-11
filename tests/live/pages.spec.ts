import { test, expect, settle, assertClean } from './fixtures'

// Opens every page the sidebar offers and holds each to the same bar: it renders its own
// heading, it does not throw, its API calls succeed, and nothing an owner would read as broken
// ("undefined", "NaN", "Invalid Date", a raw error) reaches the screen.

const PAGES = [
  { path: '/', name: 'Home' },
  { path: '/trips', name: 'Trips' },
  { path: '/stats', name: 'Statistics' },
  { path: '/analytics', name: 'Engine details' },
  { path: '/boost', name: 'Turbo' },
  { path: '/fuel', name: 'Fuel mix' },
  { path: '/economy', name: 'Fuel economy' },
  { path: '/behavior', name: 'Driving style' },
  { path: '/system', name: 'Your device' },
  { path: '/places', name: 'Places' },
  { path: '/phones', name: 'Phones' },
  { path: '/security', name: 'Security' },
  { path: '/calibration', name: 'Speedometer check' },
]

// Text that means the page gave up on a value rather than saying it has none.
const BROKEN_VALUE = /\bundefined\b|\bNaN\b|Invalid Date|\[object Object\]|\bnull\b(?! island)/

for (const { path, name } of PAGES) {
  test(`${name} (${path}) renders`, async ({ page, problems }) => {
    await page.goto(path)
    await settle(page)

    await expect(page.locator('h1').first(), `${path}: no heading rendered`).toBeVisible()
    assertClean(problems, path)

    const body = await page.locator('body').innerText()
    expect(body.length, `${path}: page is effectively blank`).toBeGreaterThan(120)
    const broken = body.split('\n').filter(l => BROKEN_VALUE.test(l))
    expect(broken, `${path}: a value failed to format`).toEqual([])
  })
}

test('the sidebar reaches every page it lists', async ({ page }) => {
  await page.goto('/')
  await settle(page)
  // The detailed views are hidden until asked for; the everyday ones must always be one click
  // away. There are two navs — the sidebar and the bottom bar a phone gets — so scope to the first.
  const sidebar = page.locator('nav').first()
  for (const path of ['/trips', '/stats', '/system', '/places', '/phones', '/security']) {
    await expect(sidebar.locator(`a[href="${path}"]`), `sidebar is missing ${path}`).toHaveCount(1)
  }
})

test('an unknown path says so rather than crashing', async ({ page, problems }) => {
  await page.goto('/no-such-page')
  await settle(page)
  expect(problems.pageErrors).toEqual([])
  const body = await page.locator('body').innerText()
  expect(body).toMatch(/not found|404/i)
})
