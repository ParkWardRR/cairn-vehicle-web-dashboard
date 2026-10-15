// Home-page totals. Read from v_trip_summary, the same one-row-per-trip surface the trip list
// shows, so "17 trips" here is "17 trips" there. It used to read v_drive_summary, one row per
// boot, which counted a shop stop that cut the ignition as a second trip and disagreed with the
// list. Duration is the trip's wall-clock span, as the list shows it; a trip belongs to the day it
// started.
export default defineEventHandler(async (event) => {
  const v = await vehicleScope(event)
  const since = (clause: string) => queryTsdbObjects(`
    SELECT count(*) AS trips,
      coalesce(sum(duration_ms), 0) / 1000.0 AS duration_s,
      coalesce(max(max_obd_speed_kph), 0) AS max_speed_kph
    FROM v_trip_summary
    WHERE started_at >= ${clause}${v.and()}
  `)

  const [allTime, today, week, month] = await Promise.all([
    queryTsdbObjects(`
      SELECT count(*) AS total_trips,
        coalesce(sum(duration_ms), 0) / 1000.0 AS total_duration_s,
        coalesce(max(max_obd_speed_kph), 0) AS max_speed_kph,
        coalesce(sum(distance_m), 0) AS total_distance_m
      FROM v_trip_summary${v.where()}
    `),
    since('current_date'),
    since('current_date - INTERVAL 7 DAY'),
    since('current_date - INTERVAL 30 DAY'),
  ])

  return {
    allTime: allTime[0],
    today: today[0],
    week: week[0],
    month: month[0],
  }
})
