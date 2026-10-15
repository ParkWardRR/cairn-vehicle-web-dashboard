// MAF-based fuel samples for one trip. The blend-dependent maths happens in the
// browser, because the ethanol blend is a per-browser setting.
//
// MAF is only polled on some rounds of the OBD chain, so a trip typically has a
// few dozen usable samples rather than a continuous series: callers must treat
// anything derived from these as an estimate and show the sample count.
export default defineEventHandler(async (event) => {
  const tripId = getRouterParam(event, 'tripId')
  if (!tripId) throw createError({ statusCode: 400, statusMessage: 'tripId required' })
  const trip = await resolveTrip(tripId)

  const [samples, distance, duration] = await Promise.all([
    queryTsdbObjects(`
      SELECT o.speed_kph, b.maf_cgps, b.lambda_ratio, b.mono_ms
      FROM boost b
      ASOF JOIN obd o ON b.vehicle_id = o.vehicle_id AND b.boot_id = o.boot_id AND b.mono_ms >= o.mono_ms
      WHERE ${trip.where('b')}
        AND b.maf_cgps IS NOT NULL AND b.lambda_ratio IS NOT NULL
        AND b.lambda_ratio > 0.7 AND b.lambda_ratio < 1.3
        AND o.speed_kph IS NOT NULL
      ORDER BY b.observed_at, b.mono_ms
    `),
    // Each step is capped: the device logs sparsely while parked, so a long
    // silence between two fixes must not be counted as driving at the last speed. Steps are
    // measured on observed_at, not mono_ms: a trip can span boots, the monotonic clock
    // restarts at each, and UINT32 subtraction across the restart overflows and fails the call.
    queryTsdbObjects(`
      SELECT coalesce(sum(speed_mps * least(greatest(epoch_ms(lead_at) - epoch_ms(observed_at), 0), 10000) / 1000.0), 0) AS distance_m
      FROM (
        SELECT observed_at, speed_mps, lead(observed_at) OVER (ORDER BY observed_at, mono_ms) AS lead_at
        FROM ${tripPositions(trip)} WHERE ${trip.where()} AND speed_mps IS NOT NULL
      ) WHERE lead_at IS NOT NULL
    `),
    queryTsdbObjects(`SELECT coalesce(driving_ms, duration_ms) / 1000.0 AS duration_s FROM v_trip_summary WHERE trip_id = ${sqlString(trip.tripId)}`),
  ])

  return {
    samples,
    distance_m: Number(distance[0]?.distance_m ?? 0),
    duration_s: duration[0]?.duration_s ?? null,
  }
})
