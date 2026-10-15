// Placing a trip's timeline rows in time, for the scrubber and the GPS-health chart.
//
// The timeline API gives every row `t_ms`, its time on the trip's clock (see tripClock.ts): the
// wall clock, or mono_ms for a trip with no UTC basis. Nothing here reads mono_ms as a time except
// as the fallback for a row from a server that sent no t_ms: a trip can span boots, and mono_ms
// restarts at each.

export interface TripTimedRow {
  t_ms?: number | null
  mono_ms: number
}

/** The rows with `t`, their time on the trip's clock, in time order (the lookups binary-search on it). */
export function onTripClock<T extends TripTimedRow>(rows: ReadonlyArray<T> | null | undefined): Array<T & { t: number }> {
  return (rows ?? [])
    .map(r => ({ ...r, t: typeof r.t_ms === 'number' && Number.isFinite(r.t_ms) ? r.t_ms : r.mono_ms }))
    .sort((a, b) => a.t - b.t)
}

/** Index of the last row at or before `ms`, or -1. */
export function tripFloorIndex(rows: ReadonlyArray<{ t: number }>, ms: number): number {
  let lo = 0
  let hi = rows.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (rows[mid].t <= ms) { ans = mid; lo = mid + 1 } else hi = mid - 1
  }
  return ans
}

/** The row nearest `ms`, if it is within `within` ms of it. */
export function tripNearest<T extends { t: number }>(rows: ReadonlyArray<T>, ms: number, within = 10_000): T | null {
  if (!rows.length) return null
  const i = tripFloorIndex(rows, ms)
  let best: T | null = null
  for (const c of [rows[i], rows[i + 1]]) if (c && (!best || Math.abs(c.t - ms) < Math.abs(best.t - ms))) best = c
  return best && Math.abs(best.t - ms) <= within ? best : null
}

/**
 * Where the car was at `ms`. Fixes close together are interpolated; across a long silence (parked,
 * between two boots of the trip, or the receiver out) the car is held at its last fix. Before the
 * first fix there is no position.
 */
export function tripPositionAt(
  fixes: ReadonlyArray<{ t: number; lat: number; lon: number }>,
  ms: number,
  holdAfterMs = 30_000,
): { lat: number; lon: number } | null {
  if (!fixes.length || ms < fixes[0].t) return null
  const i = tripFloorIndex(fixes, ms)
  const a = fixes[i]
  const b = fixes[i + 1]
  if (!b || b.t - a.t > holdAfterMs) return { lat: a.lat, lon: a.lon }
  const k = (ms - a.t) / (b.t - a.t)
  return { lat: a.lat + (b.lat - a.lat) * k, lon: a.lon + (b.lon - a.lon) * k }
}

/**
 * The GPS-health chart's two lines, satellites in use and whether there was a fix, as
 * [seconds from `startMs`, value] points. A silence longer than `gapMs` breaks both lines (ECharts
 * reads '-' as missing) rather than drawing a straight line across it.
 */
export function gpsHealthSeries(
  gps: ReadonlyArray<{ t: number; lat: number; lon: number; sats_used?: number | null }>,
  startMs: number,
  gapMs = 30_000,
): { sats: Array<[number, number | '-']>; fix: Array<[number, number | '-']> } {
  const sats: Array<[number, number | '-']> = []
  const fix: Array<[number, number | '-']> = []
  const sec = (t: number) => Math.round((t - startMs) / 1000)
  gps.forEach((g, i) => {
    const prev = gps[i - 1]
    if (prev && g.t - prev.t > gapMs) {
      sats.push([sec(prev.t) + 1, '-'])
      fix.push([sec(prev.t) + 1, '-'])
    }
    sats.push([sec(g.t), g.sats_used ?? 0])
    fix.push([sec(g.t), g.lat !== 0 && g.lon !== 0 ? 1 : 0])
  })
  return { sats, fix }
}
