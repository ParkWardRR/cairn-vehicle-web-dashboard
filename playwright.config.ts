import { defineConfig, devices } from '@playwright/test'

// Drives the deployed dashboard in a real browser. This is the only test layer that sees what
// the owner sees: the vitest suites test units and the API, walk-routes.sh tests status codes,
// and neither notices a page that renders a spinner for ever or a chart that throws.
//
//   CAIRN_UI_URL=https://cairn.alpina.casa \
//   CAIRN_E2E_SESSION=<cookie value> npx playwright test
//
// The session cookie is minted on the host (see tests/live/README.md) and never committed. The
// host serves a certificate from the private CA, so TLS errors are ignored by design.

const baseURL = process.env.CAIRN_UI_URL || 'https://cairn.alpina.casa'

export default defineConfig({
  testDir: './tests/live',
  // The live store is shared, so a failing page is a finding and not a flake to retry away.
  retries: 0,
  // Serially: the host is a single small machine and parallel map tiles swamp it.
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['json', { outputFile: 'tests/live/.report.json' }]],
  use: {
    baseURL,
    ignoreHTTPSErrors: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
