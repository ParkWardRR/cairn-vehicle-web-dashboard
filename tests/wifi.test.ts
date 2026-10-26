// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanBssidList, isLocallyAdministered, isUsableBssid, MAX_PLACE_BSSIDS, normalizeBssid } from '../shared/utils/bssid'
import { SavedPlaceError, SavedPlaces } from '../server/utils/placeSaved'
import { PlaceStore } from '../server/utils/placeStore'
import {
  BEACONDB_URL, BeaconDb, beaconKey, beaconRequestBody, parseBeaconAnswer, type ScanAp,
} from '../server/utils/beacondb'
import {
  apsByScan, endpointObsSql, endpointWindows, groupEstimates, mergeCandidates, resolveScans,
  windowFrom, wifiAttribution, type UnfixedScan,
} from '../server/utils/wifiPositions'
import { USER_AGENT } from '../server/utils/placeSources'

// Documentation-range addresses (RFC 7042, 00-00-5E-00-53-xx) and a few made-up
// globally administered ones; none is a real access point.
const A = '00:00:5e:00:53:01'
const B = '00:00:5e:00:53:02'
const C = '00:00:5e:00:53:03'
const D = '00:00:5e:00:53:04'
const HOTSPOT = '02:00:5e:00:53:09' // locally administered

describe('BSSIDs', () => {
  it('normalises case and dashes, and refuses what is not a MAC address', () => {
    expect(normalizeBssid('00-00-5E-00-53-01')).toBe(A)
    expect(normalizeBssid(' 00:00:5E:00:53:01 ')).toBe(A)
    expect(normalizeBssid('00:00:5e:00:53')).toBeNull()
    expect(normalizeBssid('0000.5e00.5301')).toBeNull()
    expect(normalizeBssid(42)).toBeNull()
  })

  it('a locally administered address (bit 0x02 of the first octet) cannot mark a place', () => {
    expect(isLocallyAdministered(HOTSPOT)).toBe(true)
    expect(isLocallyAdministered('da:a1:19:00:00:01')).toBe(true) // 0xda has bit 0x02
    expect(isLocallyAdministered(A)).toBe(false)
    expect(isUsableBssid(HOTSPOT)).toBe(false)
    expect(isUsableBssid('01:00:5e:00:00:01')).toBe(false) // multicast
    expect(isUsableBssid('00:00:00:00:00:00')).toBe(false)
    expect(isUsableBssid(A)).toBe(true)
  })

  it('validates a list: de-duplicated, sorted, at most 64, with messages fit for the user', () => {
    expect(cleanBssidList([B, A.toUpperCase(), A])).toEqual([A, B])
    expect(cleanBssidList(undefined)).toEqual([])
    expect(() => cleanBssidList('aa:bb')).toThrow(/list/)
    expect(() => cleanBssidList(['nope'])).toThrow(/not a BSSID/)
    expect(() => cleanBssidList([HOTSPOT])).toThrow(/locally administered/)
    const many = Array.from({ length: MAX_PLACE_BSSIDS + 1 }, (_, i) => `00:00:5e:00:${(i >> 8).toString(16).padStart(2, '0')}:${(i & 255).toString(16).padStart(2, '0')}`)
    expect(cleanBssidList(many.slice(0, MAX_PLACE_BSSIDS))).toHaveLength(MAX_PLACE_BSSIDS)
    expect(() => cleanBssidList(many)).toThrow(/at most 64/)
  })
})

describe('saved places and their networks', () => {
  const dirs: string[] = []
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

  it('migrates a file from before bssids (and before source), keeping every place', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cairn-saved-'))
    dirs.push(dir)
    const file = join(dir, 'saved-places.sqlite')
    const old = new DatabaseSync(file)
    old.exec(`CREATE TABLE saved_places (id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT,
      lat REAL NOT NULL, lon REAL NOT NULL, radius_m INTEGER NOT NULL, note TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`)
    old.prepare('INSERT INTO saved_places (name, category, lat, lon, radius_m, note, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
      .run('Home', 'Home', 34, -118.4, 100, null, 1, 1)
    old.close()

    const s = new SavedPlaces(file)
    const [p] = s.list()
    expect(p).toMatchObject({ name: 'Home', source: 'user', bssids: [] })
    const cols = (new DatabaseSync(file).prepare('PRAGMA table_info(saved_places)').all() as any[]).map(c => c.name)
    expect(cols).toEqual(expect.arrayContaining(['source', 'learned_from', 'bssids']))

    expect(s.update(p.id, { bssids: [B, A] })!.bssids).toEqual([A, B])
    s.close()
    // and it survives a reopen
    const again = new SavedPlaces(file)
    expect(again.get(p.id)!.bssids).toEqual([A, B])
    again.close()
  })

  it('refuses bad networks as a SavedPlaceError (a 400), and leaves the place alone', () => {
    const s = new SavedPlaces(':memory:')
    const p = s.create({ name: 'Gym', lat: 34, lon: -118, bssids: [A] })
    expect(() => s.update(p.id, { bssids: [HOTSPOT] })).toThrow(SavedPlaceError)
    expect(() => s.create({ name: 'x', lat: 1, lon: 1, bssids: ['zz'] as any })).toThrow(SavedPlaceError)
    expect(s.get(p.id)!.bssids).toEqual([A])
    // a patch that does not mention bssids keeps them
    expect(s.update(p.id, { name: 'Gym 2' })!.bssids).toEqual([A])
  })

  it('a scan resolves to the place with the most matching networks, the strongest signal breaking a tie', () => {
    const s = new SavedPlaces(':memory:')
    const home = s.create({ name: 'Home', lat: 34, lon: -118, bssids: [A, B] })
    const nextDoor = s.create({ name: 'Next door', lat: 34.0002, lon: -118, bssids: [C] })
    const both = s.create({ name: 'Both', lat: 34.0004, lon: -118, bssids: [D] })

    expect(s.matchBssids([{ bssid: A, rssi_dbm: -80 }, { bssid: B, rssi_dbm: -85 }, { bssid: C, rssi_dbm: -40 }])?.place.id).toBe(home.id)
    // one each: the stronger wins
    const tie = s.matchBssids([{ bssid: C, rssi_dbm: -70 }, { bssid: D, rssi_dbm: -50 }])!
    expect(tie.place.id).toBe(both.id)
    expect(tie).toMatchObject({ matches: 1, best_rssi_dbm: -50 })
    expect(s.matchBssids([{ bssid: C.toUpperCase(), rssi_dbm: -70 }])?.place.id).toBe(nextDoor.id)
    expect(s.matchBssids([{ bssid: '00:00:5e:00:53:77', rssi_dbm: -30 }])).toBeNull()
    expect(s.matchBssids([])).toBeNull()
  })

  it('keeps one Home: marking a place Home takes the kind off the old one', () => {
    const s = new SavedPlaces(':memory:')
    const a = s.create({ name: 'Old flat', lat: 34, lon: -118, category: 'Home' })
    const b = s.create({ name: 'New house', lat: 34.1, lon: -118, category: 'Home' })
    expect(s.get(a.id)!.category).toBeNull()
    expect(s.get(a.id)!.name).toBe('Old flat')
    expect(s.home()?.id).toBe(b.id)
    s.update(a.id, { category: 'Home' })
    expect(s.home()?.id).toBe(a.id)
    expect(s.get(b.id)!.category).toBeNull()
  })

  it('exports and imports networks and settings', () => {
    const s = new SavedPlaces(':memory:')
    s.create({ name: 'Home', lat: 34, lon: -118, bssids: [A] })
    s.setSetting('beacondb', 'off')
    const exp = s.exportAll()
    expect(exp.saved[0].bssids).toEqual([A])
    expect(exp.settings).toEqual({ beacondb: 'off' })

    const t = new SavedPlaces(':memory:')
    t.importAll(JSON.parse(JSON.stringify(exp)))
    expect(t.list()[0].bssids).toEqual([A])
    expect(t.getSetting('beacondb')).toBe('off')

    // a choice already made here is not overwritten by the file
    const u = new SavedPlaces(':memory:')
    u.setSetting('beacondb', 'on')
    u.importAll(exp)
    expect(u.getSetting('beacondb')).toBe('on')
  })
})

// ---------- beaconDB ----------

function fakeFetch(answers: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; init: any }> = []
  const fn = vi.fn(async (url: string, init: any) => {
    calls.push({ url, init })
    const a = answers.shift() ?? { status: 404, body: { error: { code: 404 } } }
    return { status: a.status, json: async () => a.body }
  })
  return { fn, calls }
}

function clock(start = Date.UTC(2026, 9, 25)) {
  let t = start
  const sleeps: number[] = []
  return {
    now: () => t,
    sleep: async (ms: number) => { sleeps.push(ms); t += ms },
    advance: (ms: number) => { t += ms },
    sleeps,
  }
}

const scan = (...aps: Array<[string, number | null]>): ScanAp[] => aps.map(([bssid, rssi_dbm]) => ({ bssid, rssi_dbm }))

describe('beaconDB', () => {
  it('sends only BSSIDs and signal strengths, strongest first, with no IP or cell fallback', () => {
    const body = beaconRequestBody(scan([A, -80], [HOTSPOT, -20], [B.toUpperCase(), -40], [C, null], [B, -60]))
    expect(body).toEqual({
      considerIp: false,
      fallbacks: { lacf: false, ipf: false },
      wifiAccessPoints: [
        { macAddress: B, signalStrength: -40 },
        { macAddress: A, signalStrength: -80 },
        { macAddress: C },
      ],
    })
    // nothing else at all: no names, no position, no time
    expect(Object.keys(body!).sort()).toEqual(['considerIp', 'fallbacks', 'wifiAccessPoints'])
    for (const ap of body!.wifiAccessPoints) expect(Object.keys(ap).every(k => k === 'macAddress' || k === 'signalStrength')).toBe(true)
  })

  it('needs at least two usable access points', () => {
    expect(beaconRequestBody(scan([A, -50]))).toBeNull()
    expect(beaconRequestBody(scan([A, -50], [HOTSPOT, -40]))).toBeNull()
    expect(beaconKey(scan([A, -50], [A, -60]))).toBeNull()
    expect(beaconKey(scan([B, -50], [A, -60]))).toBe(`${A},${B}`)
  })

  it('reads the answers: a location, 404 as "not found", fallbacks and errors', () => {
    expect(parseBeaconAnswer(200, { location: { lat: 34.1, lng: -118.2 }, accuracy: 40 })).toEqual({ kind: 'found', lat: 34.1, lon: -118.2, accuracy_m: 40 })
    expect(parseBeaconAnswer(404, { error: { code: 404, message: 'Not found' } })).toEqual({ kind: 'none' })
    expect(parseBeaconAnswer(200, { location: { lat: 1, lng: 2 }, accuracy: 5000, fallback: 'ipf' })).toEqual({ kind: 'none' })
    expect(parseBeaconAnswer(429, null).kind).toBe('error')
    expect(parseBeaconAnswer(503, null).kind).toBe('error')
    expect(parseBeaconAnswer(200, { location: {} }).kind).toBe('error')
  })

  it('queues a miss, posts it with an identifying User-Agent, and never sends the same set twice', async () => {
    const store = new PlaceStore(':memory:')
    const c = clock()
    const { fn, calls } = fakeFetch([{ status: 200, body: { location: { lat: 34.05, lng: -118.25 }, accuracy: 35 } }])
    const db = new BeaconDb(store, { enabled: () => true, fetch: fn as any, now: c.now, sleep: c.sleep })

    expect(db.lookup(scan([A, -50], [B, -70]))).toEqual({ status: 'pending' })
    // asked again before it is back: still one request
    expect(db.lookup(scan([B, -71], [A, -49]))).toEqual({ status: 'pending' })
    await db.idle()

    expect(fn).toHaveBeenCalledTimes(1)
    expect(calls[0].url).toBe(BEACONDB_URL)
    expect(calls[0].url).toBe('https://api.beacondb.net/v1/geolocate')
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers['User-Agent']).toBe(USER_AGENT)
    expect(calls[0].init.headers['User-Agent']).toMatch(/^Cairn\/.+github\.com/)
    expect(JSON.parse(calls[0].init.body)).toEqual(beaconRequestBody(scan([A, -50], [B, -70])))

    // the same set, in another order with other signal strengths, is answered from the cache
    expect(db.lookup(scan([B, -90], [A, -30]))).toEqual({ status: 'found', lat: 34.05, lon: -118.25, accuracy_m: 35 })
    await db.idle()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('remembers "not found", so a set beaconDB does not know is not asked about again', async () => {
    const store = new PlaceStore(':memory:')
    const c = clock()
    const { fn } = fakeFetch([{ status: 404, body: { error: { code: 404 } } }])
    const db = new BeaconDb(store, { enabled: () => true, fetch: fn as any, now: c.now, sleep: c.sleep })
    db.lookup(scan([A, -50], [B, -70]))
    await db.idle()
    expect(db.lookup(scan([A, -50], [B, -70]))).toEqual({ status: 'none' })
    c.advance(365 * 24 * 3600 * 1000)
    expect(db.lookup(scan([A, -50], [B, -70]))).toEqual({ status: 'none' })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(store.wifiLookupCount('beacondb')).toEqual({ found: 0, none: 1 })
  })

  it('does not cache a failure, and retries it later', async () => {
    const store = new PlaceStore(':memory:')
    const c = clock()
    const { fn } = fakeFetch([{ status: 503 }, { status: 200, body: { location: { lat: 1, lng: 2 }, accuracy: 10 } }])
    const db = new BeaconDb(store, { enabled: () => true, fetch: fn as any, now: c.now, sleep: c.sleep })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    db.lookup(scan([A, -50], [B, -70]))
    await db.idle()
    expect(db.lookup(scan([A, -50], [B, -70]))).toEqual({ status: 'failed' })
    c.advance(11 * 60 * 1000)
    expect(db.lookup(scan([A, -50], [B, -70]))).toEqual({ status: 'pending' })
    await db.idle()
    expect(db.lookup(scan([A, -50], [B, -70]))).toMatchObject({ status: 'found' })
    expect(fn).toHaveBeenCalledTimes(2)
    err.mockRestore()
  })

  it('sends at most one request a second', async () => {
    const store = new PlaceStore(':memory:')
    const c = clock()
    const { fn } = fakeFetch([])
    const db = new BeaconDb(store, { enabled: () => true, fetch: fn as any, now: c.now, sleep: c.sleep })
    db.lookup(scan([A, -50], [B, -70]))
    db.lookup(scan([A, -50], [C, -70]))
    db.lookup(scan([B, -50], [C, -70]))
    await db.idle()
    expect(fn).toHaveBeenCalledTimes(3)
    expect(c.sleeps).toEqual([1000, 1000])
  })

  it('sends nothing when turned off, and a cached answer is still used', async () => {
    const store = new PlaceStore(':memory:')
    store.saveWifiLookup({ key: `${A},${B}`, source: 'beacondb', found: true, lat: 3, lon: 4, accuracy_m: 20, fetched_at: 1 })
    const { fn } = fakeFetch([])
    const db = new BeaconDb(store, { enabled: () => false, fetch: fn as any })
    expect(db.lookup(scan([A, -50], [C, -70]))).toEqual({ status: 'off' })
    expect(db.lookup(scan([A, -50], [B, -70]))).toMatchObject({ status: 'found', lat: 3 })
    expect(db.lookup(scan([A, -50]))).toEqual({ status: 'too_few' })
    await db.idle()
    expect(fn).not.toHaveBeenCalled()
  })
})

// ---------- resolving unfixed scans ----------

const unfixed = (seq: number, est: Partial<UnfixedScan> = {}): UnfixedScan => ({
  boot_id: 'b'.repeat(32), seq, mono_ms: seq * 10_000, observed_at: `2026-10-25T08:00:${String(seq).padStart(2, '0')}Z`,
  ap_count: 2, est_lat: null, est_lon: null, est_accuracy_m: null, est_aps: null, ...est,
})

describe('resolving unfixed scans: place, then learned, then beaconDB', () => {
  const saved = new SavedPlaces(':memory:')
  const home = saved.create({ name: 'Home', category: 'Home', lat: 34, lon: -118, radius_m: 60, bssids: [A] })
  const obs = apsByScan([
    { boot_id: 'b'.repeat(32), seq: 1, bssid: A, rssi_dbm: -50 },
    { boot_id: 'b'.repeat(32), seq: 1, bssid: B, rssi_dbm: -60 },
    { boot_id: 'b'.repeat(32), seq: 2, bssid: B, rssi_dbm: -60 },
    { boot_id: 'b'.repeat(32), seq: 2, bssid: C, rssi_dbm: -60 },
    { boot_id: 'b'.repeat(32), seq: 3, bssid: C, rssi_dbm: -60 },
    { boot_id: 'b'.repeat(32), seq: 3, bssid: D, rssi_dbm: -60 },
    { boot_id: 'b'.repeat(32), seq: 4, bssid: D, rssi_dbm: -60 },
  ])
  const beacon = {
    lookup: vi.fn((aps: ScanAp[]) => {
      const k = beaconKey(aps)
      if (k === `${C},${D}`) return { status: 'found' as const, lat: 34.2, lon: -118.2, accuracy_m: 80 }
      return k ? { status: 'pending' as const } : { status: 'too_few' as const }
    }),
  }

  it('takes a saved place over the store\'s estimate, the estimate over beaconDB', () => {
    const r = resolveScans([
      unfixed(1, { est_lat: 35, est_lon: -119, est_accuracy_m: 30, est_aps: 1 }), // A is at Home
      unfixed(2, { est_lat: 35, est_lon: -119, est_accuracy_m: 30, est_aps: 2 }), // learned
      unfixed(3), // beaconDB knows C+D
      unfixed(4), // one AP: nothing to ask
    ], obs, saved, beacon)

    expect(r.estimates.map(e => e.source)).toEqual(['place', 'learned', 'beacondb'])
    expect(r.estimates[0]).toMatchObject({ lat: 34, lon: -118, accuracy_m: 60, aps: 1, place: { id: home.id, name: 'Home', kind: 'home' } })
    expect(r.estimates[1]).toMatchObject({ lat: 35, lon: -119, accuracy_m: 30, aps: 2, place: null })
    expect(r.estimates[2]).toMatchObject({ lat: 34.2, lon: -118.2, accuracy_m: 80, place: null })
    expect(r.unresolved).toBe(1)
    expect(r.pending).toBe(false)
    // beaconDB is asked only when the first two have nothing
    expect(beacon.lookup).toHaveBeenCalledTimes(2)
    expect(wifiAttribution(r.sources)).toEqual(['Wi-Fi positions: beaconDB'])
  })

  it('reports a pending lookup, and works with beaconDB absent', () => {
    const s2 = apsByScan([{ boot_id: 'b'.repeat(32), seq: 9, bssid: B, rssi_dbm: -60 }, { boot_id: 'b'.repeat(32), seq: 9, bssid: C, rssi_dbm: -70 }])
    expect(resolveScans([unfixed(9)], s2, saved, beacon)).toMatchObject({ pending: true, unresolved: 1, estimates: [] })
    expect(resolveScans([unfixed(9)], s2, saved, null)).toMatchObject({ pending: false, unresolved: 1, estimates: [] })
    expect(wifiAttribution(new Set(['place', 'learned']))).toEqual([])
  })

  it('folds a run of scans at one spot into one point', () => {
    const r = resolveScans([1, 1, 1].map((_, i) => unfixed(i + 1, {})).map(s => ({ ...s, seq: 1 })), obs, saved, null)
    const g = groupEstimates(r.estimates)
    expect(g).toHaveLength(1)
    expect(g[0]).toMatchObject({ scans: 3, source: 'place', from: r.estimates[0].observed_at, to: r.estimates[2].observed_at })

    const learned = groupEstimates([
      { ...r.estimates[0], source: 'learned', place: null, lat: 35, lon: -119, accuracy_m: 40 },
      { ...r.estimates[0], source: 'learned', place: null, lat: 35.00005, lon: -119, accuracy_m: 30 },
      { ...r.estimates[0], source: 'learned', place: null, lat: 35.01, lon: -119, accuracy_m: 30 },
    ])
    expect(learned.map(x => x.scans)).toEqual([2, 1])
    expect(learned[0].accuracy_m).toBe(30)
  })
})

describe('the trip window', () => {
  it('reaches ten minutes either side, but never into the previous or next trip', () => {
    expect(windowFrom('2026-10-25 08:00:00.000', '2026-10-25 08:30:00.000', null, null, "'v'"))
      .toMatchObject({ from: '2026-10-25 07:50:00.000', to: '2026-10-25 08:40:00.000' })
    expect(windowFrom('2026-10-25 08:00:00.000', '2026-10-25 08:30:00.000', '2026-10-25 07:55:00.000', '2026-10-25 08:33:00.000', "'v'"))
      .toMatchObject({ from: '2026-10-25 07:55:00.000', to: '2026-10-25 08:33:00.000' })
  })
})

describe('networks seen here', () => {
  const place = { lat: 34, lon: -118, radius_m: 100, bssids: [D] }
  const boot = 'c'.repeat(32)

  it('looks before each departure from the place and after each arrival at it', () => {
    const w = endpointWindows(place, [
      { boot_id: boot, kind: 'departure', key_ms: 60_000, lat: 34.0001, lon: -118, at: '2026-10-25T08:00:00Z' },
      { boot_id: boot, kind: 'arrival', key_ms: 3_600_000, lat: 34.0001, lon: -118, at: '2026-10-25T09:00:00Z' },
      { boot_id: boot, kind: 'stop', key_ms: 1_000_000, lat: 34, lon: -118, at: null },
      { boot_id: boot, kind: 'departure', key_ms: 60_000, lat: 35, lon: -118, at: null }, // elsewhere
      { boot_id: "x'; drop table position; --", kind: 'departure', key_ms: 1, lat: 34, lon: -118, at: null },
    ])
    expect(w).toEqual([
      { boot_id: boot, lo_ms: 3_600_000, hi_ms: 3_600_000 + 15 * 60_000 },
      { boot_id: boot, lo_ms: 0, hi_ms: 60_000 },
    ])
    const sql = endpointObsSql(w)!
    expect(sql).toContain(`('${boot}', 0, 60000)`)
    expect(sql).toMatch(/WITH w AS \(/)
    expect(endpointObsSql([])).toBeNull()
  })

  it('merges the learned map and the trip ends, attached first, and never offers a hotspot', () => {
    const list = mergeCandidates(place, [
      { bssid: A, lat: 34.0002, lon: -118, observations: 12, spread_m: 8.4, max_rssi_dbm: -55, last_seen: '2026-10-20T08:00:00Z' },
      { bssid: B, lat: 34.01, lon: -118, observations: 50, spread_m: 5, max_rssi_dbm: -40, last_seen: '2026-10-21T08:00:00Z' }, // outside the circle
      { bssid: HOTSPOT, lat: 34, lon: -118, observations: 99, spread_m: 1, max_rssi_dbm: -30, last_seen: null },
    ], [
      { bssid: A, sightings: 4, boots: 2, max_rssi_dbm: -48, last_seen: '2026-10-24T08:00:00Z' },
      { bssid: C, sightings: 30, boots: 3, max_rssi_dbm: -70, last_seen: '2026-10-23T08:00:00Z' },
    ])
    expect(list.map(c => c.bssid)).toEqual([D, C, A])
    expect(list[0]).toMatchObject({ attached: true, learned: null, at_trip_ends: null })
    expect(list[2]).toMatchObject({
      attached: false, max_rssi_dbm: -48, last_seen: '2026-10-24T08:00:00Z',
      learned: { observations: 12, dist_m: 22, spread_m: 8 }, at_trip_ends: { sightings: 4, boots: 2 },
    })
  })
})
