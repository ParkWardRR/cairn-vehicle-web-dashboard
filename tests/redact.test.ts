// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { clampTrim, MIN_TRIM_M, PRIVATE_KINDS, redactRoute, thin, zonesFrom, type RoutePoint } from '../shared/utils/redact'

// A straight drive due north from (37, -122): one point every 50 m, 100 points, ~4.95 km.
const M_PER_DEG = 110540
const line = (n = 100, step = 50): RoutePoint[] => Array.from({ length: n }, (_, i) => ({ lat: 37 + (i * step) / M_PER_DEG, lon: -122, speed_kph: 50 }))
const at = (m: number) => ({ lat: 37 + m / M_PER_DEG, lon: -122 })
const len = (pts: RoutePoint[]) => (pts.length - 1) * 50

describe('hiding the start and end', () => {
  it('draws nothing within 300 m of the true start or end, with no zones at all', () => {
    const r = redactRoute(line(), [])
    expect(r.segments).toHaveLength(1)
    const s = r.segments[0]
    const startM = (s[0].lat - 37) * M_PER_DEG, endM = (s[s.length - 1].lat - 37) * M_PER_DEG
    expect(startM).toBeGreaterThanOrEqual(MIN_TRIM_M - 1e-6)
    expect(endM).toBeLessThanOrEqual(99 * 50 - MIN_TRIM_M + 1e-6)
    expect(r.points_removed).toBe(100 - s.length)
  })
  it('holds for a route that curls back past where it began', () => {
    // out 1 km north, then back south to 100 m from the start, then off east: a path-length cut
    // would draw the part near the start
    const out = line(21)                               // 0..1000 m north
    const back = line(18).reverse().map(p => ({ ...p })) // 850..0 m, reversed so it returns south
    const route = [...out, ...back.slice(1, 17)]       // ends ~100 m from the start
    const r = redactRoute(route, [])
    const start = route[0], end = route[route.length - 1]
    const d = (p: RoutePoint, q: RoutePoint) => Math.hypot((q.lon - p.lon) * Math.cos(p.lat * Math.PI / 180) * 111320, (q.lat - p.lat) * 110540)
    for (const p of r.segments.flat()) { expect(d(p, start)).toBeGreaterThan(300); expect(d(p, end)).toBeGreaterThan(300) }
  })
  it('cannot be asked for less than the minimum, and has a ceiling', () => {
    expect(clampTrim(0)).toBe(300)
    expect(clampTrim(-5)).toBe(300)
    expect(clampTrim('abc')).toBe(300)
    expect(clampTrim(99999)).toBe(2000)
    expect(clampTrim(500)).toBe(500)
    const a = redactRoute(line(), [], 0).segments[0], b = redactRoute(line(), [], 300).segments[0]
    expect(a).toEqual(b)
    expect(redactRoute(line(), [], 1000).segments[0].length).toBeLessThan(b.length)
  })
  it('draws nothing of a trip too short to hide its ends', () => {
    expect(redactRoute(line(10), []).segments).toEqual([])      // 450 m
    expect(redactRoute(line(12), []).segments).toEqual([])      // 550 m: the two circles cover all of it
    expect(redactRoute(line(20), []).segments.length).toBe(1)   // 950 m: a stretch in the middle
    expect(redactRoute([], []).segments).toEqual([])
    expect(redactRoute(line(1), []).segments).toEqual([])
  })
})

describe('privacy zones', () => {
  it('only private kinds make zones, widened by a margin', () => {
    const z = zonesFrom([
      { category: 'home', lat: 1, lon: 2, radius_m: 100 }, { category: 'Work', lat: 3, lon: 4, radius_m: 50 },
      { category: 'food', lat: 5, lon: 6, radius_m: 100 }, { category: null, lat: 7, lon: 8, radius_m: 100 },
    ])
    expect(z).toEqual([{ lat: 1, lon: 2, radius_m: 200 }, { lat: 3, lon: 4, radius_m: 150 }])
    expect(PRIVATE_KINDS).toEqual(expect.arrayContaining(['home', 'work', 'school', 'health']))
  })
  it('removes every point inside a zone, and splits the route there', () => {
    // a zone in the middle of the drive, like a stop at home
    const r = redactRoute(line(), [{ ...at(2500), radius_m: 200 }])
    expect(r.segments).toHaveLength(2)
    for (const s of r.segments) for (const p of s) expect(Math.abs((p.lat - 37) * M_PER_DEG - 2500)).toBeGreaterThan(200)
    expect(r.zones).toBe(1)
  })
  it('a zone at the start leaves the true start hidden twice over', () => {
    const r = redactRoute(line(), [{ ...at(0), radius_m: 400 }])
    const first = r.segments[0][0]
    expect((first.lat - 37) * M_PER_DEG).toBeGreaterThan(400)
    // the larger of the zone and the 300 m start circle wins
    expect((first.lat - 37) * M_PER_DEG).toBeGreaterThan(400)
  })
  it('drops a piece too short to mean anything', () => {
    const r = redactRoute(line(), [{ ...at(1000), radius_m: 100 }, { ...at(1300), radius_m: 100 }])
    for (const s of r.segments) expect(s.length).toBeGreaterThanOrEqual(2)
  })
  it('carries nothing but position and speed', () => {
    const r = redactRoute(line().map(p => ({ ...p, observed_at: '2026-01-01T00:00:00Z', boot_id: 'x' }) as any), [])
    for (const p of r.segments[0]) expect(Object.keys(p).sort()).toEqual(['lat', 'lon', 'speed_kph'])
  })
})

describe('thin', () => {
  it('keeps the ends and the shape, and leaves a short line alone', () => {
    const pts = line(1000)
    const t = thin(pts, 100)
    expect(t).toHaveLength(100)
    expect(t[0]).toBe(pts[0]); expect(t[99]).toBe(pts[999])
    expect(thin(line(5), 100)).toHaveLength(5)
    void len
  })
})
