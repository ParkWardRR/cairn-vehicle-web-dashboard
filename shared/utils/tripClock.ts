// The clock a trip's samples are placed on.
//
// A trip is an outing and can span several boots. `mono_ms` is the device's monotonic clock, which
// restarts at every boot, so the same mono_ms names a different moment in each boot of one trip:
// anything that orders, offsets, bins or pairs a trip's samples by mono_ms folds the boots on top of
// one another. `observed_at` (the store's UTC basis plus mono_ms) is the clock that runs across them.
// A row stamped before 2000 has no UTC basis (it decodes to 1970 + mono_ms), so a trip with no row
// carrying a wall clock is placed on mono_ms instead, which is then all there is.
//
// The server does the same in SQL (TripScope.time() in server/utils/trip.ts) and hands the result to
// the browser as `t_ms`, so the charts never have to choose.

export const WALL_CLOCK_FLOOR_MS = Date.UTC(2000, 0, 1)

/** Milliseconds since the epoch, or null when `at` is missing or carries no wall clock. */
export function wallClockMs(at: unknown): number | null {
  if (at == null || at === '') return null
  const t = at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.parse(String(at))
  return Number.isFinite(t) && t > WALL_CLOCK_FLOOR_MS ? t : null
}

export interface TripClockRow {
  mono_ms: number
  observed_at?: string | Date | null
  /** a time the server has already placed on the trip's clock */
  t_ms?: number | null
}

export type TripClockKind = 'wall' | 'mono'

/** 'wall' if any row of the trip has a wall-clock time, else 'mono'. */
export function tripClockKind(...sets: ReadonlyArray<ReadonlyArray<TripClockRow>>): TripClockKind {
  for (const rows of sets) for (const r of rows) if (wallClockMs(r.observed_at) != null) return 'wall'
  return 'mono'
}

/**
 * The time of a row on the trip's clock, in ms. Chosen once for all the rows given, so every series
 * of a trip shares one axis. On the wall clock a row with no wall-clock time of its own has no place
 * (NaN): callers drop those rather than mix two clocks in one series.
 */
export function tripClock(...sets: ReadonlyArray<ReadonlyArray<TripClockRow>>): (r: TripClockRow) => number {
  const kind = tripClockKind(...sets)
  return (r) => {
    if (typeof r.t_ms === 'number' && Number.isFinite(r.t_ms)) return r.t_ms
    return kind === 'wall' ? (wallClockMs(r.observed_at) ?? Number.NaN) : r.mono_ms
  }
}
