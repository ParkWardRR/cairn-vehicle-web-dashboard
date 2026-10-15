// A trip's OBD, boost and GPS series, for the scrubber and the GPS-health chart.
//
// Every row carries `t_ms`, its time on the trip's clock (TripScope.time(): the wall clock, or
// mono_ms for a trip with no UTC basis), and the charts plot and seek on that. mono_ms stays in the
// rows but is no axis: it restarts at every boot, and a trip can span several, so charting it laid
// the boots over one another.
export default defineEventHandler(async (event) => {
  const tripId = getRouterParam(event, 'tripId')
  if (!tripId) throw createError({ statusCode: 400, statusMessage: 'tripId required' })
  const trip = await resolveTrip(tripId)
  const t = trip.time()

  const [obd, boost, gps] = await Promise.all([
    queryTsdbObjects(`
      SELECT ${t} AS t_ms, mono_ms, speed_kph, rpm, coolant_c, intake_c,
        throttle_pct, load_pct
      FROM obd WHERE ${trip.where()}
      ORDER BY observed_at, mono_ms
    `),
    queryTsdbObjects(`
      SELECT ${t} AS t_ms, mono_ms, boost_psi, lambda_ratio, stft_pct, ltft_pct
      FROM boost WHERE ${trip.where()}
      ORDER BY observed_at, mono_ms
    `),
    queryTsdbObjects(`
      SELECT ${t} AS t_ms, mono_ms, lat, lon, speed_mps, sats_used, fix_type, hdop,
        h_acc_m, alt_m
      FROM ${tripPositions(trip)} WHERE ${trip.where()}
      ORDER BY observed_at, mono_ms
    `),
  ])

  // `clock` says what t_ms is: 'wall' is epoch milliseconds, 'mono' is the device's own clock.
  return { clock: trip.clock, obd, boost, gps }
})
