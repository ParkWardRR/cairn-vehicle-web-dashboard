import { describe, expect, it } from 'vitest'
import { combineGps, compareGps, dropGpsJumps, pairGpsFixes, gpsPercentile, gpsSigma, splitGpsSources, GPS_SOURCE_PHONE, type GpsPositionRow } from '../shared/utils/gpsSources'

const LAT0 = 34.0
const LON0 = -118.4
const M_PER_DEG_LAT = 110540
const mPerDegLon = (lat: number) => Math.cos(lat * Math.PI / 180) * 111320

// A car driving north at 15 m/s; `ms` is mono time. Offsets are metres east/north of the true path.
function fix(ms: number, o: Partial<GpsPositionRow> & { east?: number; north?: number; phone?: boolean } = {}): GpsPositionRow {
  const trueNorth = (ms / 1000) * 15
  return {
    lat: LAT0 + (trueNorth + (o.north ?? 0)) / M_PER_DEG_LAT,
    lon: LON0 + (o.east ?? 0) / mPerDegLon(LAT0),
    speed_mps: 15,
    mono_ms: ms,
    hdop: 1,
    sats_used: 9,
    source_flags: o.phone ? GPS_SOURCE_PHONE : 1,
    ...o,
  }
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i)
// device at 1 Hz on the second, phone at 1 Hz half a second later
const device = (n: number, o: Parameters<typeof fix>[1] = {}) => range(n).map(i => fix(i * 1000, o))
const phone = (n: number, o: Parameters<typeof fix>[1] = {}) => range(n).map(i => fix(i * 1000 + 500, { phone: true, h_acc_m: 5, hdop: null, ...o }))

describe('splitGpsSources', () => {
  it('separates the phone by source_flags bit 5 and drops rows with no fix', () => {
    const rows = [fix(0), fix(1000, { phone: true }), fix(2000, { lat: 0, lon: 0 }), fix(3000, { source_flags: 0x21 })]
    const { device: d, phone: p } = splitGpsSources(rows)
    expect(d.map(r => r.mono_ms)).toEqual([0])
    expect(p.map(r => r.mono_ms)).toEqual([1000, 3000])
  })

  it('treats a missing source_flags as the device', () => {
    expect(splitGpsSources([fix(0, { source_flags: null })]).device).toHaveLength(1)
  })
})

describe('gpsSigma', () => {
  it('prefers the reported accuracy, then HDOP, then a guess', () => {
    expect(gpsSigma({ ...fix(0), h_acc_m: 6, hdop: 1 })).toEqual({ sigma: 6, basis: 'reported' })
    expect(gpsSigma({ ...fix(0), h_acc_m: null, hdop: 1.5 })).toEqual({ sigma: 6, basis: 'hdop' })
    expect(gpsSigma({ ...fix(0), h_acc_m: null, hdop: null })).toEqual({ sigma: 10, basis: 'assumed' })
  })
})

describe('dropGpsJumps', () => {
  it('removes a fix that implies faster than a car can drive', () => {
    const rows = [fix(0), fix(1000), fix(2000, { north: 5000 }), fix(3000)]
    expect(dropGpsJumps(rows).map(r => r.mono_ms)).toEqual([0, 1000, 3000])
  })
})

describe('combineGps', () => {
  it('uses one source where only that source has a fix', () => {
    const out = combineGps(device(5), [])
    expect(out).toHaveLength(5)
    expect(out.every(p => p.source === 'device')).toBe(true)
    const solo = combineGps([], phone(5))
    expect(solo.every(p => p.source === 'phone')).toBe(true)
  })

  it('averages the two toward the more accurate one', () => {
    // same second; the device says 10 m east with a 4 m sigma, the phone 0 m east with a 2 m sigma
    const d = [fix(1000, { east: 10, hdop: null, h_acc_m: 4 })]
    const p = [fix(1400, { east: 0, phone: true, h_acc_m: 2 })]
    const [pt] = combineGps(d, p)
    expect(pt.source).toBe('both')
    const east = (pt.lon - LON0) * mPerDegLon(LAT0)
    // weights 1/16 and 1/4: the weighted east is 10 * 0.2 = 2 m
    expect(east).toBeGreaterThan(1.5)
    expect(east).toBeLessThan(2.6)
    expect(pt.sigma_m).toBeLessThan(2) // fusing two fixes is tighter than either alone
  })

  it('does not let one wild fix drag the line', () => {
    const d = device(6)
    const p = phone(6)
    p[3] = { ...p[3], north: 8000 } as GpsPositionRow
    p[3] = fix(3500, { phone: true, h_acc_m: 5, north: 8000 })
    const out = combineGps(d, p)
    expect(Math.max(...out.map(pt => (pt.lat - LAT0) * M_PER_DEG_LAT))).toBeLessThan(15 * 6)
  })

  it('is ordered in time and has one point per second', () => {
    const out = combineGps(device(10), phone(10))
    expect(out).toHaveLength(10)
    expect(out.every((p, i) => i === 0 || p.mono_ms > out[i - 1].mono_ms)).toBe(true)
  })
})

describe('pairGpsFixes', () => {
  it('interpolates the phone to the device instant, so a timing offset does not read as error', () => {
    // identical true path, phone fixes half a second late: pairs must come out ~0 m apart
    const pairs = pairGpsFixes(device(20), phone(20))
    expect(pairs.length).toBeGreaterThan(15)
    expect(Math.max(...pairs.map(p => p.sep_m))).toBeLessThan(0.5)
  })

  it('measures a constant 6 m east offset and reports its direction', () => {
    const pairs = pairGpsFixes(device(20), phone(20, { east: 6 }))
    const east = pairs.reduce((a, p) => a + p.east_m, 0) / pairs.length
    expect(east).toBeCloseTo(6, 0)
    expect(pairs.every(p => Math.abs(p.north_m) < 0.5)).toBe(true)
  })

  it('does not pair across a long phone silence', () => {
    const p = [...phone(5), ...phone(5).map(r => ({ ...r, mono_ms: r.mono_ms + 20000 }))]
    const pairs = pairGpsFixes(device(30), p)
    expect(pairs.some(x => x.t > 6000 && x.t < 19000)).toBe(false)
  })
})

describe('compareGps', () => {
  const obd = range(30).map(i => ({ mono_ms: i * 1000, speed_kph: 54 })) // 15 m/s

  it('reports each source against OBD speed and distance', () => {
    const rows = [...device(30, { speed_mps: 15.0 }), ...phone(30, { speed_mps: 15.8 })]
    const c = compareGps(rows, obd)
    expect(c.device!.speed_rms_kph).toBeLessThan(0.2)
    expect(c.phone!.speed_bias_kph).toBeCloseTo(2.9, 0) // +0.8 m/s = 2.9 kph
    expect(c.phone!.speed_within_2kph_pct).toBe(0)
    expect(c.device!.speed_within_2kph_pct).toBe(100)
    // 29 s of driving at 15 m/s
    expect(c.obd_distance_m).toBeGreaterThan(425)
    expect(Math.abs(c.device!.distance_error_pct!)).toBeLessThan(2)
  })

  it('says nothing about speed accuracy while the car is standing', () => {
    const still = range(20).map(i => ({ mono_ms: i * 1000, speed_kph: 0 }))
    const c = compareGps(device(20, { speed_mps: 0.4 }), still)
    expect(c.device!.speed_samples).toBe(0)
    expect(c.device!.speed_rms_kph).toBeNull()
  })

  it('compares the sources where both are present', () => {
    const c = compareGps([...device(30), ...phone(30, { east: 3, north: 4 })], obd)
    expect(c.pairs.count).toBeGreaterThan(25)
    expect(c.pairs.median_m).toBeCloseTo(5, 0)
    expect(c.pairs.within_5m_pct).toBeGreaterThan(40)
    expect(c.pairs.within_10m_pct).toBe(100)
    expect(c.pairs.bias_east_m).toBeCloseTo(3, 0)
    expect(c.pairs.bias_north_m).toBeCloseTo(4, 0)
    expect(c.pairs.series.length).toBeGreaterThan(0)
    expect(c.combined.from_both).toBeGreaterThan(25)
  })

  it('has no comparison, and no phone figures, when only the device recorded', () => {
    const c = compareGps(device(30), obd)
    expect(c.phone).toBeNull()
    expect(c.pairs.count).toBe(0)
    expect(c.pairs.median_m).toBeNull()
    expect(c.device!.fixes).toBe(30)
    expect(c.combined.from_device).toBe(30)
  })

  it('is empty, not an error, with no positions at all', () => {
    const c = compareGps([], [])
    expect(c.device).toBeNull()
    expect(c.phone).toBeNull()
    expect(c.span_s).toBe(0)
  })

  it('counts a silence as a gap and lowers coverage', () => {
    const rows = [...device(10), ...device(10).map(r => ({ ...r, mono_ms: r.mono_ms + 30000 }))]
    const c = compareGps(rows)
    expect(c.device!.gaps).toBe(1)
    expect(c.device!.longest_gap_s).toBe(21)
    expect(c.device!.coverage_pct).toBeLessThan(75)
  })

  it('labels accuracy by where it came from', () => {
    const c = compareGps([...device(10), ...phone(10)])
    expect(c.device!.accuracy_basis).toBe('hdop')
    expect(c.device!.accuracy_median_m).toBe(4)
    expect(c.phone!.accuracy_basis).toBe('reported')
    expect(c.phone!.accuracy_median_m).toBe(5)
  })

  it('caps the chart series', () => {
    const c = compareGps([...device(2000), ...phone(2000)])
    expect(c.pairs.series.length).toBeLessThanOrEqual(240)
  })
})

describe('gpsPercentile', () => {
  it('interpolates and ignores non-numbers', () => {
    expect(gpsPercentile([1, 2, 3, 4], 0.5)).toBe(2.5)
    expect(gpsPercentile([], 0.5)).toBeNull()
    expect(gpsPercentile([NaN, 5], 0.5)).toBe(5)
  })
})
