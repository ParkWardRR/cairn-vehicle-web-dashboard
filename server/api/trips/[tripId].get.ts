export default defineEventHandler(async (event) => {
  const tripId = getRouterParam(event, 'tripId')
  if (!tripId) throw createError({ statusCode: 400, statusMessage: 'tripId required' })
  const trip = await resolveTrip(tripId)

  // v_trip_summary, not v_drive_summary: the latter is one row per (vehicle, boot)
  // and a trip can span boots. resolveTrip has already 404'd an unknown id.
  const summary = await queryTsdbObjects(`
    SELECT * FROM v_trip_summary WHERE trip_id = ${sqlString(trip.tripId)}
  `)
  if (!summary.length) {
    throw createError({ statusCode: 404, statusMessage: 'Trip not found' })
  }

  const firstPos = await queryTsdbObjects(`
    SELECT observed_at, lat, lon FROM ${tripPositions(trip)}
    WHERE ${trip.where()}
    ORDER BY observed_at, mono_ms ASC LIMIT 1
  `)

  const lastPos = await queryTsdbObjects(`
    SELECT observed_at, lat, lon FROM ${tripPositions(trip)}
    WHERE ${trip.where()}
    ORDER BY observed_at DESC, mono_ms DESC LIMIT 1
  `)

  const [events, fixDelay, prevTrip] = await Promise.all([
    queryTsdbObjects(`
      SELECT count(*) AS harsh_event_count FROM imu
      WHERE ${trip.where()} AND event_flags > 0
    `),
    queryTsdbObjects(`
      SELECT
        (SELECT min(mono_ms) FROM obd WHERE ${trip.where()}) AS first_obd_ms,
        (SELECT max(mono_ms) FROM obd WHERE ${trip.where()}) AS last_obd_ms,
        (SELECT min(mono_ms) FROM ${tripPositions(trip)}) AS first_pos_ms,
        (SELECT min(mono_ms) FROM ${tripPositions(trip)} WHERE lat != 0 AND lon != 0) AS first_fix_ms
    `),
    // Where this car last parked before this trip, so the detail page can draw the
    // gap between trips. The previous TRIP, not the previous boot: a boot boundary
    // inside one outing is not somewhere the car parked, and taking it would put a
    // phantom stop in the middle of an errand.
    //
    // Another car's last park says nothing about where this one started, so the
    // vehicle is matched too.
    queryTsdbObjects(`
      SELECT p.lat, p.lon, p.observed_at
      FROM position p
      JOIN (
        SELECT started_at, ended_at FROM v_trip_summary
        WHERE vehicle_id = ${trip.vehicleSql}
          AND ended_at < ${trip.startSql}
        ORDER BY ended_at DESC
        LIMIT 1
      ) prev
        ON p.vehicle_id = ${trip.vehicleSql}
       AND p.observed_at BETWEEN prev.started_at AND prev.ended_at
      WHERE p.lat != 0 AND p.lon != 0
      ORDER BY p.observed_at DESC, p.mono_ms DESC
      LIMIT 1
    `),
  ])

  const endpoints = [firstPos[0], lastPos[0]].filter(Boolean) as Array<{ lat: number; lon: number }>
  const { results: endpointPlaces, pending } = lookupPlaces(
    endpoints.map(p => ({ lat: p.lat, lon: p.lon, ctx: { dwell_s: 0, endpoint: true } })),
  )
  const startPlace = firstPos[0] ? placeForApi(endpointPlaces[0]) : null
  const endPlace = lastPos[0] ? placeForApi(endpointPlaces[endpoints.length - 1]) : null

  const fd = fixDelay[0] ?? {}
  return {
    ...summary[0],
    start: firstPos[0] ? { ...firstPos[0], place: startPlace } : null,
    end: lastPos[0] ? { ...lastPos[0], place: endPlace } : null,
    places_pending: pending,
    attribution: attributionForResults(endpointPlaces),
    harsh_event_count: events[0]?.harsh_event_count ?? 0,
    first_obd_ms: fd.first_obd_ms ?? null,
    last_obd_ms: fd.last_obd_ms ?? null,
    first_pos_ms: fd.first_pos_ms ?? null,
    first_fix_ms: fd.first_fix_ms ?? null,
    prev_end: prevTrip[0] ?? null,
  }
})
