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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

const DATA = process.env.CAIRN_WEB_DATA ?? ''
const EMPTY = process.env.CAIRN_WEB_EMPTY ?? ''
const DOWN = process.env.CAIRN_WEB_DOWN ?? ''
const PLACES_DIR = process.env.CAIRN_WEB_PLACES ?? ''

const inventory = JSON.parse(readFileSync(join(__dirname, '..', 'routes.json'), 'utf8')) as { method: string; path: string }[]
const key = (m: string, p: string) => `${m} ${p}`

// every (method, route) any scenario exercised, so a route nobody tests fails the suite
const exercised = new Set<string>()

type Res = { status: number; body: any; text: string; headers: Headers }

async function call(base: string, method: string, route: string, opts: { params?: Record<string, string>; query?: Record<string, string>; json?: unknown; raw?: string; type?: string } = {}): Promise<Res> {
  exercised.add(key(method, route))
  let path = route
  for (const [k, v] of Object.entries(opts.params ?? {})) path = path.replace(`:${k}`, v)
  const url = new URL(base + path)
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v)
  const headers: Record<string, string> = {}
  let body: string | undefined
  if (opts.json !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(opts.json)
  } else if (opts.raw !== undefined) {
    headers['content-type'] = opts.type ?? 'text/plain'
    body = opts.raw
  }
  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(30_000) })
  const text = await res.text()
  let parsed: any = null
  try { parsed = JSON.parse(text) } catch { /* not JSON */ }
  return { status: res.status, body: parsed, text, headers: res.headers }
}

const hex32 = /^[0-9a-f]{32}$/
const iso = (s: unknown) => typeof s === 'string' && !Number.isNaN(Date.parse(s))
const between = (n: unknown, lo: number, hi: number) => typeof n === 'number' && n >= lo && n <= hi
const GET = (base: string, route: string, o?: Parameters<typeof call>[3]) => call(base, 'GET', route, o)

const UNKNOWN_BOOT = '0'.repeat(32)
const BOOT_SCOPED = ['/api/trips/:bootId', '/api/trips/:bootId/events', '/api/trips/:bootId/fuel', '/api/trips/:bootId/insights', '/api/trips/:bootId/route', '/api/trips/:bootId/stops', '/api/trips/:bootId/telemetry', '/api/trips/:bootId/timeline']
const BOOT_QUERY = ['/api/analytics/telemetry', '/api/analytics/imu', '/api/analytics/drive-summary', '/api/analytics/boost-detail', '/api/analytics/fuel-health']

beforeAll(() => {
  for (const [name, v] of Object.entries({ CAIRN_WEB_DATA: DATA, CAIRN_WEB_EMPTY: EMPTY, CAIRN_WEB_DOWN: DOWN })) {
    if (!v) throw new Error(`${name} is not set: run tests/staging.sh, which starts the staged instances`)
  }
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
        headers: { 'content-type': 'application/json' },
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
    const routes = inventory.filter(r => r.method === 'GET' && !r.path.startsWith('/api/places/saved'))
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
