export default defineEventHandler(async (event) => {
  const tripId = getRouterParam(event, 'tripId')
  if (!tripId) throw createError({ statusCode: 400, statusMessage: 'tripId required' })
  const trip = await resolveTrip(tripId)

  const imuEvents = await queryTsdbObjects(`
    SELECT mono_ms, observed_at, accel_rms_mg, accel_peak_x_mg, accel_peak_y_mg, accel_peak_z_mg,
      gyro_peak_dps, variance, event_flags
    FROM imu
    WHERE ${trip.where()} AND event_flags > 0
    ORDER BY observed_at, mono_ms ASC
  `)

  const transitions = await queryTsdbObjects(`
    SELECT * FROM transition
    WHERE ${trip.where()}
    ORDER BY observed_at, mono_ms ASC
  `)

  return { imuEvents, transitions }
})
