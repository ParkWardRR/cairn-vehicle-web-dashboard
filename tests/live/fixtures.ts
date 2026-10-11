import { test as base, expect, type Page, type ConsoleMessage } from '@playwright/test'

// Every page is opened through this fixture, which carries the owner's session and records the
// three things a page can do wrong without anyone noticing: throw in the browser, get a failure
// back from its own API, or render an error to the owner.

export interface PageProblems {
  consoleErrors: string[]
  pageErrors: string[]
  badRequests: string[]
}

export const SESSION = process.env.CAIRN_E2E_SESSION || ''

// Noise that is not the dashboard's doing: tile servers rate-limiting us, and the favicon.
const IGNORED_REQUEST = /tile\.openstreetmap|basemaps|demotiles|favicon\.ico|\.pbf(\?|$)/
const IGNORED_CONSOLE = /Download the Vue Devtools|tile|Failed to load resource: the server responded with a status of 4\d\d \(\) *$/i

export function watch(page: Page): PageProblems {
  const problems: PageProblems = { consoleErrors: [], pageErrors: [], badRequests: [] }
  page.on('console', (m: ConsoleMessage) => {
    if (m.type() !== 'error') return
    const text = m.text()
    if (IGNORED_CONSOLE.test(text)) return
    problems.consoleErrors.push(text)
  })
  page.on('pageerror', e => problems.pageErrors.push(`${e.name}: ${e.message}`))
  page.on('response', r => {
    const url = r.url()
    if (r.status() < 400 || IGNORED_REQUEST.test(url)) return
    problems.badRequests.push(`${r.status()} ${r.request().method()} ${new URL(url).pathname}${new URL(url).search}`)
  })
  return problems
}

export const test = base.extend<{ problems: PageProblems }>({
  // Signed in as the owner for every test in the live suite.
  context: async ({ browser, baseURL }, use) => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true })
    await context.addCookies([{
      name: 'cairn_session',
      value: SESSION,
      url: baseURL!,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    }])
    await use(context)
    await context.close()
  },
  problems: async ({ page }, use) => {
    const problems = watch(page)
    await use(problems)
  },
})

// A page is only "up" once its data has arrived: Nuxt serves the shell instantly, so asserting
// on the shell would pass even when every fetch behind it failed.
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => {
    const t = document.body?.innerText || ''
    return t.length > 40 && !/^\s*(loading|Loading)\b/.test(t)
  }, undefined, { timeout: 30_000 }).catch(() => { /* asserted by the caller */ })
  await page.waitForTimeout(2500)
}

export function assertClean(problems: PageProblems, where: string): void {
  expect(problems.pageErrors, `${where}: uncaught exception in the browser`).toEqual([])
  expect(problems.badRequests, `${where}: its own API answered with a failure`).toEqual([])
  expect(problems.consoleErrors, `${where}: console errors`).toEqual([])
}

export { expect }
