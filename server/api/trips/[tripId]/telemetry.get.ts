export default defineEventHandler(async (event) => {
  const tripId = getRouterParam(event, 'tripId')
  if (!tripId) throw createError({ statusCode: 400, statusMessage: 'tripId required' })
  const trip = await resolveTrip(tripId)

  const rows = await queryTsdbObjects(`
    SELECT * FROM v_telemetry
    WHERE ${trip.where()}
    ORDER BY observed_at, mono_ms ASC
  `)

  return { telemetry: rows }
})
