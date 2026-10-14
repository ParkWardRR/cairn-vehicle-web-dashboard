export default defineEventHandler(async (event) => {
  const tripId = getRouterParam(event, 'tripId')
  if (!tripId) throw createError({ statusCode: 400, statusMessage: 'tripId required' })
  const trip = await resolveTrip(tripId)

  const [obd, boost, gps] = await Promise.all([
    queryTsdbObjects(`
      SELECT mono_ms, speed_kph, rpm, coolant_c, intake_c,
        throttle_pct, load_pct
      FROM obd WHERE ${trip.where()}
      ORDER BY observed_at, mono_ms
    `),
    queryTsdbObjects(`
      SELECT mono_ms, boost_psi, lambda_ratio, stft_pct, ltft_pct
      FROM boost WHERE ${trip.where()}
      ORDER BY observed_at, mono_ms
    `),
    queryTsdbObjects(`
      SELECT mono_ms, lat, lon, speed_mps, sats_used, fix_type, hdop,
        h_acc_m, alt_m
      FROM ${tripPositions(trip)} WHERE ${trip.where()}
      ORDER BY observed_at, mono_ms
    `),
  ])

  return { obd, boost, gps }
})
