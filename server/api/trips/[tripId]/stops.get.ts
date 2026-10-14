export default defineEventHandler(async (event) => {
  const tripId = getRouterParam(event, 'tripId')
  if (!tripId) throw createError({ statusCode: 400, statusMessage: 'tripId required' })
  const trip = await resolveTrip(tripId)

  const fixes = await queryTsdbObjects(`
    SELECT lat, lon, speed_mps, mono_ms, observed_at
    FROM ${tripPositions(trip)}
    WHERE ${trip.where()} AND lat != 0 AND lon != 0
    ORDER BY observed_at, mono_ms ASC
  `)

  const stops = detectStops(fixes as StopFix[])
  const { results, pending } = lookupPlaces(
    stops.map(s => ({ lat: s.lat, lon: s.lon, ctx: { dwell_s: s.duration_s, endpoint: false } })),
  )

  return {
    stops: stops.map((s, i) => ({ ...s, place: placeForApi(results[i]) })),
    pending,
    attribution: attributionForResults(results),
  }
})
