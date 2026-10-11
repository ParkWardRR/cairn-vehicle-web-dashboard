# The live UI suite

Playwright against the deployed dashboard in a real browser. This is the only layer that sees
what the owner sees: `npx vitest run` tests units and API handlers, `tests/walk-routes.sh` tests
status codes, and neither notices a page stuck on a spinner, a preference that will not stick, or
two pages that disagree about the same drive.

## Running it

The suite signs in as the owner, so it needs a session cookie. Passkey auth is never loosened for
it; instead a short-lived session is written straight into the host's auth store and removed
afterwards, with both ends recorded in the audit trail.

```sh
# on the host: mint a session that expires in two hours
scp tests/live/session.mjs alfa@cairn.alpina.casa:/tmp/
TOKEN=$(ssh alfa@cairn.alpina.casa 'sudo -u cairn node /tmp/session.mjs create 2>/dev/null')

CAIRN_UI_URL=https://cairn.alpina.casa CAIRN_E2E_SESSION="$TOKEN" npx playwright test

# afterwards, always
ssh alfa@cairn.alpina.casa 'sudo -u cairn node /tmp/session.mjs end; rm /tmp/session.mjs'
```

`npm run test:live` does the same once `CAIRN_E2E_SESSION` is in the environment.

It runs with one worker on purpose: the host is one small machine, and a page that fails here is
a finding rather than a flake to retry away. Browsers come from `npx playwright install chromium`.

## What each file is for

| File | What it holds to account |
| --- | --- |
| `pages.spec.ts` | every page in the sidebar renders, throws nothing, and formats every value |
| `auth.spec.ts` | what a stranger gets: a sign-in prompt, 401s, and no data |
| `trips.spec.ts` | the trip list, one real drive end to end, and a trip id the store does not have |
| `interact.spec.ts` | the controls: period tabs, search, theme, sidebar, playback, phone width |
| `agreement.spec.ts` | pages that describe the same drives must agree about them |

`fixtures.ts` carries the session and watches for the three things a page can do wrong quietly:
throw in the browser, get a failure from its own API, or render an error to the owner. Map tiles
and the favicon are the only ignored noise.

## Known failures

These fail against the live host today and are each an open issue. They are written as plain
assertions, not skips, so they turn green when the bug is fixed.

| Test | Issue |
| --- | --- |
| `a trip the store does not have is refused` | #21 unknown trip id spins for ever |
| `a trip page and the trip list date a drive the same way`, `a trip start date is a real date` | #22 one broken timestamp, three different renderings |
| `a drive falls on the day the trip list says it does` | #23 Statistics buckets by UTC day |
| `the pages agree on how many trips there are` | #24 four pages, four trip counts |
| `the theme switch holds across a reload`, `the sidebar collapses and stays collapsed` | #25 no preference is ever persisted |
| `Statistics (/stats) renders`, `Driving style (/behavior) renders`, and the three `/stats` interactions | #26 hydration mismatch |

Twelve failures, six bugs. Everything else passes.
