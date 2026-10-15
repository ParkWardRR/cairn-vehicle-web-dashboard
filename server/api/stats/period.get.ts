import type { VehicleScope } from '../../utils/vehicle'
import { bucketStarts, parseDay, periodRange, PERIODS, type Bucket, type Period } from '../../../shared/utils/period'

// Statistics for a calendar period (year, quarter, month, week) or a custom range, with a chart
// series with no holes and the same totals for the period before. Days are UTC. A trip belongs to
// the period it started in.
//
//   /api/stats/period?period=month&date=2026-03-15        the month containing that day
//   /api/stats/period?period=custom&from=2026-03-01&to=2026-03-10
//
// Computed from the store's per-trip summary (v_trip_summary), not from per-period store views,
// so it works against any store that has it. Duration is the trip's wall-clock span, as the trip
// list shows it, and distance is the summary's own.
interface Totals { trips: number; duration_s: number; distance_m: number; max_speed_kph: number }

const TRUNC: Record<Bucket, string> = { day: 'day', week: 'week', month: 'month' }

async function rows(v: VehicleScope, from: string, to: string, bucket: Bucket) {
  return queryTsdbObjects(`
    SELECT strftime(date_trunc('${TRUNC[bucket]}', started_at), '%Y-%m-%d') AS bucket,
      count(*) AS trips,
      coalesce(sum(duration_ms), 0) / 1000.0 AS duration_s,
      coalesce(sum(distance_m), 0) AS distance_m,
      coalesce(max(max_obd_speed_kph), 0) AS max_speed_kph
    FROM v_trip_summary
    WHERE started_at >= ${sqlString(from)}::TIMESTAMP AND started_at < ${sqlString(to)}::TIMESTAMP${v.and()}
    GROUP BY 1 ORDER BY 1
  `)
}

function totalOf(buckets: Array<Record<string, any>>): Totals {
  return buckets.reduce<Totals>((t, b) => ({
    trips: t.trips + Number(b.trips),
    duration_s: t.duration_s + Number(b.duration_s),
    distance_m: t.distance_m + Number(b.distance_m),
    max_speed_kph: Math.max(t.max_speed_kph, Number(b.max_speed_kph)),
  }), { trips: 0, duration_s: 0, distance_m: 0, max_speed_kph: 0 })
}

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const period = String(q.period ?? 'month') as Period
  if (!PERIODS.includes(period)) throw createError({ statusCode: 400, statusMessage: `period must be one of ${PERIODS.join(', ')}` })
  const anchor = q.date === undefined ? new Date() : parseDay(q.date)
  if (!anchor) throw createError({ statusCode: 400, statusMessage: 'date must be YYYY-MM-DD' })
  let range
  try {
    range = periodRange(period, anchor, { from: q.from as string | undefined, to: q.to as string | undefined })
  } catch (e: any) {
    throw createError({ statusCode: 400, statusMessage: e.message })
  }

  const v = await vehicleScope(event)
  const [current, previous] = await Promise.all([
    rows(v, range.from, range.to, range.bucket),
    rows(v, range.previous.from, range.previous.to, 'month'),
  ])
  const byBucket = new Map(current.map(r => [String(r.bucket), r]))
  const series = bucketStarts(range.from, range.to, range.bucket).map((b) => {
    const r = byBucket.get(b)
    return { bucket: b, trips: Number(r?.trips ?? 0), duration_s: Number(r?.duration_s ?? 0), distance_m: Number(r?.distance_m ?? 0), max_speed_kph: Number(r?.max_speed_kph ?? 0) }
  })

  return {
    period: range.period,
    from: range.from,
    to: range.to,
    bucket: range.bucket,
    totals: totalOf(series),
    previous: { from: range.previous.from, to: range.previous.to, totals: totalOf(previous) },
    series,
  }
})
