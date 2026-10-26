import type { PlaceStore } from './placeStore'
import { isUsableBssid, normalizeBssid } from '../../shared/utils/bssid'
import { USER_AGENT } from './placeSources'

// beaconDB (https://beacondb.net/): a public-domain Wi-Fi geolocation database with an
// MLS/Ichnaea-compatible API. Asked for where a set of access points is when the car's
// own learned map and the saved places do not know them.
//
// What is sent: the BSSIDs and signal strengths of one scan, and nothing else — no
// network names (there are none), no position, no time, no device id. considerIp is
// false and both fallbacks are off, so the answer never comes from this server's IP
// address. Nothing is ever submitted to beaconDB (no geosubmit).
//
// Every answer, "not found" included, is cached by the scan's sorted BSSID set, so the
// same set is never sent twice. Lookups never block a request: a miss is queued, sent at
// most once a second, and the page asks again (the same pattern as placeResolver.ts).

export const BEACONDB_URL = 'https://api.beacondb.net/v1/geolocate'
// The API's own privacy rule: at least two access points, or no answer.
export const BEACONDB_MIN_APS = 2
// The strongest this many of a scan are sent; more adds nothing to the fix.
export const BEACONDB_MAX_APS = 20
export const BEACONDB_SPACING_MS = 1000
export const BEACONDB_DAILY_BUDGET = 1000
export const BEACONDB_RETRY_MS = 10 * 60 * 1000
export const BEACONDB_ATTRIBUTION = 'Wi-Fi positions: beaconDB'
const SOURCE = 'beacondb'

export interface ScanAp {
  bssid: string
  rssi_dbm: number | null
}

export interface BeaconRequest {
  considerIp: false
  fallbacks: { lacf: false; ipf: false }
  wifiAccessPoints: Array<{ macAddress: string; signalStrength?: number }>
}

// The usable access points of a scan, one per BSSID (its strongest reading), strongest
// first. Locally administered addresses (hotspots, randomised MACs) are dropped: they
// move with their owner.
export function usableAps(aps: ScanAp[]): ScanAp[] {
  const best = new Map<string, number | null>()
  for (const a of aps) {
    const b = normalizeBssid(a.bssid)
    if (!isUsableBssid(b)) continue
    const v = a.rssi_dbm == null || !Number.isFinite(Number(a.rssi_dbm)) ? null : Math.round(Number(a.rssi_dbm))
    const prev = best.get(b)
    best.set(b, prev == null ? v : v == null ? prev : Math.max(prev, v))
  }
  return [...best]
    .map(([bssid, rssi_dbm]) => ({ bssid, rssi_dbm }))
    .sort((x, y) => (y.rssi_dbm ?? -999) - (x.rssi_dbm ?? -999) || (x.bssid < y.bssid ? -1 : 1))
}

// The cache key: the scan's sorted, de-duplicated BSSIDs. Null when there are too few
// to ask about.
export function beaconKey(aps: ScanAp[]): string | null {
  const list = usableAps(aps).map(a => a.bssid).sort()
  return list.length >= BEACONDB_MIN_APS ? list.join(',') : null
}

export function beaconRequestBody(aps: ScanAp[]): BeaconRequest | null {
  const list = usableAps(aps).slice(0, BEACONDB_MAX_APS)
  if (list.length < BEACONDB_MIN_APS) return null
  return {
    considerIp: false,
    fallbacks: { lacf: false, ipf: false },
    wifiAccessPoints: list.map(a => (a.rssi_dbm == null
      ? { macAddress: a.bssid }
      : { macAddress: a.bssid, signalStrength: a.rssi_dbm })),
  }
}

export type BeaconAnswer =
  | { kind: 'found'; lat: number; lon: number; accuracy_m: number | null }
  | { kind: 'none' }
  | { kind: 'error'; retry_ms: number; message: string }

// Reads one HTTP answer. 404 is the API's "no location could be estimated", a real
// answer and cached as such. A located answer that came from a fallback (which this
// client turns off) is not a Wi-Fi position, so it counts as none.
export function parseBeaconAnswer(status: number, json: any): BeaconAnswer {
  if (status === 404) return { kind: 'none' }
  if (status === 429) return { kind: 'error', retry_ms: 60_000, message: 'rate limited' }
  if (status < 200 || status >= 300) return { kind: 'error', retry_ms: BEACONDB_RETRY_MS, message: `HTTP ${status}` }
  const lat = Number(json?.location?.lat)
  const lon = Number(json?.location?.lng)
  if (json?.fallback) return { kind: 'none' }
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return { kind: 'error', retry_ms: BEACONDB_RETRY_MS, message: 'malformed answer' }
  }
  const acc = Number(json?.accuracy)
  return { kind: 'found', lat, lon, accuracy_m: Number.isFinite(acc) && acc > 0 ? acc : null }
}

export type BeaconLookup =
  | { status: 'found'; lat: number; lon: number; accuracy_m: number | null }
  | { status: 'none' }      // asked; beaconDB does not know these networks
  | { status: 'pending' }   // queued or in flight; ask again shortly
  | { status: 'failed' }    // the last try failed; it is retried later
  | { status: 'too_few' }   // fewer than two usable access points
  | { status: 'off' }       // beaconDB lookups are turned off

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<any> }>

export interface BeaconDbOptions {
  enabled: () => boolean
  fetch?: FetchLike
  url?: string
  userAgent?: string
  spacingMs?: number
  dailyBudget?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

interface Job { key: string; body: BeaconRequest }

export class BeaconDb {
  private queue: Job[] = []
  private queued = new Set<string>()
  private failedUntil = new Map<string, number>()
  private running: Promise<void> | null = null
  private lastSent = 0
  private pauseUntil = 0

  constructor(private store: PlaceStore, private opts: BeaconDbOptions) {}

  enabled(): boolean { return this.opts.enabled() }

  private now() { return (this.opts.now ?? Date.now)() }

  // Non-blocking: what is known now, queuing a lookup on a miss.
  lookup(aps: ScanAp[]): BeaconLookup {
    const key = beaconKey(aps)
    if (!key) return { status: 'too_few' }
    const cached = this.store.wifiLookup(SOURCE, key)
    if (cached) {
      return cached.found && cached.lat != null && cached.lon != null
        ? { status: 'found', lat: cached.lat, lon: cached.lon, accuracy_m: cached.accuracy_m }
        : { status: 'none' }
    }
    if (!this.enabled()) return { status: 'off' }
    if (this.queued.has(key)) return { status: 'pending' }
    if ((this.failedUntil.get(key) ?? 0) > this.now()) return { status: 'failed' }
    const body = beaconRequestBody(aps)
    if (!body) return { status: 'too_few' }
    this.queued.add(key)
    this.queue.push({ key, body })
    void this.drain()
    return { status: 'pending' }
  }

  pendingCount(): number { return this.queue.length }

  // Resolves once the queue is empty (for tests and shutdown).
  idle(): Promise<void> { return this.running ?? Promise.resolve() }

  private drain(): Promise<void> {
    if (!this.running) {
      this.running = this.run().finally(() => { this.running = null })
    }
    return this.running
  }

  private async run() {
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
    const spacing = this.opts.spacingMs ?? BEACONDB_SPACING_MS
    while (this.queue.length) {
      const job = this.queue[0]
      // Turned off while queued: drop what is waiting, send nothing more.
      if (!this.enabled()) {
        for (const j of this.queue) this.queued.delete(j.key)
        this.queue = []
        return
      }
      const day = new Date(this.now()).toISOString().slice(0, 10)
      if (this.store.callsToday(SOURCE, day) >= (this.opts.dailyBudget ?? BEACONDB_DAILY_BUDGET)) {
        for (const j of this.queue) { this.queued.delete(j.key); this.failedUntil.set(j.key, this.now() + BEACONDB_RETRY_MS) }
        this.queue = []
        return
      }
      const wait = Math.max(this.lastSent + spacing, this.pauseUntil) - this.now()
      if (wait > 0) await sleep(wait)

      this.queue.shift()
      this.lastSent = this.now()
      this.store.addCalls(SOURCE, day, 1)
      const answer = await this.send(job.body)
      if (answer.kind === 'error') {
        this.failedUntil.set(job.key, this.now() + answer.retry_ms)
        if (answer.message === 'rate limited') this.pauseUntil = this.now() + answer.retry_ms
        console.error(`[wifi] beaconDB lookup failed: ${answer.message}`)
      } else {
        this.store.saveWifiLookup({
          key: job.key,
          source: SOURCE,
          found: answer.kind === 'found',
          lat: answer.kind === 'found' ? answer.lat : null,
          lon: answer.kind === 'found' ? answer.lon : null,
          accuracy_m: answer.kind === 'found' ? answer.accuracy_m : null,
          fetched_at: this.now(),
        })
        this.failedUntil.delete(job.key)
      }
      this.queued.delete(job.key)
    }
  }

  private async send(body: BeaconRequest): Promise<BeaconAnswer> {
    const f = this.opts.fetch ?? (globalThis.fetch as unknown as FetchLike)
    try {
      const res = await f(this.opts.url ?? BEACONDB_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': this.opts.userAgent ?? USER_AGENT, Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      })
      let json: any = null
      try { json = await res.json() } catch { /* not JSON */ }
      return parseBeaconAnswer(res.status, json)
    } catch (e: any) {
      return { kind: 'error', retry_ms: BEACONDB_RETRY_MS, message: e?.message ?? String(e) }
    }
  }
}
