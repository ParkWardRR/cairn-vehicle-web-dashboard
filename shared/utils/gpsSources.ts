// A trip can hold two GPS tracks: the dongle's own receiver, and the phone's, which the app
// streams to the dongle over BLE. The store tells them apart by bit 5 of `source_flags`
// (contracts: format v3, "external source (phone)"). This file splits them, fuses them into one
// combined track, and measures how they differ. No I/O: the routes feed it rows.

export const GPS_SOURCE_PHONE = 0x20

export interface GpsPositionRow {
  lat: number
  lon: number
  alt_m?: number | null
  speed_mps?: number | null
  heading_deg?: number | null
  h_acc_m?: number | null
  hdop?: number | null
  sats_used?: number | null
  fix_type?: number | null
  mono_ms: number
  observed_at?: string | null
  source_flags?: number | null
}

export interface GpsSpeedRow { mono_ms: number; speed_kph: number | null }

export type GpsTrackSource = 'device' | 'phone' | 'both'

/** A point of the combined track, and where it came from. */
export interface GpsCombinedPoint extends GpsPositionRow {
  source: GpsTrackSource
  /** metres, the 1-sigma the fusion weighted this point by */
  sigma_m: number
}

// A GNSS receiver's typical user-equivalent range error: horizontal error ~ HDOP x this.
const UERE_M = 4
// What to assume for a fix that reports neither an accuracy nor an HDOP.
const UNKNOWN_SIGMA_M = 10
const MIN_SIGMA_M = 1
const MAX_IMPLIED_MPS = 56 // ~200 kph; anything faster between two fixes is a bad fix
/** Two fixes of different sources are the same moment if they are this close in time. */
const PAIR_WINDOW_MS = 2500
const BIN_MS = 1000
const GAP_MS = 5000

export const isPhoneFix = (r: GpsPositionRow) => ((r.source_flags ?? 0) & GPS_SOURCE_PHONE) !== 0
const hasFix = (r: GpsPositionRow) => r.lat !== 0 && r.lon !== 0 && Number.isFinite(r.lat) && Number.isFinite(r.lon)

export function splitGpsSources(rows: GpsPositionRow[]): { device: GpsPositionRow[]; phone: GpsPositionRow[] } {
  const device: GpsPositionRow[] = []
  const phone: GpsPositionRow[] = []
  for (const r of rows) {
    if (!hasFix(r)) continue
    ;(isPhoneFix(r) ? phone : device).push(r)
  }
  const byTime = (a: GpsPositionRow, b: GpsPositionRow) => a.mono_ms - b.mono_ms
  return { device: device.sort(byTime), phone: phone.sort(byTime) }
}

/** The horizontal 1-sigma of a fix in metres: what it reports, else HDOP x UERE, else a guess. */
export function gpsSigma(r: GpsPositionRow): { sigma: number; basis: 'reported' | 'hdop' | 'assumed' } {
  if (r.h_acc_m != null && r.h_acc_m > 0) return { sigma: Math.max(MIN_SIGMA_M, r.h_acc_m), basis: 'reported' }
  if (r.hdop != null && r.hdop > 0) return { sigma: Math.max(MIN_SIGMA_M, r.hdop * UERE_M), basis: 'hdop' }
  return { sigma: UNKNOWN_SIGMA_M, basis: 'assumed' }
}

// ── geometry ────────────────────────────────────────────────────────────────

const M_PER_DEG_LAT = 110540
const mPerDegLon = (lat: number) => Math.cos(lat * Math.PI / 180) * 111320

export function gpsDistM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dx = (b.lon - a.lon) * mPerDegLon(a.lat)
  const dy = (b.lat - a.lat) * M_PER_DEG_LAT
  return Math.hypot(dx, dy)
}

/** Drops fixes that imply driving faster than a car can (a source's own multipath jumps). */
export function dropGpsJumps<T extends GpsPositionRow>(rows: T[]): T[] {
  const keep: T[] = []
  for (const r of rows) {
    const prev = keep[keep.length - 1]
    if (prev) {
      const dt = (r.mono_ms - prev.mono_ms) / 1000
      if (dt <= 0) continue
      if (gpsDistM(prev, r) / dt > MAX_IMPLIED_MPS) continue
    }
    keep.push(r)
  }
  return keep
}

export function gpsPathLengthM(rows: GpsPositionRow[]): number {
  let total = 0
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].mono_ms - rows[i - 1].mono_ms > GAP_MS * 6) continue // not measured across a long silence
    total += gpsDistM(rows[i - 1], rows[i])
  }
  return total
}

// ── statistics helpers ──────────────────────────────────────────────────────

export function gpsPercentile(values: number[], p: number): number | null {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!v.length) return null
  const i = (v.length - 1) * p
  const lo = Math.floor(i), hi = Math.ceil(i)
  return v[lo] + (v[hi] - v[lo]) * (i - lo)
}
const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null)
const rms = (v: number[]) => (v.length ? Math.sqrt(v.reduce((a, b) => a + b * b, 0) / v.length) : null)
const round = (n: number | null, d = 1) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d)

// ── the combined track ──────────────────────────────────────────────────────

/**
 * One point per second: where both sources have a fix in that second, their positions averaged
 * with weights of 1 / sigma^2 (the better receiver counts for more); where only one has, that
 * source's fix as it is. A source's jumps are dropped first, so one bad fix cannot drag the line.
 */
export function combineGps(deviceRows: GpsPositionRow[], phoneRows: GpsPositionRow[]): GpsCombinedPoint[] {
  const device = dropGpsJumps(deviceRows)
  const phone = dropGpsJumps(phoneRows)
  const bins = new Map<number, { device: GpsPositionRow[]; phone: GpsPositionRow[] }>()
  const put = (rows: GpsPositionRow[], key: 'device' | 'phone') => {
    for (const r of rows) {
      const b = Math.floor(r.mono_ms / BIN_MS)
      const bin = bins.get(b) ?? { device: [], phone: [] }
      bin[key].push(r)
      bins.set(b, bin)
    }
  }
  put(device, 'device')
  put(phone, 'phone')

  const out: GpsCombinedPoint[] = []
  for (const b of [...bins.keys()].sort((x, y) => x - y)) {
    const { device: d, phone: p } = bins.get(b)!
    const members = [...d, ...p]
    const weights = members.map(r => 1 / gpsSigma(r).sigma ** 2)
    const wsum = weights.reduce((a, c) => a + c, 0)
    const wavg = (pick: (r: GpsPositionRow) => number | null | undefined) => {
      let num = 0, den = 0
      members.forEach((r, i) => {
        const v = pick(r)
        if (v != null && Number.isFinite(v)) { num += v * weights[i]; den += weights[i] }
      })
      return den > 0 ? num / den : null
    }
    // the most trusted member supplies what cannot be averaged
    const best = members[weights.indexOf(Math.max(...weights))]
    out.push({
      lat: wavg(r => r.lat)!,
      lon: wavg(r => r.lon)!,
      alt_m: wavg(r => r.alt_m),
      speed_mps: wavg(r => r.speed_mps),
      heading_deg: best.heading_deg ?? null,
      h_acc_m: Math.sqrt(1 / wsum),
      sats_used: d.length ? (d[d.length - 1].sats_used ?? null) : null,
      mono_ms: Math.round(members.reduce((a, r) => a + r.mono_ms, 0) / members.length),
      observed_at: best.observed_at ?? null,
      source: d.length && p.length ? 'both' : d.length ? 'device' : 'phone',
      sigma_m: Math.sqrt(1 / wsum),
    })
  }
  return out
}

// ── comparing the two ───────────────────────────────────────────────────────

export interface GpsSourceStats {
  fixes: number
  rate_hz: number | null
  /** share of the trip's time with a fix no more than GAP_MS old */
  coverage_pct: number | null
  gaps: number
  longest_gap_s: number | null
  accuracy_median_m: number | null
  accuracy_p95_m: number | null
  /** where the accuracy figure comes from: the receiver's own claim, derived from HDOP, or a guess */
  accuracy_basis: 'reported' | 'hdop' | 'assumed' | null
  sats_median: number | null
  distance_m: number
  /** against the distance the OBD speed adds up to; null with no OBD speed */
  distance_error_pct: number | null
  max_speed_kph: number | null
  /** against the OBD speed while moving: how far this source's speed is from the car's own */
  speed_bias_kph: number | null
  speed_rms_kph: number | null
  speed_within_2kph_pct: number | null
  speed_samples: number
}

export interface GpsComparison {
  span_s: number
  obd_distance_m: number | null
  device: GpsSourceStats | null
  phone: GpsSourceStats | null
  pairs: {
    count: number
    /** half the time gap between two fixes pairs are made across, in ms */
    median_time_gap_ms: number | null
    median_m: number | null
    mean_m: number | null
    p95_m: number | null
    max_m: number | null
    within_5m_pct: number | null
    within_10m_pct: number | null
    /** mean offset of the phone from the device: positive east / north, metres */
    bias_east_m: number | null
    bias_north_m: number | null
    speed_delta_mean_kph: number | null
    speed_delta_abs_mean_kph: number | null
    series: Array<{ mono_ms: number; sep_m: number; speed_delta_kph: number | null }>
  }
  combined: { points: number; from_device: number; from_phone: number; from_both: number }
}

const SERIES_LIMIT = 240

/** Speed in kph at `t` from OBD, interpolated; null if the OBD samples around t are too far apart. */
function obdSpeedAt(obd: Array<{ mono_ms: number; kph: number }>, t: number, cursor: { i: number }): number | null {
  while (cursor.i + 1 < obd.length && obd[cursor.i + 1].mono_ms <= t) cursor.i++
  const a = obd[cursor.i]
  if (!a) return null
  const b = obd[cursor.i + 1]
  if (a.mono_ms > t) return null
  if (!b || b.mono_ms === a.mono_ms) return t - a.mono_ms <= 1500 ? a.kph : null
  if (b.mono_ms - a.mono_ms > 3000) return null
  const f = (t - a.mono_ms) / (b.mono_ms - a.mono_ms)
  return a.kph + (b.kph - a.kph) * f
}

function obdDistance(obd: Array<{ mono_ms: number; kph: number }>): number | null {
  if (obd.length < 2) return null
  let m = 0
  for (let i = 1; i < obd.length; i++) {
    const dt = (obd[i].mono_ms - obd[i - 1].mono_ms) / 1000
    if (dt <= 0 || dt > 10) continue
    m += ((obd[i].kph + obd[i - 1].kph) / 2 / 3.6) * dt
  }
  return m > 0 ? m : null
}

function sourceStats(rows: GpsPositionRow[], spanStart: number, spanEnd: number, obd: Array<{ mono_ms: number; kph: number }>, obdDist: number | null): GpsSourceStats | null {
  if (!rows.length) return null
  const clean = dropGpsJumps(rows)

  const gaps: number[] = []
  let covered = 0
  for (let i = 1; i < clean.length; i++) {
    const dt = clean[i].mono_ms - clean[i - 1].mono_ms
    if (dt > GAP_MS) gaps.push(dt)
    covered += Math.min(dt, GAP_MS)
  }
  const span = Math.max(1, spanEnd - spanStart)
  const intervals = clean.slice(1).map((r, i) => r.mono_ms - clean[i].mono_ms).filter(d => d > 0 && d <= GAP_MS)
  const medInterval = gpsPercentile(intervals, 0.5)

  const sig = clean.map(gpsSigma)
  const basis = sig.some(s => s.basis === 'reported') ? 'reported' : sig.some(s => s.basis === 'hdop') ? 'hdop' : 'assumed'
  const sigmas = sig.filter(s => s.basis === basis).map(s => s.sigma)

  const cursor = { i: 0 }
  const errs: number[] = []
  for (const r of clean) {
    if (r.speed_mps == null) continue
    const o = obdSpeedAt(obd, r.mono_ms, cursor)
    if (o == null || o < 5) continue // a standing car makes any receiver look fine
    errs.push(r.speed_mps * 3.6 - o)
  }

  const dist = gpsPathLengthM(clean)
  const speeds = clean.map(r => r.speed_mps).filter((s): s is number => s != null)
  return {
    fixes: clean.length,
    rate_hz: medInterval ? round(1000 / medInterval, 2) : null,
    coverage_pct: round((covered / span) * 100, 0),
    gaps: gaps.length,
    longest_gap_s: gaps.length ? round(Math.max(...gaps) / 1000, 1) : null,
    accuracy_median_m: round(gpsPercentile(sigmas, 0.5)),
    accuracy_p95_m: round(gpsPercentile(sigmas, 0.95)),
    accuracy_basis: basis,
    sats_median: round(gpsPercentile(clean.map(r => r.sats_used).filter((s): s is number => s != null && s > 0), 0.5), 0),
    distance_m: Math.round(dist),
    distance_error_pct: obdDist ? round(((dist - obdDist) / obdDist) * 100) : null,
    max_speed_kph: speeds.length ? round(Math.max(...speeds) * 3.6, 0) : null,
    speed_bias_kph: round(mean(errs)),
    speed_rms_kph: round(rms(errs)),
    speed_within_2kph_pct: errs.length ? round((errs.filter(e => Math.abs(e) <= 2).length / errs.length) * 100, 0) : null,
    speed_samples: errs.length,
  }
}

/**
 * Each device fix is compared with the phone's position at the same instant, interpolated between
 * the two phone fixes around it: the phone's timestamp reaches the dongle a little late, and at
 * driving speed an unaligned pair would measure that delay as if it were GPS error.
 */
export function pairGpsFixes(device: GpsPositionRow[], phone: GpsPositionRow[]) {
  const out: Array<{ t: number; sep_m: number; east_m: number; north_m: number; speed_delta_kph: number | null; gap_ms: number }> = []
  let j = 0
  for (const d of device) {
    while (j + 1 < phone.length && phone[j + 1].mono_ms <= d.mono_ms) j++
    const a = phone[j]
    if (!a) continue
    const b = phone[j + 1]
    let lat: number, lon: number, speed: number | null
    let gap: number
    if (a.mono_ms <= d.mono_ms && b && b.mono_ms > d.mono_ms && b.mono_ms - a.mono_ms <= PAIR_WINDOW_MS) {
      const f = (d.mono_ms - a.mono_ms) / (b.mono_ms - a.mono_ms)
      lat = a.lat + (b.lat - a.lat) * f
      lon = a.lon + (b.lon - a.lon) * f
      speed = a.speed_mps != null && b.speed_mps != null ? a.speed_mps + (b.speed_mps - a.speed_mps) * f : null
      gap = Math.min(d.mono_ms - a.mono_ms, b.mono_ms - d.mono_ms)
    } else {
      const near = b && Math.abs(b.mono_ms - d.mono_ms) < Math.abs(a.mono_ms - d.mono_ms) ? b : a
      gap = Math.abs(near.mono_ms - d.mono_ms)
      if (gap > 100) continue // unbracketed: only an effectively simultaneous fix is comparable
      lat = near.lat; lon = near.lon; speed = near.speed_mps ?? null
    }
    const east = (lon - d.lon) * mPerDegLon(d.lat)
    const north = (lat - d.lat) * M_PER_DEG_LAT
    out.push({
      t: d.mono_ms,
      sep_m: Math.hypot(east, north),
      east_m: east,
      north_m: north,
      speed_delta_kph: speed != null && d.speed_mps != null ? (speed - d.speed_mps) * 3.6 : null,
      gap_ms: gap,
    })
  }
  return out
}

export function compareGps(rows: GpsPositionRow[], obdRows: GpsSpeedRow[] = []): GpsComparison {
  const { device, phone } = splitGpsSources(rows)
  const obd = obdRows.filter((o): o is { mono_ms: number; speed_kph: number } => o.speed_kph != null)
    .map(o => ({ mono_ms: o.mono_ms, kph: o.speed_kph }))
    .sort((a, b) => a.mono_ms - b.mono_ms)
  const all = [...device, ...phone]
  const spanStart = all.length ? Math.min(...all.map(r => r.mono_ms)) : 0
  const spanEnd = all.length ? Math.max(...all.map(r => r.mono_ms)) : 0
  const obdDist = obdDistance(obd)

  const devClean = dropGpsJumps(device), phClean = dropGpsJumps(phone)
  const pairs = pairGpsFixes(devClean, phClean)
  const seps = pairs.map(p => p.sep_m)
  const sd = pairs.map(p => p.speed_delta_kph).filter((v): v is number => v != null)
  const stride = Math.max(1, Math.ceil(pairs.length / SERIES_LIMIT))
  const combined = combineGps(device, phone)

  return {
    span_s: Math.round((spanEnd - spanStart) / 1000),
    obd_distance_m: obdDist ? Math.round(obdDist) : null,
    device: sourceStats(device, spanStart, spanEnd, obd, obdDist),
    phone: sourceStats(phone, spanStart, spanEnd, obd, obdDist),
    pairs: {
      count: pairs.length,
      median_time_gap_ms: round(gpsPercentile(pairs.map(p => p.gap_ms), 0.5), 0),
      median_m: round(gpsPercentile(seps, 0.5)),
      mean_m: round(mean(seps)),
      p95_m: round(gpsPercentile(seps, 0.95)),
      max_m: seps.length ? round(Math.max(...seps)) : null,
      within_5m_pct: seps.length ? round((seps.filter(s => s <= 5).length / seps.length) * 100, 0) : null,
      within_10m_pct: seps.length ? round((seps.filter(s => s <= 10).length / seps.length) * 100, 0) : null,
      bias_east_m: round(mean(pairs.map(p => p.east_m))),
      bias_north_m: round(mean(pairs.map(p => p.north_m))),
      speed_delta_mean_kph: round(mean(sd)),
      speed_delta_abs_mean_kph: round(mean(sd.map(Math.abs))),
      series: pairs.filter((_, i) => i % stride === 0).map(p => ({
        mono_ms: p.t, sep_m: round(p.sep_m)!, speed_delta_kph: round(p.speed_delta_kph),
      })),
    },
    combined: {
      points: combined.length,
      from_device: combined.filter(p => p.source === 'device').length,
      from_phone: combined.filter(p => p.source === 'phone').length,
      from_both: combined.filter(p => p.source === 'both').length,
    },
  }
}
