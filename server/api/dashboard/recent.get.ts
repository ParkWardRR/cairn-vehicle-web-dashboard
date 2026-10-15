// The five newest trips, as the home page shows them. One row per trip (v_trip_summary), with
// duration_s and max_speed_kph kept as the names the page reads. trip_id is the key; boot_id is the
// boot the trip started in. Start and end come from the trusted fixes inside the trip's span.
export default defineEventHandler(async (event) => {
  const v = await vehicleScope(event)
  const trips = await queryTsdbObjects(`
    WITH recent AS (
      SELECT * FROM v_trip_summary t${v.where('t')} ORDER BY t.started_at DESC LIMIT 5
    ), fixes AS (
      SELECT r.trip_id, p.lat, p.lon,
        row_number() OVER (PARTITION BY r.trip_id ORDER BY p.observed_at ASC, p.mono_ms ASC) AS rn_first,
        row_number() OVER (PARTITION BY r.trip_id ORDER BY p.observed_at DESC, p.mono_ms DESC) AS rn_last
      FROM recent r
      JOIN v_position_trusted p
        ON p.vehicle_id = r.vehicle_id AND p.observed_at BETWEEN r.started_at AND r.ended_at
      WHERE p.trusted AND p.lat != 0 AND p.lon != 0
    )
    SELECT r.*,
      r.duration_ms / 1000.0 AS duration_s,
      r.max_obd_speed_kph AS max_speed_kph,
      r.started_at AS start_time,
      f1.lat AS start_lat, f1.lon AS start_lon,
      f2.lat AS end_lat, f2.lon AS end_lon
    FROM recent r
    LEFT JOIN fixes f1 ON f1.trip_id = r.trip_id AND f1.rn_first = 1
    LEFT JOIN fixes f2 ON f2.trip_id = r.trip_id AND f2.rn_last = 1
    ORDER BY r.started_at DESC
  `)

  return { trips }
})
