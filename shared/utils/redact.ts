// Redaction for anything that leaves the app as a picture or a file: the same rules whatever
// the output, so what is hidden does not depend on which button was pressed.
//
//  - Points inside a privacy zone (a saved place of a private kind, plus a margin) are removed,
//    wherever in the trip they fall, and the route is split there.
//  - Nothing within TRIM_M metres (straight line) of the trip's true start or end is drawn, even if
//    the route comes back past it, so they are hidden even when they are not a saved place.
//  - Nothing else is carried: no times, no ids.

export interface RoutePoint { lat: number; lon: number; speed_kph: number | null }
export interface Zone { lat: number; lon: number; radius_m: number }

// Kinds of place that are private by nature.
export const PRIVATE_KINDS = ['home', 'work', 'school', 'health', 'friends', 'worship']
export const ZONE_MARGIN_M = 100
export const MIN_TRIM_M = 300
export const MAX_TRIM_M = 2000

export interface Redacted {
  segments: RoutePoint[][]
  zones: number
  trim_m: number
  points_removed: number
}

function dist(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dx = (b.lon - a.lon) * Math.cos(a.lat * Math.PI / 180) * 111320
  const dy = (b.lat - a.lat) * 110540
  return Math.sqrt(dx * dx + dy * dy)
}

export function zonesFrom(places: Array<{ category: string | null; lat: number; lon: number; radius_m: number }>): Zone[] {
  return places
    .filter(p => p.category && PRIVATE_KINDS.includes(p.category.toLowerCase()))
    .map(p => ({ lat: p.lat, lon: p.lon, radius_m: p.radius_m + ZONE_MARGIN_M }))
}

export function clampTrim(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(Math.max(Math.round(n), MIN_TRIM_M), MAX_TRIM_M) : MIN_TRIM_M
}

export function redactRoute(points: RoutePoint[], zones: Zone[], trimM: number = MIN_TRIM_M): Redacted {
  const trim = clampTrim(trimM)
  // The true start and end are exclusion circles, not stretches of path: a route that curves back,
  // or loops, can pass close to where it began after any length of path has been cut.
  const ends: Zone[] = points.length ? [
    { lat: points[0].lat, lon: points[0].lon, radius_m: trim },
    { lat: points[points.length - 1].lat, lon: points[points.length - 1].lon, radius_m: trim },
  ] : []
  const all = [...zones, ...ends]
  const inside = (p: RoutePoint) => all.some(z => dist(z, p) <= z.radius_m)

  // Split at everything removed: a stop at home in the middle of a trip leaves two pieces, not a
  // line through it. Only position and speed are copied, whatever else the input carries.
  const segments: RoutePoint[][] = []
  let cur: RoutePoint[] = []
  const flush = () => { if (cur.length >= 2) segments.push(cur); cur = [] }
  for (const p of points) {
    if (inside(p)) flush()
    else cur.push({ lat: p.lat, lon: p.lon, speed_kph: p.speed_kph ?? null })
  }
  flush()
  const drawn = segments.reduce((n, s) => n + s.length, 0)
  return { segments, zones: zones.length, trim_m: trim, points_removed: points.length - drawn }
}

// Thin a long line for drawing, keeping its shape: at most `max` points, always the ends.
export function thin<T>(points: T[], max: number): T[] {
  if (points.length <= max) return points
  const out: T[] = []
  const step = (points.length - 1) / (max - 1)
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)])
  return out
}

