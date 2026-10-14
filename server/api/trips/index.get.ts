// The trip list.
//
// Reads v_trip_summary, which is one row per TRIP -- an outing, meaning consecutive
// drives merged across any stop shorter than the store's threshold. It used to read
// v_drive_summary, which is one row per (vehicle, boot), and boot is an artifact of
// when the car cut power to the dongle rather than a fact about the driving.
//
// That was wrong in both directions, and a real errand showed both at once: home ->
// Trader Joe's -> Pavillions -> home listed as two trips, because the shop stop
// switched the ignition off and started a new boot, while the two legs that happened
// to share a boot collapsed into one row whose span covered the stop between them --
// claiming seven hours.
//
// start_time comes from the trip's own started_at rather than from a first-position
// join. The old join keyed on (vehicle_id, boot_id) and picked the earliest fix of a
// boot, which for a trip spanning boots is the earliest fix of whichever boot the
// join happened to match. started_at is the trip's first observation by definition,
// and it exists even when the trip has no GNSS fix at all.
export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const limit = Math.min(Math.max(parseInt(String(query.limit ?? '20'), 10) || 20, 1), 200)
  const offset = Math.max(parseInt(String(query.offset ?? '0'), 10) || 0, 0)
  const sortParam = String(query.sort ?? '-started_at')
  const desc = sortParam.startsWith('-')
  const sortCol = sortParam.replace(/^-/, '')
  // observed_at is kept as an accepted alias so existing links and bookmarks that
  // sort by it keep working; it means the trip's start.
  const allowed = ['started_at', 'observed_at', 'duration_ms', 'driving_ms', 'distance_m', 'max_obd_speed_kph', 'max_rpm', 'trip_id']
  const requested = allowed.includes(sortCol) ? sortCol : 'started_at'
  const orderBy = requested === 'observed_at' ? 'started_at' : requested
  const dir = desc ? 'DESC' : 'ASC'
  const v = await vehicleScope(event)

  const trips = await queryTsdbObjects(`
    SELECT t.*,
      t.started_at AS start_time,
      first_fix.lat AS start_lat,
      first_fix.lon AS start_lon
    FROM v_trip_summary t
    LEFT JOIN (
      SELECT vehicle_id, trip_started_at, lat, lon FROM (
        SELECT p.vehicle_id, s.started_at AS trip_started_at, p.lat, p.lon,
               row_number() OVER (PARTITION BY s.vehicle_id, s.started_at
                                  ORDER BY p.observed_at ASC) AS rn
        FROM position p
        JOIN v_trip_summary s
          ON s.vehicle_id = p.vehicle_id
         AND p.observed_at BETWEEN s.started_at AND s.ended_at
        WHERE p.lat != 0 AND p.lon != 0
      ) WHERE rn = 1
    ) first_fix
      ON first_fix.vehicle_id = t.vehicle_id AND first_fix.trip_started_at = t.started_at
    ${v.where('t')}
    ORDER BY ${orderBy} ${dir}
    LIMIT ${limit} OFFSET ${offset}
  `)

  const countResult = await queryTsdbObjects(`SELECT count(*) AS total FROM v_trip_summary${v.where()}`)

  return { trips, total: countResult[0]?.total ?? 0 }
})
