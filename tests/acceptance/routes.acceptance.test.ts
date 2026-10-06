// @vitest-environment node
//
// Web acceptance: every route of the web layer, against a STAGED instance, in five
// scenarios. This is what "the web layer still works" means before anything is deployed:
// not "every route returns 200", but shapes, key values, and what happens when the input
// is bad, the store is empty, or the store is gone.
//
// It needs three running instances of the production build (tests/staging.sh starts them):
//
//   CAIRN_WEB_DATA    over the synthetic demo store          (representative data)
//   CAIRN_WEB_EMPTY   over the same schema with no rows      (empty store)
//   CAIRN_WEB_DOWN    pointed at a store that is not there   (missing capability)
//   CAIRN_WEB_PLACES  the data instance's places directory, to prove no route leaks it
//
// Run with `npm run test:acceptance`; it is not part of `npx vitest run`.
import { readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { VirtualAuthenticator } from './virtualAuthenticator'

const DATA = process.env.CAIRN_WEB_DATA ?? ''
const EMPTY = process.env.CAIRN_WEB_EMPTY ?? ''
const DOWN = process.env.CAIRN_WEB_DOWN ?? ''
const PLACES_DIR = process.env.CAIRN_WEB_PLACES ?? ''
// Every instance requires authentication. The read-only service token and the one-time
// enrolment code are given to the suite by tests/staging.sh; CAIRN_FAKE_TAILSCALE is the unix
// socket the suite serves a fake tailscaled LocalAPI on (the instances were told to use it).
const SERVICE_TOKEN = process.env.CAIRN_SERVICE_TOKEN ?? ''
const BOOTSTRAP_CODE = process.env.CAIRN_BOOTSTRAP_CODE ?? ''
const FAKE_TAILSCALE = process.env.CAIRN_FAKE_TAILSCALE ?? ''
const OWNER_LOGIN = 'owner@example.test'

const inventory = JSON.parse(readFileSync(join(__dirname, '..', 'routes.json'), 'utf8')) as { method: string; path: string }[]
const key = (m: string, p: string) => `${m} ${p}`

// every (method, route) any scenario exercised, so a route nobody tests fails the suite
const exercised = new Set<string>()

type Res = { status: number; body: any; text: string; headers: Headers }

type CallOpts = { params?: Record<string, string>; query?: Record<string, string>; json?: unknown; raw?: string; type?: string; headers?: Record<string, string>; auth?: 'none' | 'service' | 'session' }

// One HTTP call, exactly as given: no credentials are added.
async function send(base: string, method: string, route: string, opts: CallOpts = {}): Promise<Res> {
  exercised.add(key(method, route))
  let path = route
  for (const [k, v] of Object.entries(opts.params ?? {})) path = path.replace(`:${k}`, v)
  const url = new URL(base + path)
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v)
  const headers: Record<string, string> = { ...(opts.headers ?? {}) }
  let body: string | undefined
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(opts.json)
  } else if (opts.raw !== undefined) {
    headers['content-type'] = opts.type ?? 'text/plain'
    body = opts.raw
  }
  const res = await fetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(30_000) })
  const text = await res.text()
  let parsed: any = null
  try { parsed = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, body: parsed, text, headers: res.headers }
}

// Reads carry the read-only service token; anything that changes state carries a passkey
// session, enrolled and signed in through the real endpoints the first time it is needed.
async function call(base: string, method: string, route: string, opts: CallOpts = {}): Promise<Res> {
  const headers = { ...(opts.headers ?? {}) }
  const mode = opts.auth ?? (['GET', 'HEAD'].includes(method) ? 'service' : 'session')
  if (mode === 'service') headers.authorization = `Bearer ${SERVICE_TOKEN}`
  if (mode === 'session') headers.cookie = await sessionFor(base)
  return send(base, method, route, { ...opts, headers })
}

const authenticators = new Map<string, VirtualAuthenticator>()
const sessions = new Map<string, string>()
const cookieOf = (r: Res) => (r.headers.getSetCookie?.() ?? []).map(c => c.split(';')[0]).find(c => c.startsWith('cairn_session=')) ?? ''
const originOf = (base: string) => new URL(base).origin
const authn = (base: string) => new VirtualAuthenticator(originOf(base), new URL(base).hostname)

// Enrols a first passkey (with the one-time code unless `headers` carry another identity).
async function enrol(base: string, opts: { headers?: Record<string, string>; code?: boolean } = {}): Promise<{ cookie: string; a: VirtualAuthenticator }> {
  const a = authn(base)
  const o = await send(base, 'POST', '/api/auth/register-options', { json: opts.code === false ? {} : { bootstrapCode: BOOTSTRAP_CODE }, headers: opts.headers })
  expect(o.status, o.text).toBe(200)
  const v = await send(base, 'POST', '/api/auth/register-verify', { json: { challengeId: o.body.challengeId, response: a.register(o.body.options), name: 'Test key' }, headers: opts.headers })
  expect(v.status, v.text).toBe(200)
  expect(v.body.signed_in).toBe(true)
  authenticators.set(base, a)
  return { cookie: cookieOf(v), a }
}

async function login(base: string, a: VirtualAuthenticator): Promise<string> {
  const o = await send(base, 'POST', '/api/auth/login-options', { json: {} })
  expect(o.status, o.text).toBe(200)
  const v = await send(base, 'POST', '/api/auth/login-verify', { json: { challengeId: o.body.challengeId, response: a.assert(o.body.options) } })
  expect(v.status, v.text).toBe(200)
  return cookieOf(v)
}

async function sessionFor(base: string): Promise<string> {
  const have = sessions.get(base)
  if (have) return have
  const a = authenticators.get(base)
  const cookie = a ? await login(base, a) : (await enrol(base)).cookie
  sessions.set(base, cookie)
  return cookie
}

// A fake tailscaled LocalAPI, so the Tailnet path runs for real without a tailnet: it knows
// the owner's phone, a stranger's, and a tagged server that carries the owner's login.
let fakeTailscale: Server | null = null
const TAILNET = { owner: '100.64.0.7', stranger: '100.64.0.8', tagged: '100.64.0.9', nobody: '100.64.0.10' }
function startFakeTailscale(): Promise<void> {
  const nodes: Record<string, unknown> = {
    [TAILNET.owner]: { Node: { Tags: null }, UserProfile: { LoginName: OWNER_LOGIN } },
    [TAILNET.stranger]: { Node: { Tags: null }, UserProfile: { LoginName: 'stranger@example.test' } },
    [TAILNET.tagged]: { Node: { Tags: ['tag:server'] }, UserProfile: { LoginName: OWNER_LOGIN } },
  }
  fakeTailscale = createServer((req, res) => {
    const ip = new URL(req.url ?? '', 'http://x').searchParams.get('addr') ?? ''
    const hit = nodes[ip]
    res.statusCode = hit ? 200 : 404
    res.end(hit ? JSON.stringify(hit) : 'no match for IP:port')
  })
  rmSync(FAKE_TAILSCALE, { force: true })
  return new Promise(resolve => fakeTailscale!.listen(FAKE_TAILSCALE, resolve))
}
const asTailnet = (ip: string, extra: Record<string, string> = {}) => ({ 'x-forwarded-for': ip, ...extra })

const hex32 = /^[0-9a-f]{32}$/
const iso = (s: unknown) => typeof s === 'string' && !Number.isNaN(Date.parse(s))
const between = (n: unknown, lo: number, hi: number) => typeof n === 'number' && n >= lo && n <= hi
const GET = (base: string, route: string, o?: CallOpts) => call(base, 'GET', route, o)

const UNKNOWN_BOOT = '0'.repeat(32)
const BOOT_SCOPED = ['/api/trips/:bootId', '/api/trips/:bootId/events', '/api/trips/:bootId/fuel', '/api/trips/:bootId/insights', '/api/trips/:bootId/route', '/api/trips/:bootId/stops', '/api/trips/:bootId/telemetry', '/api/trips/:bootId/timeline']
const BOOT_QUERY = ['/api/analytics/telemetry', '/api/analytics/imu', '/api/analytics/drive-summary', '/api/analytics/boost-detail', '/api/analytics/fuel-health']

beforeAll(async () => {
  for (const [name, v] of Object.entries({ CAIRN_WEB_DATA: DATA, CAIRN_WEB_EMPTY: EMPTY, CAIRN_WEB_DOWN: DOWN, CAIRN_SERVICE_TOKEN: SERVICE_TOKEN, CAIRN_BOOTSTRAP_CODE: BOOTSTRAP_CODE, CAIRN_FAKE_TAILSCALE: FAKE_TAILSCALE })) {
    if (!v) throw new Error(`${name} is not set: run tests/staging.sh, which starts the staged instances`)
  }
  await startFakeTailscale()
})
afterAll(() => { fakeTailscale?.close() })

// ─── access control ──────────────────────────────────────────────────────────
//
// Nothing answers without an identity: a passkey session, an allowlisted Tailnet device (here a
// fake tailscaled), or the read-only service token. These run first, so the "no passkey is
// enrolled yet" cases see a fresh instance.

describe('access control: no identity, no answer', () => {
  const placeholders = { bootId: UNKNOWN_BOOT, id: '1' }

  it('every route outside /api/auth refuses an anonymous caller with 401 and no data', async () => {
    for (const r of inventory.filter(x => !x.path.startsWith('/api/auth/'))) {
      const res = await call(DATA, r.method, r.path, { params: placeholders, query: { boot_id: UNKNOWN_BOOT }, auth: 'none', ...(r.method === 'GET' ? {} : { json: {} }) })
      expect(res.status, `${r.method} ${r.path}`).toBe(401)
      expect(res.body, `${r.method} ${r.path}`).toMatchObject({ error: true, statusMessage: 'authentication required' })
      expect(Object.keys(res.body).sort(), `${r.method} ${r.path}`).toEqual(['error', 'message', 'statusCode', 'statusMessage', 'url'])
    }
  })

  it('pages redirect to the sign-in page, which is itself reachable', async () => {
    for (const page of ['/', '/trips', '/places', '/system']) {
      const r = await send(DATA, 'GET', page)
      expect(r.status, page).toBe(302)
      expect(r.headers.get('location'), page).toBe(`/login?next=${encodeURIComponent(page)}`)
      expect(r.text, page).not.toContain('__NUXT_DATA__')
    }
    expect((await send(DATA, 'GET', '/login')).status).toBe(200)
  })

  it('refuses a wrong token, another scheme and a made-up session', async () => {
    expect((await GET(DATA, '/api/trips', { auth: 'none', headers: { authorization: 'Bearer nope' } })).status).toBe(401)
    expect((await GET(DATA, '/api/trips', { auth: 'none', headers: { authorization: `Basic ${SERVICE_TOKEN}` } })).status).toBe(401)
    expect((await GET(DATA, '/api/trips', { auth: 'none', headers: { cookie: 'cairn_session=made-up' } })).status).toBe(401)
    // a wrong token is not rescued by a valid-looking Tailnet address
    expect((await GET(DATA, '/api/trips', { auth: 'none', headers: { authorization: 'Bearer nope', ...asTailnet(TAILNET.owner) } })).status).toBe(401)
  })

  it('the service token reads, and cannot write or manage credentials', async () => {
    expect((await GET(DATA, '/api/trips')).status).toBe(200)
    const w = await call(DATA, 'POST', '/api/places/saved', { auth: 'service', json: { name: 'Nope', lat: 1, lon: 1 } })
    expect(w.status).toBe(403)
    expect(w.body.statusMessage).toBe('this credential is read-only')
    expect((await GET(DATA, '/api/auth/passkeys')).status).toBe(403)
    expect((await GET(DATA, '/api/auth/audit')).status).toBe(403)
  })

  it('tells an anonymous caller how to sign in, and nothing else', async () => {
    const r = await GET(DATA, '/api/auth/session', { auth: 'none' })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ authenticated: false, method: null, actor: null, fresh: false, passkeys: 0, can_enrol: true, auth: 'required' })
    expect(r.text).not.toContain(OWNER_LOGIN)
  })

  it('cannot start a first passkey without the code on the host or an allowed Tailnet device', async () => {
    const attempts: Record<string, string>[] = [{}, asTailnet(TAILNET.stranger), asTailnet(TAILNET.tagged), asTailnet(TAILNET.nobody)]
    for (const headers of attempts) {
      const r = await send(DATA, 'POST', '/api/auth/register-options', { json: {}, headers })
      expect(r.status, JSON.stringify(headers)).toBe(401)
    }
    const wrong = await send(DATA, 'POST', '/api/auth/register-options', { json: { bootstrapCode: 'not-the-code' } })
    expect(wrong.status).toBe(401)
    expect((await GET(DATA, '/api/auth/session', { auth: 'none' })).body.passkeys).toBe(0)
  })

  it('cannot sign in with a passkey that was never enrolled', async () => {
    expect((await send(DATA, 'POST', '/api/auth/login-options', { json: {} })).status).toBe(409)
  })
})

describe('access control: a Tailnet device enrols the first passkey', () => {
  it('the owner\'s device can; the session it gets works', async () => {
    const { cookie } = await enrol(DOWN, { headers: asTailnet(TAILNET.owner), code: false })
    expect(cookie).toMatch(/^cairn_session=/)
    sessions.set(DOWN, cookie)
    const me = await send(DOWN, 'GET', '/api/auth/session', { headers: { cookie } })
    expect(me.body).toMatchObject({ authenticated: true, method: 'passkey', fresh: true, passkeys: 1, can_enrol: false })
  })
})

describe('access control: passkeys', () => {
  let first: { cookie: string; a: VirtualAuthenticator }

  it('a first passkey with the code on the host signs the owner in, and the code is then spent', async () => {
    first = await enrol(EMPTY)
    const me = await send(EMPTY, 'GET', '/api/auth/session', { headers: { cookie: first.cookie } })
    expect(me.body).toMatchObject({ authenticated: true, method: 'passkey', actor: 'owner', fresh: true, passkeys: 1 })
    const again = await send(EMPTY, 'POST', '/api/auth/register-options', { json: { bootstrapCode: BOOTSTRAP_CODE } })
    expect(again.status).toBe(401)
  })

  it('the session cookie is HttpOnly and SameSite=Strict', async () => {
    const o = await send(EMPTY, 'POST', '/api/auth/login-options', { json: {} })
    const v = await send(EMPTY, 'POST', '/api/auth/login-verify', { json: { challengeId: o.body.challengeId, response: first.a.assert(o.body.options) } })
    const set = v.headers.getSetCookie().find(c => c.startsWith('cairn_session='))!
    expect(set).toMatch(/HttpOnly/i)
    expect(set).toMatch(/SameSite=Strict/i)
    expect(set).toMatch(/Path=\//)
    expect(set).toMatch(/Max-Age=\d{6,}/)
  })

  it('refuses a bad assertion: tampered signature, wrong origin, no user verification, replayed or unknown challenge', async () => {
    const bad = async (over: Parameters<VirtualAuthenticator['assert']>[1]) => {
      const o = await send(EMPTY, 'POST', '/api/auth/login-options', { json: {} })
      return send(EMPTY, 'POST', '/api/auth/login-verify', { json: { challengeId: o.body.challengeId, response: first.a.assert(o.body.options, over) } })
    }
    expect((await bad({ tamper: true })).status).toBe(401)
    expect((await bad({ origin: 'https://evil.example' })).status).toBe(401)
    expect((await bad({ flags: 0x01 })).status).toBe(401)

    const o = await send(EMPTY, 'POST', '/api/auth/login-options', { json: {} })
    const response = first.a.assert(o.body.options)
    const ok = await send(EMPTY, 'POST', '/api/auth/login-verify', { json: { challengeId: o.body.challengeId, response } })
    expect(ok.status).toBe(200)
    // the same answer again: the challenge was spent
    expect((await send(EMPTY, 'POST', '/api/auth/login-verify', { json: { challengeId: o.body.challengeId, response } })).status).toBe(400)
    expect((await send(EMPTY, 'POST', '/api/auth/login-verify', { json: { challengeId: 'made-up', response } })).status).toBe(400)
    // a credential the server never saw
    const o2 = await send(EMPTY, 'POST', '/api/auth/login-options', { json: {} })
    const stranger = authn(EMPTY)
    expect((await send(EMPTY, 'POST', '/api/auth/login-verify', { json: { challengeId: o2.body.challengeId, response: stranger.assert(o2.body.options) } })).status).toBe(401)
  })

  it('a second passkey needs a fresh passkey session; a stolen or ambient identity cannot add one', async () => {
    expect((await send(EMPTY, 'POST', '/api/auth/register-options', { json: {} })).status).toBe(401)
    const withService = await send(EMPTY, 'POST', '/api/auth/register-options', { json: {}, headers: { authorization: `Bearer ${SERVICE_TOKEN}` } })
    expect(withService.status).toBe(401)

    const cookie = await login(EMPTY, first.a)
    const second = authn(EMPTY)
    const o = await send(EMPTY, 'POST', '/api/auth/register-options', { json: {}, headers: { cookie } })
    expect(o.status, o.text).toBe(200)
    // the first passkey is excluded from the new registration
    expect(o.body.options.excludeCredentials.map((c: any) => c.id)).toContain(first.a.id)
    const v = await send(EMPTY, 'POST', '/api/auth/register-verify', { json: { challengeId: o.body.challengeId, response: second.register(o.body.options), name: 'Second key' }, headers: { cookie } })
    expect(v.status, v.text).toBe(200)
    expect(v.body.signed_in).toBe(false)
    const list = await send(EMPTY, 'GET', '/api/auth/passkeys', { headers: { cookie } })
    expect(list.body.passkeys.map((p: any) => p.name).sort()).toEqual(['Second key', 'Test key'])
    expect(JSON.stringify(list.body)).not.toMatch(/public_key|publicKey/)

    // removing the first passkey ends the sessions it started, and the other still signs in
    const gone = await send(EMPTY, 'DELETE', '/api/auth/passkeys/:id', { params: { id: first.a.id }, headers: { cookie } })
    expect(gone.status, gone.text).toBe(200)
    expect((await send(EMPTY, 'GET', '/api/auth/session', { headers: { cookie } })).body.authenticated).toBe(false)
    expect((await send(EMPTY, 'DELETE', '/api/auth/passkeys/:id', { params: { id: 'no-such-passkey' }, headers: { cookie: await login(EMPTY, second) } })).status).toBe(404)
    authenticators.set(EMPTY, second)
    sessions.delete(EMPTY)
  })

  it('signing out ends the session', async () => {
    const cookie = await login(EMPTY, authenticators.get(EMPTY)!)
    expect((await GET(EMPTY, '/api/auth/passkeys', { auth: 'none', headers: { cookie } })).status).toBe(200)
    expect((await send(EMPTY, 'POST', '/api/auth/logout', { json: {}, headers: { cookie } })).status).toBe(200)
    expect((await GET(EMPTY, '/api/auth/passkeys', { auth: 'none', headers: { cookie } })).status).toBe(401)
  })

  it('records who did what, by field name, and never a secret', async () => {
    const r = await send(EMPTY, 'GET', '/api/auth/audit', { headers: { cookie: await sessionFor(EMPTY) } })
    expect(r.status).toBe(200)
    const actions = r.body.audit.map((a: any) => a.action)
    expect(actions).toEqual(expect.arrayContaining(['passkey-added', 'login', 'login-failed', 'passkey-removed', 'logout']))
    for (const a of r.body.audit) expect(Object.keys(a).sort()).toEqual(['action', 'actor', 'id', 'method', 'target', 'ts'])
    for (const secret of [BOOTSTRAP_CODE, SERVICE_TOKEN, 'cairn_session=']) expect(r.text).not.toContain(secret)
  })
})

describe('access control: Tailnet identity', () => {
  it('lets an allowlisted device in, and no one else', async () => {
    expect((await GET(DATA, '/api/trips', { auth: 'none', headers: asTailnet(TAILNET.owner) })).status).toBe(200)
    for (const [who, ip] of Object.entries({ stranger: TAILNET.stranger, tagged: TAILNET.tagged, nobody: TAILNET.nobody })) {
      expect((await GET(DATA, '/api/trips', { auth: 'none', headers: asTailnet(ip) })).status, who).toBe(401)
    }
    // an allowlisted address that is not the real peer: a client claiming it from a non-proxy is
    // not tested here (this suite is the proxy); the unit tests cover clientIp
    expect((await GET(DATA, '/api/trips', { auth: 'none', headers: asTailnet(`${TAILNET.stranger}, ${TAILNET.owner}`) })).status).toBe(200)
    expect((await GET(DATA, '/api/trips', { auth: 'none', headers: asTailnet(`${TAILNET.owner}, ${TAILNET.stranger}`) })).status).toBe(401)
  })

  it('renders pages, whose data is fetched by the server for the signed-in caller', async () => {
    for (const headers of [asTailnet(TAILNET.owner), { authorization: `Bearer ${SERVICE_TOKEN}` }]) {
      const r = await send(DATA, 'GET', '/trips', { headers })
      expect(r.status).toBe(200)
      expect(r.text).toMatch(/<html/i)
      // the page's own data calls were answered, not refused: no 401 inside the payload
      expect(r.text).not.toContain('authentication required')
      expect(r.text).toContain('__NUXT_DATA__')
    }
  })

  it('can change saved places, but cannot manage credentials: that needs a fresh passkey', async () => {
    // got past authentication: an unknown id is a 404, and nothing was written
    const patch = await send(DATA, 'PATCH', '/api/places/saved/:id', { params: { id: '999999' }, json: { name: 'x' }, headers: asTailnet(TAILNET.owner) })
    expect(patch.status).toBe(404)
    await sessionFor(DATA)   // a passkey now exists
    const add = await send(DATA, 'POST', '/api/auth/register-options', { json: {}, headers: asTailnet(TAILNET.owner) })
    expect(add.status).toBe(401)
    expect(add.body.statusMessage).toBe('reauth_required')
    const del = await send(DATA, 'DELETE', '/api/auth/passkeys/:id', { params: { id: authenticators.get(DATA)!.id }, headers: asTailnet(TAILNET.owner) })
    expect(del.status).toBe(401)
    expect(del.body.statusMessage).toBe('reauth_required')
    expect((await send(DATA, 'GET', '/api/auth/passkeys', { headers: asTailnet(TAILNET.owner) })).status).toBe(200)
  })
})

describe('access control: cross-site requests', () => {
  const base = () => new URL(DATA).host
  it('refuses a cross-site write, whoever the browser is signed in as', async () => {
    const cookie = await sessionFor(DATA)
    const writes: Record<string, string>[] = [
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
      { origin: 'https://evil.example' },
      { origin: 'null' },
    ]
    for (const extra of writes) {
      for (const who of [{ cookie }, asTailnet(TAILNET.owner)]) {
        const r = await send(DATA, 'PATCH', '/api/places/saved/:id', { params: { id: '999999' }, json: { name: 'x' }, headers: { ...who, ...extra } })
        expect(r.status, JSON.stringify([who, extra])).toBe(403)
        expect(r.body.statusMessage).toBe('cross-site request refused')
      }
    }
  })
  it('allows the same origin, and reads from anywhere', async () => {
    const cookie = await sessionFor(DATA)
    const same = await send(DATA, 'PATCH', '/api/places/saved/:id', { params: { id: '999999' }, json: { name: 'x' }, headers: { cookie, origin: DATA, 'sec-fetch-site': 'same-origin', host: base() } })
    expect(same.status).toBe(404)
    expect((await GET(DATA, '/api/trips', { auth: 'none', headers: { cookie, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } })).status).toBe(200)
  })
  it('refuses a cross-site sign-in attempt too', async () => {
    const r = await send(DATA, 'POST', '/api/auth/login-options', { json: {}, headers: { origin: 'https://evil.example' } })
    expect(r.status).toBe(403)
  })
})

// ─── representative data ─────────────────────────────────────────────────────

describe('representative data (synthetic demo store)', () => {
  let trips: any[] = []
  let trip: any

  beforeAll(async () => {
    const r = await GET(DATA, '/api/trips', { query: { limit: '200' } })
    trips = r.body.trips
    // the longest trip has the most to assert on
    trip = [...trips].sort((a, b) => b.duration_s - a.duration_s)[0]
  })

  it('lists trips with the fields the dashboard reads', async () => {
    const r = await GET(DATA, '/api/trips', { query: { limit: '200' } })
    expect(r.status).toBe(200)
    expect(r.body.total).toBe(trips.length)
    expect(trips.length).toBeGreaterThanOrEqual(10)
    for (const t of trips) {
      expect(t.vehicle_id).toMatch(hex32)
      expect(t.boot_id).toMatch(hex32)
      expect(t.duration_s).toBeGreaterThan(0)
      expect(between(t.max_speed_kph, 0, 300)).toBe(true)
      expect(between(t.max_rpm, 0, 9000)).toBe(true)
      expect(t.obd_samples).toBeGreaterThan(0)
      expect(iso(t.start_time)).toBe(true)
      expect(between(t.start_lat, -90, 90)).toBe(true)
      expect(between(t.start_lon, -180, 180)).toBe(true)
    }
    expect(new Set(trips.map(t => t.boot_id)).size).toBe(trips.length)
  })

  it('pages and sorts the trip list', async () => {
    const first = await GET(DATA, '/api/trips') // default page
    expect(first.body.trips).toHaveLength(Math.min(20, trips.length))
    expect(first.body.total).toBe(trips.length) // total is the whole store, not the page

    const page = await GET(DATA, '/api/trips', { query: { limit: '5', offset: '5' } })
    expect(page.body.trips.map((t: any) => t.boot_id)).toEqual(trips.slice(5, 10).map(t => t.boot_id))

    // newest first by default
    const starts = trips.map(t => Date.parse(t.start_time))
    expect(starts).toEqual([...starts].sort((a, b) => b - a))

    const longest = await GET(DATA, '/api/trips', { query: { sort: '-duration_s', limit: '200' } })
    const d = longest.body.trips.map((t: any) => t.duration_s)
    expect(d).toEqual([...d].sort((a, b) => b - a))

    // nonsense falls back to the defaults; it neither errors nor injects
    const junk = await GET(DATA, '/api/trips', { query: { limit: 'abc', offset: '-4', sort: 'duration_s; drop table obd' } })
    expect(junk.status).toBe(200)
    expect(junk.body.trips.length).toBeGreaterThan(0)
  })

  it('serves one trip, consistent with the list', async () => {
    const r = await GET(DATA, '/api/trips/:bootId', { params: { bootId: trip.boot_id } })
    expect(r.status).toBe(200)
    expect(r.body.boot_id).toBe(trip.boot_id)
    expect(r.body.duration_s).toBe(trip.duration_s)
    expect(r.body.vehicle_id).toBe(trip.vehicle_id)
    // the single-trip view adds the start and end, each with a place
    expect(iso(r.body.start.observed_at)).toBe(true)
    expect(iso(r.body.end.observed_at)).toBe(true)
    expect(typeof r.body.start.place.kind).toBe('string')
  })

  it('serves a trip\'s events, fuel, insights, route, stops, telemetry and timeline', async () => {
    const p = { bootId: trip.boot_id }
    const events = await GET(DATA, '/api/trips/:bootId/events', { params: p })
    expect(events.status).toBe(200)
    expect(Array.isArray(events.body.imuEvents)).toBe(true)
    expect(events.body.transitions.length).toBeGreaterThan(0)
    for (const t of events.body.transitions) expect(t.boot_id).toBe(trip.boot_id)

    const fuel = await GET(DATA, '/api/trips/:bootId/fuel', { params: p })
    expect(fuel.body.samples.length).toBeGreaterThan(10)
    expect(fuel.body.distance_m).toBeGreaterThan(100)
    expect(Math.abs(fuel.body.duration_s - trip.duration_s)).toBeLessThanOrEqual(5)
    for (const s of fuel.body.samples.slice(0, 50)) expect(between(s.speed_kph, 0, 300)).toBe(true)

    const insights = await GET(DATA, '/api/trips/:bootId/insights', { params: p })
    expect(insights.body.insights.length).toBeGreaterThanOrEqual(3)
    for (const i of insights.body.insights) {
      expect(i.label).toBeTruthy()
      expect(i.value).toBeTruthy()
      expect(typeof i.icon).toBe('string')
    }

    const route = await GET(DATA, '/api/trips/:bootId/route', { params: p })
    expect(route.body.type).toBe('FeatureCollection')
    const line = route.body.features[0].geometry
    expect(line.type).toBe('LineString')
    expect(line.coordinates.length).toBeGreaterThan(10)
    for (const [lon, lat] of line.coordinates) {
      expect(between(lat, -90, 90)).toBe(true)
      expect(between(lon, -180, 180)).toBe(true)
    }

    const stops = await GET(DATA, '/api/trips/:bootId/stops', { params: p })
    expect(Array.isArray(stops.body.stops)).toBe(true)
    expect(typeof stops.body.pending).toBe('boolean')
    expect(Array.isArray(stops.body.attribution)).toBe(true)

    const tel = await GET(DATA, '/api/trips/:bootId/telemetry', { params: p })
    expect(tel.body.telemetry.length).toBeGreaterThan(50)
    let prev = -1
    for (const row of tel.body.telemetry) {
      expect(row.mono_ms).toBeGreaterThanOrEqual(prev)
      prev = row.mono_ms
      expect(between(row.speed_kph, 0, 300)).toBe(true)
      expect(between(row.rpm, 0, 9000)).toBe(true)
    }

    const tl = await GET(DATA, '/api/trips/:bootId/timeline', { params: p })
    for (const series of ['obd', 'boost', 'gps']) expect(tl.body[series].length).toBeGreaterThan(0)
  })

  it('dashboard totals agree with the trip list', async () => {
    const stats = await GET(DATA, '/api/dashboard/stats')
    expect(stats.status).toBe(200)
    expect(stats.body.allTime.total_trips).toBe(trips.length)
    expect(stats.body.allTime.max_speed_kph).toBe(Math.max(...trips.map(t => t.max_speed_kph)))
    const sum = trips.reduce((a, t) => a + t.duration_s, 0)
    expect(Math.abs(stats.body.allTime.total_duration_s - sum) / sum).toBeLessThan(0.01)
    expect(stats.body.allTime.total_distance_m).toBeGreaterThan(0)
    expect(stats.body.week.trips).toBeLessThanOrEqual(stats.body.month.trips)
    expect(stats.body.month.trips).toBeLessThanOrEqual(stats.body.allTime.total_trips)

    const recent = await GET(DATA, '/api/dashboard/recent')
    expect(recent.body.trips.length).toBeGreaterThan(0)
    const known = new Set(trips.map(t => t.boot_id))
    for (const t of recent.body.trips) expect(known.has(t.boot_id)).toBe(true)

    const hl = await GET(DATA, '/api/dashboard/highlights')
    expect(hl.body.vehicle_id).toMatch(hex32)
    expect(between(hl.body.engine.peak_boost_psi, 0, 40)).toBe(true)
    expect(between(hl.body.engine.peak_rpm, 3000, 9000)).toBe(true)

    const dev = await GET(DATA, '/api/dashboard/device')
    expect(dev.status).toBe(200)
    // the dongle's own cell (~4 V) or the car's (~12-14 V), in millivolts
    expect(between(dev.body.battery_mv, 3000, 16000)).toBe(true)
    expect(iso(dev.body.observed_at)).toBe(true)
  })

  it('device pages agree with each other and with the store', async () => {
    const bundles = (await GET(DATA, '/api/device/bundles')).body.bundles
    const repro = (await GET(DATA, '/api/device/reproducibility')).body.reproducibility
    const status = (await GET(DATA, '/api/device/tsdb-status')).body
    const health = (await GET(DATA, '/api/device/health')).body.health
    expect(bundles.length).toBeGreaterThan(0)
    expect(status.ok).toBe(true)
    expect(status.bundle_rows).toBe(bundles.length)
    expect(status.trips).toBe(trips.length)
    expect(status.position_rows).toBeGreaterThan(0)
    expect(repro.length).toBe(bundles.length)
    for (const b of repro) expect(b.reproduced).toBe(true)
    expect(new Set(bundles.map((b: any) => b.content_root)).size).toBe(bundles.length)
    expect(health.length).toBeGreaterThan(0)
  })

  it('serves the vehicle list with ids only when no local API is configured', async () => {
    const r = await GET(DATA, '/api/vehicles')
    expect(r.status).toBe(200)
    expect(r.body.vehicles).toHaveLength(1)
    const v = r.body.vehicles[0]
    expect(v.id).toBe(trips[0].vehicle_id)
    expect(v.name).toBe(`Vehicle ${v.id.slice(0, 8)}`) // degrades to the id, never fails
    expect(v.bundles).toBeGreaterThan(0)
  })

  it('serves the heatmap and the places', async () => {
    const hm = await GET(DATA, '/api/heatmap')
    expect(hm.body.points.length).toBeGreaterThan(100)
    for (const [lat, lon, w] of hm.body.points.slice(0, 200)) {
      expect(between(lat, -90, 90)).toBe(true)
      expect(between(lon, -180, 180)).toBe(true)
      expect(typeof w).toBe('number')
    }
    const pl = await GET(DATA, '/api/places')
    expect(pl.status).toBe(200)
    expect(pl.body.places.length).toBeGreaterThan(0)
    for (const p of pl.body.places) {
      expect(between(p.lat, -90, 90)).toBe(true)
      expect(p.arrivals + p.departures).toBeGreaterThan(0)
    }
    expect(Array.isArray(pl.body.saved)).toBe(true)
    expect(typeof pl.body.storage).toBe('object')
  })

  it('serves the analytics', async () => {
    const boost = await GET(DATA, '/api/analytics/boost-curve')
    expect(boost.body.boostCurve.length).toBeGreaterThan(100)
    for (const p of boost.body.boostCurve.slice(0, 200)) expect(between(p.boost_psi, -15, 40)).toBe(true)

    const fe = await GET(DATA, '/api/analytics/fuel-economy')
    expect(fe.body.samples.length).toBeGreaterThan(100)
    expect(fe.body.perTrip.length).toBe(trips.length)
    expect(fe.body.timingByLoad.length).toBeGreaterThan(0)

    const pulls = await GET(DATA, '/api/analytics/pulls')
    expect(pulls.body.pulls.length).toBeGreaterThan(0)
    for (const p of pulls.body.pulls) expect(p.max_rpm).toBeGreaterThanOrEqual(p.min_rpm)

    const trim = await GET(DATA, '/api/analytics/trim-map')
    expect(trim.body.trimMap.length).toBeGreaterThan(0)
    for (const b of trim.body.trimMap) expect(typeof b.rpm_bin).toBe('number')

    const sa = await GET(DATA, '/api/analytics/speed-agreement')
    expect(sa.body.speedAgreement.length).toBeGreaterThan(100)
  })

  it('serves the boot-scoped analytics, matching the trip routes', async () => {
    const tel = await GET(DATA, '/api/analytics/telemetry', { query: { boot_id: trip.boot_id } })
    const tripTel = await GET(DATA, '/api/trips/:bootId/telemetry', { params: { bootId: trip.boot_id } })
    expect(tel.status).toBe(200)
    expect(tel.body.telemetry.length).toBe(tripTel.body.telemetry.length)

    const imu = await GET(DATA, '/api/analytics/imu', { query: { boot_id: trip.boot_id } })
    expect(imu.body.samples.length).toBeGreaterThan(0)
    for (const s of imu.body.samples) expect(s.boot_id).toBe(trip.boot_id)

    for (const route of ['/api/analytics/drive-summary', '/api/analytics/boost-detail', '/api/analytics/fuel-health']) {
      const r = await GET(DATA, route, { query: { boot_id: trip.boot_id } })
      expect(r.status, route).toBe(200)
    }
  })

  it('passes the store\'s answer through when it has no snapshot endpoint', async () => {
    // the demo store has no /snapshot; the web layer must pass that on, not turn it into a 500
    const r = await GET(DATA, '/api/snapshot')
    expect(r.status).toBe(404)
  })
})

// ─── empty store ─────────────────────────────────────────────────────────────

describe('empty store: the same routes return empty, not errors', () => {
  it('lists are empty and totals are zero', async () => {
    expect((await GET(EMPTY, '/api/trips')).body).toEqual({ trips: [], total: 0 })
    expect((await GET(EMPTY, '/api/dashboard/recent')).body).toEqual({ trips: [] })
    expect((await GET(EMPTY, '/api/vehicles')).body).toEqual({ vehicles: [] })
    expect((await GET(EMPTY, '/api/device/bundles')).body).toEqual({ bundles: [] })
    expect((await GET(EMPTY, '/api/device/health')).body).toEqual({ health: [] })
    expect((await GET(EMPTY, '/api/device/reproducibility')).body).toEqual({ reproducibility: [] })
    expect((await GET(EMPTY, '/api/heatmap')).body).toEqual({ points: [] })

    const stats = (await GET(EMPTY, '/api/dashboard/stats')).body
    expect(stats.allTime.total_trips).toBe(0)
    expect(stats.allTime.total_duration_s).toBe(0)

    const hl = (await GET(EMPTY, '/api/dashboard/highlights')).body
    expect(hl.engine.peak_rpm).toBeNull()

    const st = (await GET(EMPTY, '/api/device/tsdb-status')).body
    expect(st.ok).toBe(true)
    expect(st.trips).toBe(0)
    expect(st.position_rows).toBe(0)

    const pl = (await GET(EMPTY, '/api/places')).body
    expect(pl.places).toEqual([])
    expect(pl.trips).toEqual([])

    expect((await GET(EMPTY, '/api/analytics/boost-curve')).body.boostCurve).toEqual([])
    expect((await GET(EMPTY, '/api/analytics/fuel-economy')).body.samples).toEqual([])
    expect((await GET(EMPTY, '/api/analytics/pulls')).body.pulls).toEqual([])
    expect((await GET(EMPTY, '/api/analytics/trim-map')).body.trimMap).toEqual([])
    expect((await GET(EMPTY, '/api/analytics/speed-agreement')).body.speedAgreement).toEqual([])
  })

  it('has no device status to show, and says so with a 404', async () => {
    expect((await GET(EMPTY, '/api/dashboard/device')).status).toBe(404)
  })

  it('answers every trip route for a trip that does not exist, with empty or 404, never an error', async () => {
    for (const route of BOOT_SCOPED) {
      const r = await GET(EMPTY, route, { params: { bootId: UNKNOWN_BOOT } })
      expect([200, 404], route).toContain(r.status)
    }
    for (const route of BOOT_QUERY) {
      const r = await GET(EMPTY, route, { query: { boot_id: UNKNOWN_BOOT } })
      expect(r.status, route).toBe(200)
    }
  })

  it('has no snapshot to give', async () => {
    expect((await GET(EMPTY, '/api/snapshot')).status).toBe(404)
  })
})

// ─── bad input ───────────────────────────────────────────────────────────────

describe('bad input', () => {
  it('an unknown trip is a 404, and its sub-resources are empty or 404', async () => {
    expect((await GET(DATA, '/api/trips/:bootId', { params: { bootId: UNKNOWN_BOOT } })).status).toBe(404)
    expect((await GET(DATA, '/api/trips/:bootId', { params: { bootId: 'not-a-boot-id' } })).status).toBe(404)
    for (const route of BOOT_SCOPED.slice(1)) {
      const r = await GET(DATA, route, { params: { bootId: UNKNOWN_BOOT } })
      expect([200, 404], route).toContain(r.status)
      if (r.status === 200) {
        // empty, not invented
        const lists = Object.values(r.body).filter(Array.isArray) as unknown[][]
        for (const l of lists) expect(l.length, route).toBe(0)
      }
    }
  })

  it('a query that needs a boot id says so', async () => {
    for (const route of ['/api/analytics/telemetry']) {
      expect((await GET(DATA, route)).status, route).toBe(400)
    }
  })

  it('mutations require application/json', async () => {
    const text = { raw: '{"name":"X","lat":1,"lon":1}', type: 'text/plain' }
    expect((await call(DATA, 'POST', '/api/places/saved', text)).status).toBe(415)
    expect((await call(DATA, 'POST', '/api/places/saved/import', text)).status).toBe(415)
    expect((await call(DATA, 'PATCH', '/api/places/saved/:id', { params: { id: '1' }, ...text })).status).toBe(415)
  })

  it('refuses a saved place with no name, or coordinates off the planet', async () => {
    expect((await call(DATA, 'POST', '/api/places/saved', { json: { name: '', lat: 1, lon: 1 } })).status).toBe(400)
    expect((await call(DATA, 'POST', '/api/places/saved', { json: { name: 'X', lat: 999, lon: 1 } })).status).toBe(400)
    expect((await call(DATA, 'POST', '/api/places/saved', { json: { name: 'X', lat: 1, lon: 999 } })).status).toBe(400)
  })

  it('refuses malformed JSON and unknown or non-numeric ids', async () => {
    expect((await call(DATA, 'POST', '/api/places/saved/import', { raw: 'not json', type: 'application/json' })).status).toBe(400)
    expect((await call(DATA, 'PATCH', '/api/places/saved/:id', { params: { id: '999999' }, json: { name: 'x' } })).status).toBe(404)
    expect((await call(DATA, 'PATCH', '/api/places/saved/:id', { params: { id: 'abc' }, json: {} })).status).toBe(400)
    expect((await call(DATA, 'DELETE', '/api/places/saved/:id', { params: { id: '999999' } })).status).toBe(404)
    expect((await call(DATA, 'DELETE', '/api/places/saved/:id', { params: { id: 'abc' } })).status).toBe(400)
  })

  it('there is no route that runs caller-supplied SQL (issue #1)', async () => {
    // The raw passthrough was removed: no route answers an arbitrary SELECT, so no table can be read whole.
    for (const sql of ['select 1 as one', 'select * from position', 'drop table position']) {
      const r = await fetch(DATA + '/api/analytics/query', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE_TOKEN}` },
        body: JSON.stringify({ sql }),
        signal: AbortSignal.timeout(30_000),
      })
      const text = await r.text()
      expect(r.status, sql).toBeGreaterThanOrEqual(400)
      expect(r.status, sql).toBeLessThan(500)
      expect(text, sql).not.toContain('"rows"')
    }
    // and nothing was lost
    expect((await GET(DATA, '/api/device/tsdb-status')).body.position_rows).toBeGreaterThan(0)
  })
})

// ─── missing capability ──────────────────────────────────────────────────────

describe('missing capability: the store is not there', () => {
  const fakeBoot = { bootId: UNKNOWN_BOOT }

  it('every store-backed route answers 502 "store unreachable": a JSON error, quickly', async () => {
    const routes = inventory.filter(r => r.method === 'GET' && !r.path.startsWith('/api/places/saved') && !r.path.startsWith('/api/auth/'))
    for (const r of routes) {
      const started = Date.now()
      const res = await GET(DOWN, r.path, { params: fakeBoot, query: { boot_id: UNKNOWN_BOOT } })
      expect(Date.now() - started, r.path).toBeLessThan(10_000)
      expect(res.status, r.path).toBe(502)
      expect(res.body?.error, r.path).toBe(true)
      expect(res.body?.statusMessage, r.path).toBe('store unreachable')
      // no internals in the body: no stack, no connection details, no file paths
      expect(res.text, r.path).not.toMatch(/ECONNREFUSED|\bat .*\(.*:\d+:\d+\)|node_modules|\/Users\/|\/home\//)
    }
  })

  it('says plainly that the store is unreachable where the page is about the store', async () => {
    const r = await GET(DOWN, '/api/device/tsdb-status')
    expect(r.status).toBe(502)
    expect(r.body.statusMessage).toMatch(/unreachable/i)
  })

  it('saved places do not need the store: they are local', async () => {
    const made = await call(DOWN, 'POST', '/api/places/saved', { json: { name: 'Offline home', lat: 36.5, lon: -121.9 } })
    expect(made.status).toBe(200)
    const exp = await GET(DOWN, '/api/places/saved/export')
    expect(exp.status).toBe(200)
    expect(exp.body.saved.map((p: any) => p.name)).toContain('Offline home')
  })
})

// ─── access ──────────────────────────────────────────────────────────────────

describe('saved places: access and round trip', () => {
  it('create, list, edit, export, import (idempotent) and delete', async () => {
    const a = await call(DATA, 'POST', '/api/places/saved', { json: { name: 'Acceptance A', lat: 36.5501, lon: -121.9201, category: 'Home' } })
    const b = await call(DATA, 'POST', '/api/places/saved', { json: { name: 'Acceptance B', lat: 36.6001, lon: -121.8601 } })
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    const idA = a.body.saved.id
    const idB = b.body.saved.id

    const listed = (await GET(DATA, '/api/places')).body.saved.map((p: any) => p.name)
    expect(listed).toEqual(expect.arrayContaining(['Acceptance A', 'Acceptance B']))

    const edited = await call(DATA, 'PATCH', '/api/places/saved/:id', { params: { id: String(idA) }, json: { name: 'Acceptance A2' } })
    expect(edited.body.saved.name).toBe('Acceptance A2')

    const exp = await GET(DATA, '/api/places/saved/export')
    expect(exp.status).toBe(200)
    expect(exp.headers.get('content-disposition')).toMatch(/attachment; filename="cairn-saved-places-\d{4}-\d{2}-\d{2}\.json"/)
    expect(exp.body.saved.map((p: any) => p.name)).toEqual(expect.arrayContaining(['Acceptance A2', 'Acceptance B']))

    // importing what was just exported changes nothing, however many times
    const count = () => GET(DATA, '/api/places/saved/export').then(r => r.body.saved.length)
    const before = await count()
    await call(DATA, 'POST', '/api/places/saved/import', { json: exp.body })
    await call(DATA, 'POST', '/api/places/saved/import', { json: exp.body })
    expect(await count()).toBe(before)

    expect((await call(DATA, 'DELETE', '/api/places/saved/:id', { params: { id: String(idA) } })).body).toEqual({ ok: true })
    expect((await call(DATA, 'DELETE', '/api/places/saved/:id', { params: { id: String(idB) } })).body).toEqual({ ok: true })
    const after = (await GET(DATA, '/api/places')).body.saved.map((p: any) => p.name)
    expect(after).not.toContain('Acceptance A2')
    expect(after).not.toContain('Acceptance B')
  })

  it('no route reveals where the saved places live on disk', async () => {
    expect(PLACES_DIR, 'CAIRN_WEB_PLACES must be set').toBeTruthy()
    const tripBoot = (await GET(DATA, '/api/trips')).body.trips[0].boot_id
    for (const r of inventory.filter(x => x.method === 'GET')) {
      const res = await GET(DATA, r.path, { params: { bootId: tripBoot }, query: { boot_id: tripBoot } })
      expect(res.text, r.path).not.toContain(PLACES_DIR)
      expect(res.text, r.path).not.toMatch(/\.sqlite/)
    }
  })
})

// ─── coverage ────────────────────────────────────────────────────────────────

describe('coverage', () => {
  it('every route in tests/routes.json was exercised', () => {
    // vitest runs describe blocks in order, so by now every scenario has run
    const missing = inventory.map(r => key(r.method, r.path)).filter(k => !exercised.has(k))
    expect(missing).toEqual([])
  })
})
