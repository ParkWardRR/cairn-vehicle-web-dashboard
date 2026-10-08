import { clampTrim, redactRoute, thin, zonesFrom } from '../../../../shared/utils/redact'

// What a shareable picture of a trip is drawn from: the route's shape and a few totals, already
// redacted (privacy zones removed and the true start and end never included; see
// shared/utils/redact.ts). The picture itself is drawn in the browser with no map tiles, so
// nothing about the trip is sent to a third party. No times, ids or coordinates beyond the line.
//
//   ?trim=300   metres hidden at each end (300 to 2000; there is no way to ask for less)
const MAX_POINTS = 3000

export default defineEventHandler(async (event) => {
  const bootId = getRouterParam(event, 'bootId') ?? ''
  if (!/^[0-9a-f]{32}$/.test(bootId)) throw createError({ statusCode: 400, statusMessage: 'boot id must be 32 hex characters' })
  const id = sqlString(bootId)

  const raw = await queryTsdbObjects(`
    SELECT lat, lon, speed_mps, mono_ms, observed_at FROM ${primaryPositions(id)}
    WHERE boot_id = ${id} AND lat != 0 AND lon != 0 ORDER BY mono_ms ASC
  `)
  if (!raw.length) throw createError({ statusCode: 404, statusMessage: 'Trip not found' })

  const fixed = filterOutliers(raw)
  const points = fixed.map((p: any) => ({ lat: p.lat as number, lon: p.lon as number, speed_kph: p.speed_mps == null ? null : Math.round(p.speed_mps * 3.6) }))
  let distance_m = 0
  for (let i = 1; i < fixed.length; i++) distance_m += distM(fixed[i - 1].lat, fixed[i - 1].lon, fixed[i].lat, fixed[i].lon)

  const zones = zonesFrom(getPlaceResolver().saved.list())
  const trim = clampTrim(getQuery(event).trim)
  const r = redactRoute(points, zones, trim)

  const summary = await queryTsdbObjects(`SELECT duration_s, max_speed_kph FROM v_drive_summary WHERE boot_id = ${id} LIMIT 1`)
  const day = String(fixed[0].observed_at ?? '').slice(0, 10)
  return {
    // each piece thinned to keep the payload small; the shape survives
    segments: r.segments.map(seg => thin(seg, Math.max(2, Math.floor(MAX_POINTS / Math.max(1, r.segments.length))))),
    summary: {
      day: /^\d{4}-\d{2}-\d{2}$/.test(day) && day > '2000' ? day : null,
      duration_s: Number(summary[0]?.duration_s ?? 0),
      distance_m: Math.round(distance_m),
      max_speed_kph: Math.round(Number(summary[0]?.max_speed_kph ?? 0)),
    },
    redaction: { trim_m: r.trim_m, zones: r.zones, points_removed: r.points_removed },
  }
})
