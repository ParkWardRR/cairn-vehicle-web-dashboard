import { BeaconDb, type BeaconLookup, type ScanAp, BEACONDB_ATTRIBUTION } from './beacondb'
import type { BssidMatch, HeardAp, SavedPlace, SavedPlaces } from './placeSaved'
import type { TripScope } from './trip'
import { distM } from './placeLabel'
import { kindForCategory } from '../../shared/utils/placeKinds'
import { isUsableBssid, normalizeBssid } from '../../shared/utils/bssid'

// Where the car was when GNSS had no fix (a cold start in the garage, a parking
// structure), worked out from the Wi-Fi access points it heard.
//
// The store (store/v1.7) records every scan (wifi_scan) and the access points in it
// (wifi_ap_obs), learns where each access point is from trusted GNSS fixes taken beside
// learning scans (v_wifi_ap_learned), and lists the scans that had no trusted fix within
// ±5 s together with its own estimate from that learned map (v_wifi_scan_unfixed).
//
// This layer resolves each unfixed scan, first match wins:
//   (a) a saved place with one of the scan's BSSIDs attached: the place, accuracy its
//       radius ("place"); the place with the most matches wins, the strongest signal
//       breaking a tie;
//   (b) the store's learned estimate ("learned");
//   (c) beaconDB ("beacondb"), if it is on.
//
// These are estimates, never fixes: nothing here feeds a track, a speed, a maximum, a
// distance or a stop. Network names are never recorded, so none are shown.

export type WifiSource = 'place' | 'learned' | 'beacondb'

export const WIFI_OBJECTS = ['wifi_scan', 'wifi_ap_obs', 'v_wifi_ap_learned', 'v_wifi_scan_unfixed'] as const

// Scans this long before a trip's start and after its end are included, so a cold
// start from home (the first leg before the receiver has a fix) is shown.
export const WIFI_MARGIN_MS = 10 * 60 * 1000
// For "networks seen here": unfixed scans this long before a boot's first fix (it left
// from here) or after its last (it arrived here).
export const ENDPOINT_WINDOW_MS = 15 * 60 * 1000

export interface UnfixedScan {
  boot_id: string
  seq: number
  mono_ms: number
  observed_at: string
  ap_count: number | null
  est_lat: number | null
  est_lon: number | null
  est_accuracy_m: number | null
  est_aps: number | null
}

export interface ObsRow {
  boot_id: string
  seq: number
  bssid: string
  rssi_dbm: number | null
}

export interface WifiEstimate {
  boot_id: string
  seq: number
  mono_ms: number
  observed_at: string
  lat: number
  lon: number
  accuracy_m: number | null
  source: WifiSource
  place: { id: number; name: string; kind: string } | null
  // Access points behind the estimate: matched to the place, matched in the learned
  // map, or sent to beaconDB.
  aps: number
}

// Several scans in a row that say the same thing, drawn as one point.
export interface WifiEstimateGroup {
  from: string
  to: string
  from_mono_ms: number
  to_mono_ms: number
  boot_id: string
  scans: number
  lat: number
  lon: number
  accuracy_m: number | null
  source: WifiSource
  place: { id: number; name: string; kind: string } | null
  aps: number
}

export interface Resolution {
  estimates: WifiEstimate[]
  unresolved: number
  pending: boolean
  sources: Set<WifiSource>
}

type BssidMatcher = { matchBssids(heard: HeardAp[]): BssidMatch | null }
type Looker = { lookup(aps: ScanAp[]): BeaconLookup }

export const scanKey = (bootId: string, seq: number) => `${bootId}:${seq}`

export function apsByScan(rows: ObsRow[]): Map<string, ScanAp[]> {
  const out = new Map<string, ScanAp[]>()
  for (const r of rows) {
    const k = scanKey(r.boot_id, Number(r.seq))
    const list = out.get(k)
    const ap = { bssid: String(r.bssid), rssi_dbm: r.rssi_dbm == null ? null : Number(r.rssi_dbm) }
    if (list) list.push(ap)
    else out.set(k, [ap])
  }
  return out
}

function placeRef(p: SavedPlace) {
  return { id: p.id, name: p.name, kind: kindForCategory(p.category, p.name) }
}

const finite = (v: unknown): v is number => v != null && Number.isFinite(Number(v))

// Resolves every scan in the order (a) place, (b) learned, (c) beaconDB.
export function resolveScans(scans: UnfixedScan[], aps: Map<string, ScanAp[]>, saved: BssidMatcher, beacon: Looker | null): Resolution {
  const estimates: WifiEstimate[] = []
  const sources = new Set<WifiSource>()
  let unresolved = 0
  let pending = false

  for (const s of scans) {
    const heard = aps.get(scanKey(s.boot_id, Number(s.seq))) ?? []
    const base = { boot_id: s.boot_id, seq: Number(s.seq), mono_ms: Number(s.mono_ms), observed_at: s.observed_at }

    const m = saved.matchBssids(heard)
    if (m) {
      estimates.push({ ...base, lat: m.place.lat, lon: m.place.lon, accuracy_m: m.place.radius_m, source: 'place', place: placeRef(m.place), aps: m.matches })
      sources.add('place')
      continue
    }

    if (finite(s.est_lat) && finite(s.est_lon)) {
      estimates.push({
        ...base, lat: Number(s.est_lat), lon: Number(s.est_lon),
        accuracy_m: finite(s.est_accuracy_m) ? Number(s.est_accuracy_m) : null,
        source: 'learned', place: null, aps: finite(s.est_aps) ? Number(s.est_aps) : 0,
      })
      sources.add('learned')
      continue
    }

    const b = beacon?.lookup(heard)
    if (b?.status === 'found') {
      const sent = heard.filter(a => isUsableBssid(normalizeBssid(a.bssid))).length
      estimates.push({ ...base, lat: b.lat, lon: b.lon, accuracy_m: b.accuracy_m, source: 'beacondb', place: null, aps: Math.min(sent, 20) })
      sources.add('beacondb')
      continue
    }
    if (b?.status === 'pending') pending = true
    unresolved++
  }
  return { estimates, unresolved, pending, sources }
}

// Folds runs of scans that put the car in the same spot (the same place, or within a
// few metres by the same source) into one point, so an hour parked at home is one
// marker and not 700.
export function groupEstimates(estimates: WifiEstimate[]): WifiEstimateGroup[] {
  const out: (WifiEstimateGroup & { latSum: number; lonSum: number })[] = []
  for (const e of estimates) {
    const g = out[out.length - 1]
    const same = g && g.source === e.source && g.boot_id === e.boot_id && (
      e.source === 'place'
        ? g.place?.id === e.place?.id
        : distM(g.lat, g.lon, e.lat, e.lon) <= Math.max(15, Math.min(g.accuracy_m ?? 30, e.accuracy_m ?? 30) / 2)
    )
    if (same) {
      g.to = e.observed_at
      g.to_mono_ms = e.mono_ms
      g.scans++
      g.latSum += e.lat
      g.lonSum += e.lon
      g.lat = g.latSum / g.scans
      g.lon = g.lonSum / g.scans
      if (e.accuracy_m != null && (g.accuracy_m == null || e.accuracy_m < g.accuracy_m)) g.accuracy_m = e.accuracy_m
      g.aps = Math.max(g.aps, e.aps)
      continue
    }
    out.push({
      from: e.observed_at, to: e.observed_at, from_mono_ms: e.mono_ms, to_mono_ms: e.mono_ms, boot_id: e.boot_id,
      scans: 1, lat: e.lat, lon: e.lon, accuracy_m: e.accuracy_m, source: e.source, place: e.place, aps: e.aps,
      latSum: e.lat, lonSum: e.lon,
    })
  }
  return out.map(({ latSum: _a, lonSum: _b, ...g }) => g)
}

export function wifiAttribution(sources: Iterable<WifiSource>): string[] {
  return new Set(sources).has('beacondb') ? [BEACONDB_ATTRIBUTION] : []
}

// ---------- what the store offers ----------

export interface WifiCapability {
  // wifi_scan and wifi_ap_obs
  scans: boolean
  learned: boolean
  unfixed: boolean
}

let capCache: { at: number; value: WifiCapability } | null = null

// Whether the store has the Wi-Fi objects (store/v1.7). An older store simply has no
// Wi-Fi positions; nothing errors. A complete answer is kept for 10 minutes, an
// incomplete one for a minute, so a store upgraded underneath is noticed soon.
export async function wifiCapability(now = Date.now()): Promise<WifiCapability> {
  if (capCache && now - capCache.at < (capCache.value.unfixed && capCache.value.learned ? 600_000 : 60_000)) return capCache.value
  const rows = await queryTsdbObjects(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'main' AND table_name IN (${WIFI_OBJECTS.map(n => `'${n}'`).join(', ')})
  `)
  const have = new Set(rows.map(r => String(r.table_name)))
  const scans = have.has('wifi_scan') && have.has('wifi_ap_obs')
  const value = { scans, learned: have.has('v_wifi_ap_learned'), unfixed: scans && have.has('v_wifi_scan_unfixed') }
  capCache = { at: now, value }
  return value
}

export function forgetWifiCapability() { capCache = null }

// The store's answer when a query names a table, view or column it does not have.
export function isMissingObject(e: any): boolean {
  const text = [e?.data, e?.message, e?.statusMessage, e?.response?._data].map(x => (typeof x === 'string' ? x : JSON.stringify(x ?? ''))).join(' ')
  return /Catalog Error|does not exist|not found in FROM clause|Referenced column/i.test(text)
}

// Runs a Wi-Fi query; if the store turns out not to have the objects after all, the
// answer is "nothing" rather than an error. An unreachable store still fails.
export async function wifiQuery(sql: string): Promise<Record<string, any>[]> {
  try {
    return await queryTsdbObjects(sql)
  } catch (e) {
    if (isMissingObject(e)) { forgetWifiCapability(); return [] }
    throw e
  }
}

// ---------- the trip window ----------

const SQL_TS_FMT = '%Y-%m-%d %H:%M:%S.%g'

function parseStoreTime(s: string | null | undefined): number | null {
  if (!s) return null
  const iso = /(?:[zZ]|[+-]\d\d:?\d\d)$/.test(s) ? s : `${s.trim().replace(' ', 'T')}Z`
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

function fmtStoreTime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '')
}

export interface WifiWindow { from: string; to: string; vehicleSql: string }

// The trip's span widened by WIFI_MARGIN_MS each side, but never into the previous or
// the next trip of the same car.
export async function tripWifiWindow(trip: TripScope): Promise<WifiWindow> {
  const rows = await queryTsdbObjects(`
    SELECT
      strftime(max(ended_at) FILTER (WHERE ended_at < ${trip.startSql}), '${SQL_TS_FMT}') AS prev_end,
      strftime(min(started_at) FILTER (WHERE started_at > ${trip.endSql}), '${SQL_TS_FMT}') AS next_start
    FROM v_trip_summary WHERE vehicle_id = ${trip.vehicleSql}
  `)
  return windowFrom(trip.startedAt, trip.endedAt, rows[0]?.prev_end ?? null, rows[0]?.next_start ?? null, trip.vehicleSql)
}

export function windowFrom(startedAt: string, endedAt: string, prevEnd: string | null, nextStart: string | null, vehicleSql: string): WifiWindow {
  const start = parseStoreTime(startedAt) ?? 0
  const end = parseStoreTime(endedAt) ?? start
  const prev = parseStoreTime(prevEnd)
  const next = parseStoreTime(nextStart)
  const lo = Math.max(start - WIFI_MARGIN_MS, prev ?? -Infinity)
  const hi = Math.min(end + WIFI_MARGIN_MS, next ?? Infinity)
  return { from: fmtStoreTime(lo), to: fmtStoreTime(Math.max(lo, hi)), vehicleSql }
}

function windowWhere(w: WifiWindow, alias: string): string {
  return `${alias}.vehicle_id = ${w.vehicleSql} AND ${alias}.observed_at > TIMESTAMP '${w.from}' AND ${alias}.observed_at < TIMESTAMP '${w.to}'`
}

export async function unfixedScansIn(w: WifiWindow): Promise<{ scans: UnfixedScan[]; aps: Map<string, ScanAp[]> }> {
  const [scans, obs] = await Promise.all([
    wifiQuery(`
      SELECT u.boot_id, u.seq, u.mono_ms, u.observed_at, u.ap_count, u.est_lat, u.est_lon, u.est_accuracy_m, u.est_aps
      FROM v_wifi_scan_unfixed u
      WHERE ${windowWhere(w, 'u')}
      ORDER BY u.observed_at, u.mono_ms
      LIMIT 5000
    `),
    wifiQuery(`
      SELECT o.boot_id, o.seq, o.bssid, o.rssi_dbm
      FROM wifi_ap_obs o
      JOIN v_wifi_scan_unfixed u ON u.vehicle_id = o.vehicle_id AND u.boot_id = o.boot_id AND u.seq = o.seq
      WHERE ${windowWhere(w, 'u')}
    `),
  ])
  return { scans: scans as UnfixedScan[], aps: apsByScan(obs as ObsRow[]) }
}

// ---------- beaconDB, as configured ----------

export const BEACONDB_SETTING = 'beacondb'

export interface BeaconDbStatus {
  // What the owner chose on the Places page (default on).
  chosen: boolean
  // Whether this server lets it run at all (external lookups on, not turned off).
  allowed: boolean
  enabled: boolean
  reason: string | null
}

export function beaconDbStatus(saved: Pick<SavedPlaces, 'getSetting'>): BeaconDbStatus {
  const c = useRuntimeConfig()
  const chosen = saved.getSetting(BEACONDB_SETTING) !== 'off'
  let reason: string | null = null
  if (String(c.placesExternal) === 'false') reason = 'External lookups are off on this server (NUXT_PLACES_EXTERNAL=false).'
  else if (String(c.placesBeacondb) === 'false') reason = 'beaconDB is turned off on this server (NUXT_PLACES_BEACONDB=false).'
  return { chosen, allowed: reason == null, enabled: chosen && reason == null, reason }
}

let beacon: BeaconDb | null = null

export function getBeaconDb(): BeaconDb {
  if (!beacon) {
    const resolver = getPlaceResolver()
    beacon = new BeaconDb(resolver.store, { enabled: () => beaconDbStatus(resolver.saved).enabled })
  }
  return beacon
}

// ---------- "networks seen here" ----------

export interface NetworkCandidate {
  bssid: string
  attached: boolean
  // From the learned access-point map: the AP sits inside the place's circle.
  learned: { observations: number; dist_m: number; spread_m: number | null; last_seen: string | null } | null
  // Heard in unfixed scans as trips left from or arrived at the place.
  at_trip_ends: { sightings: number; boots: number; last_seen: string | null } | null
  max_rssi_dbm: number | null
  last_seen: string | null
}

const BOOT_RE = /^[0-9a-f]{32}$/
const M_PER_DEG_LAT = 110540

export interface EndpointVisit { boot_id: string; kind: string; key_ms: number; lat: number; lon: number; at: string | null }

// The boot-clock windows to look in: before each departure from the place, after each
// arrival at it. The newest `limit` visits.
export function endpointWindows(place: Pick<SavedPlace, 'lat' | 'lon' | 'radius_m'>, visits: EndpointVisit[], limit = 100): Array<{ boot_id: string; lo_ms: number; hi_ms: number }> {
  return visits
    .filter(v => (v.kind === 'departure' || v.kind === 'arrival') && BOOT_RE.test(v.boot_id) && Number.isFinite(v.key_ms))
    .filter(v => distM(place.lat, place.lon, v.lat, v.lon) <= place.radius_m)
    .sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')))
    .slice(0, limit)
    .map(v => v.kind === 'departure'
      ? { boot_id: v.boot_id, lo_ms: Math.max(0, Math.round(v.key_ms - ENDPOINT_WINDOW_MS)), hi_ms: Math.round(v.key_ms) }
      : { boot_id: v.boot_id, lo_ms: Math.round(v.key_ms), hi_ms: Math.round(v.key_ms + ENDPOINT_WINDOW_MS) })
}

export function learnedNearSql(place: Pick<SavedPlace, 'lat' | 'lon' | 'radius_m'>): string {
  const dLat = place.radius_m / M_PER_DEG_LAT
  const dLon = place.radius_m / (111320 * Math.max(0.01, Math.cos(place.lat * Math.PI / 180)))
  const f = (n: number) => n.toFixed(6)
  return `
    SELECT bssid, lat, lon, observations, spread_m, max_rssi_dbm, last_seen
    FROM v_wifi_ap_learned
    WHERE lat BETWEEN ${f(place.lat - dLat)} AND ${f(place.lat + dLat)}
      AND lon BETWEEN ${f(place.lon - dLon)} AND ${f(place.lon + dLon)}
    ORDER BY observations DESC
    LIMIT 500
  `
}

export function endpointObsSql(windows: Array<{ boot_id: string; lo_ms: number; hi_ms: number }>): string | null {
  const safe = windows.filter(w => BOOT_RE.test(w.boot_id))
  if (!safe.length) return null
  const values = safe.map(w => `('${w.boot_id}', ${Math.trunc(w.lo_ms)}, ${Math.trunc(w.hi_ms)})`).join(', ')
  return `
    WITH w AS (SELECT * FROM (VALUES ${values}) t(boot_id, lo_ms, hi_ms))
    SELECT o.bssid, count(*) AS sightings, count(DISTINCT o.boot_id) AS boots,
           max(o.rssi_dbm) AS max_rssi_dbm, max(o.observed_at) AS last_seen
    FROM wifi_ap_obs o
    JOIN w ON o.boot_id = w.boot_id AND o.mono_ms BETWEEN w.lo_ms AND w.hi_ms
    JOIN v_wifi_scan_unfixed u ON u.vehicle_id = o.vehicle_id AND u.boot_id = o.boot_id AND u.seq = o.seq
    GROUP BY o.bssid
    ORDER BY sightings DESC
    LIMIT 200
  `
}

const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : (a > b ? a : b))

// Merges the two sources into one list, the attached ones first. Addresses that cannot
// mark a place (hotspots, randomised MACs) are left out.
export function mergeCandidates(place: Pick<SavedPlace, 'lat' | 'lon' | 'radius_m' | 'bssids'>, learned: Record<string, any>[], ends: Record<string, any>[]): NetworkCandidate[] {
  const by = new Map<string, NetworkCandidate>()
  const get = (b: string) => {
    let c = by.get(b)
    if (!c) { c = { bssid: b, attached: place.bssids.includes(b), learned: null, at_trip_ends: null, max_rssi_dbm: null, last_seen: null }; by.set(b, c) }
    return c
  }
  const rssi = (c: NetworkCandidate, v: unknown) => { if (finite(v) && (c.max_rssi_dbm == null || Number(v) > c.max_rssi_dbm)) c.max_rssi_dbm = Number(v) }

  for (const r of learned) {
    const b = normalizeBssid(r.bssid)
    if (!isUsableBssid(b) || !finite(r.lat) || !finite(r.lon)) continue
    const d = distM(place.lat, place.lon, Number(r.lat), Number(r.lon))
    if (d > place.radius_m) continue
    const c = get(b)
    c.learned = { observations: Number(r.observations ?? 0), dist_m: Math.round(d), spread_m: finite(r.spread_m) ? Math.round(Number(r.spread_m)) : null, last_seen: r.last_seen ?? null }
    rssi(c, r.max_rssi_dbm)
    c.last_seen = later(c.last_seen, r.last_seen ?? null)
  }
  for (const r of ends) {
    const b = normalizeBssid(r.bssid)
    if (!isUsableBssid(b)) continue
    const c = get(b)
    c.at_trip_ends = { sightings: Number(r.sightings ?? 0), boots: Number(r.boots ?? 0), last_seen: r.last_seen ?? null }
    rssi(c, r.max_rssi_dbm)
    c.last_seen = later(c.last_seen, r.last_seen ?? null)
  }
  for (const b of place.bssids) get(b)

  const weight = (c: NetworkCandidate) => (c.learned?.observations ?? 0) + (c.at_trip_ends?.sightings ?? 0)
  return [...by.values()].sort((a, b) => Number(b.attached) - Number(a.attached) || weight(b) - weight(a) || (a.bssid < b.bssid ? -1 : 1))
}

// The Wi-Fi block of the Places page: whether beaconDB is on, what has been cached, and
// the attribution it needs.
export function wifiSettingsForApi() {
  const r = getPlaceResolver()
  return {
    beacondb: beaconDbStatus(r.saved),
    lookups: r.store.wifiLookupCount('beacondb'),
    attribution: [BEACONDB_ATTRIBUTION],
  }
}
