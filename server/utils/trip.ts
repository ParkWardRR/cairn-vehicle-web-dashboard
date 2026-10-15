/**
 * Resolving a trip id to the span it covers.
 *
 * A trip is an outing, not a power cycle: consecutive drives merged across any
 * stop shorter than the store's threshold (contracts/sync/v1 §trip_summary). So a
 * trip can span several boots, and `boot_id` is no longer a key — the id is
 * `<vehicle_id>:<started_ms>`, which is what `v_trip_summary.trip_id` reports.
 *
 * Everything downstream therefore filters on a vehicle and a time range instead of
 * a boot. That also means `ORDER BY mono_ms` is wrong for a trip: the monotonic
 * clock restarts at every boot, so two legs of one outing would interleave. Order
 * by `observed_at` and keep `mono_ms` only as a tie-break inside one boot; place a
 * sample in time with `TripScope.time()`, never with bare `mono_ms`.
 */
import { type TripClockKind, wallClockMs } from '../../shared/utils/tripClock'

export interface TripScope {
  tripId: string
  vehicleId: string
  startedAt: string
  endedAt: string
  /** Quoted SQL literals, ready to interpolate. */
  vehicleSql: string
  startSql: string
  endSql: string
  /**
   * `vehicle_id = … AND observed_at BETWEEN … AND …`, optionally table-qualified.
   * Pass the alias when the query joins more than one table.
   */
  where(alias?: string): string
  /**
   * The clock the trip's samples are placed on: 'wall' when the trip has a UTC basis, 'mono'
   * when none of it does (it is dated 1970). See shared/utils/tripClock.ts.
   */
  clock: TripClockKind
  /**
   * SQL for a row's time on that clock, in ms: `epoch_ms(observed_at)`, or `mono_ms` for a trip
   * with no wall clock. What a chart plots, a scrubber seeks or two series are paired on; never
   * bare mono_ms, which restarts at every boot of the trip.
   */
  time(alias?: string): string
}

/**
 * Look the trip up in the store rather than trusting the id's own timestamp.
 *
 * The id carries `started_ms`, so the span could be guessed from it — but a trip
 * can be re-keyed when an earlier part of the outing arrives late, and a guessed
 * end would be a fabrication. A 404 here is the honest answer for an id that no
 * longer names a trip.
 */
export async function resolveTrip(tripId: string): Promise<TripScope> {
  // The id is spliced into SQL below, so refuse anything that is not a trip id (or, for an old
  // link, a bare boot id) before it gets there. 400, not 404: the id is malformed, not unknown.
  if (!/^[0-9a-f]{32}(:[0-9]{1,16})?$/.test(tripId)) {
    throw createError({ statusCode: 400, statusMessage: 'trip id is <vehicle id>:<start in ms>' })
  }
  const idSql = sqlString(tripId)
  let rows = await queryTsdbObjects(`
    SELECT trip_id, vehicle_id,
           strftime(started_at, '%Y-%m-%d %H:%M:%S.%g') AS started_at,
           strftime(ended_at, '%Y-%m-%d %H:%M:%S.%g') AS ended_at
    FROM v_trip_summary WHERE trip_id = ${idSql}
  `)
  if (!rows.length && /^[0-9a-f]{32}$/.test(tripId)) {
    rows = await queryTsdbObjects(`
      SELECT trip_id, vehicle_id,
             strftime(started_at, '%Y-%m-%d %H:%M:%S.%g') AS started_at,
             strftime(ended_at, '%Y-%m-%d %H:%M:%S.%g') AS ended_at
      FROM v_trip_summary WHERE boot_id = ${idSql}
    `)
  }
  if (!rows.length) {
    throw createError({ statusCode: 404, statusMessage: 'Trip not found' })
  }
  const r = rows[0] as Record<string, string>
  return makeTripScope(r.trip_id, r.vehicle_id, r.started_at, r.ended_at)
}

export function makeTripScope(
  tripId: string,
  vehicleId: string,
  startedAt: string,
  endedAt: string,
): TripScope {
  const vehicleSql = sqlString(vehicleId)
  const startSql = `TIMESTAMP ${sqlString(startedAt)}`
  const endSql = `TIMESTAMP ${sqlString(endedAt)}`
  // ended_at is the trip's last row: if that has no wall clock, none of the trip does.
  // (resolveTrip formats it as a bare UTC 'YYYY-MM-DD HH:MM:SS.mmm'.)
  const endIso = /(?:[zZ]|[+-]\d\d:?\d\d)$/.test(endedAt) ? endedAt : `${endedAt.trim().replace(' ', 'T')}Z`
  const clock: TripClockKind = wallClockMs(endIso) != null ? 'wall' : 'mono'
  return {
    tripId,
    vehicleId,
    startedAt,
    endedAt,
    vehicleSql,
    startSql,
    endSql,
    where(alias?: string) {
      const p = alias ? `${alias}.` : ''
      return `${p}vehicle_id = ${vehicleSql} AND ${p}observed_at BETWEEN ${startSql} AND ${endSql}`
    },
    clock,
    time(alias?: string) {
      const p = alias ? `${alias}.` : ''
      return clock === 'wall' ? `epoch_ms(${p}observed_at)` : `${p}mono_ms`
    },
  }
}

/**
 * The positions a trip's single-track figures are read from: the dongle's own GNSS
 * fixes, or the phone's when the dongle never had a fix during the trip. The store
 * holds both under the same boot (source_flags bit 5), and reading both would drive
 * the same road twice.
 *
 * Fixes the store marks untrusted (v_position_trusted: the accelerometer or physics
 * contradicts them) are left out, so a receiver's run after the car has parked never
 * reaches a track, a stop or an endpoint. The raw rows stay in `position`.
 *
 * The trip-scoped counterpart of primaryPositions(). The fallback is decided per
 * trip rather than per boot, which is the point: an outing whose first leg had no
 * fix but whose second did should use the dongle throughout, not switch sources
 * halfway.
 */
export function tripPositions(trip: TripScope): string {
  return `(
    SELECT * FROM v_position_trusted
    WHERE ${trip.where()} AND trusted
      AND (coalesce(source_flags, 0) & 32 = 0
           OR NOT EXISTS (SELECT 1 FROM v_position_trusted d
                          WHERE ${trip.where('d')} AND d.trusted AND coalesce(d.source_flags, 0) & 32 = 0
                            AND d.lat != 0 AND d.lon != 0))
  ) AS pos`
}
