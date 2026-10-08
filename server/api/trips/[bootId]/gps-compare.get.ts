// How the dongle's GNSS and the phone's GPS differed on one trip, and how each fares against the
// car's own speed. The sums are in shared/utils/gpsSources.ts.
export default defineEventHandler(async (event) => {
  const bootId = getRouterParam(event, 'bootId')
  if (!bootId) throw createError({ statusCode: 400, statusMessage: 'bootId required' })
  const id = sqlString(bootId)

  const [positions, obd] = await Promise.all([
    queryTsdbObjects(`
      SELECT lat, lon, alt_m, speed_mps, heading_deg, h_acc_m, hdop, sats_used, fix_type, source_flags, mono_ms
      FROM position
      WHERE boot_id = ${id} AND lat != 0 AND lon != 0
      ORDER BY mono_ms ASC
    `),
    queryTsdbObjects(`
      SELECT mono_ms, speed_kph FROM obd
      WHERE boot_id = ${id} AND speed_kph IS NOT NULL
      ORDER BY mono_ms ASC
    `),
  ])

  return compareGps(positions as GpsPositionRow[], obd as GpsSpeedRow[])
})
