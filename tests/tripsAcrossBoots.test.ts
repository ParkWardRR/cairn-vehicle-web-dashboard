// @vitest-environment node
//
// A trip is an outing and can span boots; the device's mono_ms restarts at every boot. These build a
// two-boot trip whose second boot's mono_ms starts small again, overlapping the first boot's, and
// check that the trip page's timeline, scrubber, stops and GPS comparison all run on one clock.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { compareGps, combineGps, pairGpsFixes, GPS_SOURCE_PHONE, type GpsPositionRow } from '../shared/utils/gpsSources'
import { tripClock, tripClockKind, wallClockMs } from '../shared/utils/tripClock'
import { gpsHealthSeries, onTripClock, tripFloorIndex, tripNearest, tripPositionAt } from '../shared/utils/tripTimeline'
import { detectStops } from '../server/utils/stops'

const M_PER_DEG_LAT = 110540
const LON0 = -118.4

// Boot 1: 10 minutes from 16:40, driving north at 15 m/s from 34.00.
// Parked 40 minutes. Boot 2: 10 minutes from 17:30, driving north at 25 m/s from where boot 1 ended.
// Both boots' mono_ms run 2 500 .. 602 500: every mono_ms of boot 2 is also one of boot 1.
const BOOT1_AT = Date.parse('2026-10-02T16:40:00Z')
const BOOT2_AT = Date.parse('2026-10-02T17:30:00Z')
const MONO0 = 2500
const SECS = 600
const LAT1 = 34.0
const LAT2 = LAT1 + (SECS - 1) * 15 / M_PER_DEG_LAT

interface Sample { boot: 1 | 2; mono_ms: number; observed_at: string; lat: number; lon: number; speed_mps: number }

function bootSamples(boot: 1 | 2, offsetMs = 0): Sample[] {
  const at0 = boot === 1 ? BOOT1_AT : BOOT2_AT
  const lat0 = boot === 1 ? LAT1 : LAT2
  const v = boot === 1 ? 15 : 25
  return Array.from({ length: SECS }, (_, i) => {
    const mono = MONO0 + i * 1000 + offsetMs
    return {
      boot,
      mono_ms: mono,
      observed_at: new Date(at0 + (mono - MONO0)).toISOString(),
      lat: lat0 + ((i + offsetMs / 1000) * v) / M_PER_DEG_LAT,
      lon: LON0,
      speed_mps: v,
    }
  })
}

const trip = [...bootSamples(1), ...bootSamples(2)]
// What the timeline API sends: t_ms = epoch_ms(observed_at), in observed_at order.
const timelineRows = trip.map(s => ({ ...s, t_ms: Date.parse(s.observed_at), sats_used: s.boot === 1 ? 7 : 11 }))

describe('the trip clock', () => {
  it('is the wall clock when the trip has one, and mono_ms only when none of it does', () => {
    expect(tripClockKind(trip)).toBe('wall')
    expect(tripClock(trip)(trip[SECS])).toBe(BOOT2_AT)
    const undated = trip.map(s => ({ ...s, observed_at: new Date(s.mono_ms).toISOString() })) // no UTC basis: 1970
    expect(tripClockKind(undated)).toBe('mono')
    expect(tripClock(undated)(undated[SECS])).toBe(MONO0)
    expect(wallClockMs('1970-01-01T00:10:00Z')).toBeNull()
    expect(wallClockMs(null)).toBeNull()
  })
})

describe('TripScope.time()', () => {
  let makeTripScope: typeof import('../server/utils/trip').makeTripScope
  beforeAll(async () => {
    vi.stubGlobal('sqlString', (v: string) => `'${v.replace(/'/g, "''")}'`)
    ;({ makeTripScope } = await import('../server/utils/trip'))
  })

  it('places rows on epoch_ms(observed_at) for a dated trip', () => {
    const t = makeTripScope('a:1', 'a', '2026-10-02 16:40:00.300', '2026-10-02 17:40:00.000')
    expect(t.clock).toBe('wall')
    expect(t.time()).toBe('epoch_ms(observed_at)')
    expect(t.time('b')).toBe('epoch_ms(b.observed_at)')
  })

  it('falls back to mono_ms for a trip with no UTC basis', () => {
    const t = makeTripScope('a:1', 'a', '1970-01-01 00:00:02.500', '1970-01-01 00:10:02.500')
    expect(t.clock).toBe('mono')
    expect(t.time()).toBe('mono_ms')
  })
})

describe('the timeline and scrubber across a boot', () => {
  const rows = onTripClock(timelineRows)

  it('orders the rows monotonically in time, with the second boot after the first', () => {
    for (let i = 1; i < rows.length; i++) expect(rows[i].t).toBeGreaterThanOrEqual(rows[i - 1].t)
    expect(rows.slice(0, SECS).every(r => r.boot === 1)).toBe(true)
    expect(rows.slice(SECS).every(r => r.boot === 2)).toBe(true)
    // the span is the whole outing, parked stretch included, not one boot's ten minutes
    expect((rows.at(-1)!.t - rows[0].t) / 60_000).toBeCloseTo(59.98, 1)
    // what used to happen: mono_ms orders boot 2 into boot 1
    const byMono = [...timelineRows].sort((a, b) => a.mono_ms - b.mono_ms)
    expect(byMono[1].boot).toBe(2)
  })

  it('a row that came without t_ms falls back to mono_ms', () => {
    expect(onTripClock([{ mono_ms: 42 }])[0].t).toBe(42)
  })

  it('seeks into the second boot, not to the first boot\'s row with the same mono_ms', () => {
    const at = BOOT2_AT + 120_000 // two minutes into boot 2
    const i = tripFloorIndex(rows, at)
    expect(rows[i].boot).toBe(2)
    expect(rows[i].mono_ms).toBe(MONO0 + 120_000)
    expect(tripNearest(rows, at)!.boot).toBe(2)
    const pos = tripPositionAt(rows, at)!
    expect(pos.lat).toBeCloseTo(LAT2 + (120 * 25) / M_PER_DEG_LAT, 6)
  })

  it('holds the car where it parked across the gap between the boots', () => {
    const parked = tripPositionAt(rows, BOOT1_AT + 30 * 60_000)!
    expect(parked.lat).toBeCloseTo(rows[SECS - 1].lat, 9)
    expect(tripNearest(rows, BOOT1_AT + 30 * 60_000)).toBeNull()
  })

  it('draws GPS health in time order and breaks the line across the parked stretch', () => {
    const { sats, fix } = gpsHealthSeries(rows, rows[0].t)
    const xs = sats.map(p => p[0])
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1])
    const breaks = sats.filter(p => p[1] === '-')
    expect(breaks).toHaveLength(1)
    expect(breaks[0][0]).toBe(SECS) // just after boot 1's last second (599 s)
    expect(sats.at(-1)).toEqual([3599, 11]) // boot 2's last fix, an hour in
    expect(fix).toHaveLength(sats.length)
  })
})

describe('stops across a boot', () => {
  it('finds the parked stretch between the boots, placed on the trip clock', () => {
    const fixes = trip.map(s => ({ lat: s.lat, lon: s.lon, speed_mps: s.speed_mps, mono_ms: s.mono_ms, observed_at: s.observed_at }))
    const stops = detectStops(fixes)
    expect(stops).toHaveLength(1)
    const [s] = stops
    expect(s.category).toBe('long')
    expect(s.start_t_ms).toBe(BOOT1_AT + (SECS - 1) * 1000)
    expect(s.end_t_ms).toBe(BOOT2_AT)
    expect(s.start_at).toBe(new Date(s.start_t_ms).toISOString())
    expect(s.start_offset_s).toBe(SECS - 1)
    expect(s.duration_s).toBe((BOOT2_AT - BOOT1_AT) / 1000 - (SECS - 1))
    // mono_ms is still the boots' own
    expect(s.start_mono_ms).toBe(MONO0 + (SECS - 1) * 1000)
    expect(s.end_mono_ms).toBe(MONO0)
  })
})

describe('GPS comparison across a boot', () => {
  // The device fixes on the second, the phone's half a second later, in both boots; the phone's
  // fixes travel to the dongle over BLE and are stored under its boot and mono clock.
  const toRow = (s: Sample, phone: boolean): GpsPositionRow & { boot: number } => ({
    boot: s.boot, boot_id: `boot-${s.boot}`, lat: s.lat, lon: s.lon, speed_mps: s.speed_mps, mono_ms: s.mono_ms, observed_at: s.observed_at,
    hdop: phone ? null : 1, h_acc_m: phone ? 5 : null, sats_used: 9, source_flags: phone ? GPS_SOURCE_PHONE : 1,
  })
  const device = trip.map(s => toRow(s, false))
  const phone = [...bootSamples(1, 500), ...bootSamples(2, 500)].map(s => toRow(s, true))
  const obd = trip.map(s => ({ mono_ms: s.mono_ms, observed_at: s.observed_at, speed_kph: s.speed_mps * 3.6 }))

  it('pairs each device fix with the phone fixes of the same wall-clock moment', () => {
    const pairs = pairGpsFixes(device, phone)
    expect(pairs.length).toBeGreaterThan(2 * SECS - 5)
    // same true path: every pair is the same place, in both boots
    expect(Math.max(...pairs.map(p => p.sep_m))).toBeLessThan(0.5)
    // a boot-2 device fix is paired at its own wall-clock time, not boot 1's with the same mono_ms
    const late = pairs.filter(p => p.t >= BOOT2_AT)
    expect(late.length).toBeGreaterThan(SECS - 5)
    expect(late.every(p => p.mono_ms < 610_000)).toBe(true)
    for (let i = 1; i < pairs.length; i++) expect(pairs[i].t).toBeGreaterThan(pairs[i - 1].t)
  })

  it('compares, bins and checks speed on the one clock', () => {
    const c = compareGps([...device, ...phone], obd)
    expect(c.clock).toBe('wall')
    expect(c.span_s).toBe(3600) // the whole outing, not one boot's ten minutes
    expect(c.pairs.count).toBeGreaterThan(2 * SECS - 5)
    expect(c.pairs.max_m).toBeLessThan(0.5)
    expect(c.pairs.speed_delta_abs_mean_kph).toBeLessThan(0.1)
    // boot 1 drives at 54 km/h and boot 2 at 90: paired by mono_ms these would be 36 km/h apart
    expect(c.device!.speed_rms_kph).toBeLessThan(0.1)
    expect(c.device!.speed_samples).toBeGreaterThan(2 * SECS - 5)
    // one point per second of each boot: the boots' seconds do not share bins
    expect(c.combined.points).toBe(2 * SECS)
    expect(c.combined.from_both).toBe(2 * SECS)
    // the parked stretch between the boots is neither a backwards step nor a receiver gap: the
    // device was off, so it does not count against coverage either
    expect(c.device!.gaps).toBe(0)
    expect(c.device!.coverage_pct).toBeGreaterThanOrEqual(99)
    expect(c.phone!.coverage_pct).toBeGreaterThanOrEqual(99)
    // without boot ids it is still one gap, and still not a backwards step
    const anon = compareGps([...device, ...phone].map(r => ({ ...r, boot_id: null })), obd)
    expect(anon.device!.gaps).toBe(1)
    expect(anon.device!.longest_gap_s).toBeCloseTo((BOOT2_AT - BOOT1_AT) / 1000 - (SECS - 1), 0)
    expect(c.device!.distance_m).toBeGreaterThan((SECS - 1) * 15 + (SECS - 1) * 25 - 50)
    const ts = c.pairs.series.map(s => s.t_ms)
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThan(ts[i - 1])
    expect(ts.at(-1)!).toBeGreaterThanOrEqual(BOOT2_AT)
  })

  it('combines the two into one track in time order across the boot', () => {
    const out = combineGps(device, phone)
    expect(out).toHaveLength(2 * SECS)
    for (let i = 1; i < out.length; i++) expect(out[i].t_ms).toBeGreaterThan(out[i - 1].t_ms)
    expect(out.slice(SECS).every(p => p.lat >= LAT2 - 1e-9)).toBe(true)
  })
})
