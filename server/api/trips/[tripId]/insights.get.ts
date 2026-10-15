interface Insight {
  label: string
  value: string
  unit?: string
  detail?: string
  icon?: string
  category: 'drive' | 'performance' | 'quality'
}

function fmt(n: number, decimals = 1): string {
  return n.toFixed(decimals)
}

export default defineEventHandler(async (event) => {
  const tripId = getRouterParam(event, 'tripId')
  if (!tripId) throw createError({ statusCode: 400, statusMessage: 'tripId required' })
  const trip = await resolveTrip(tripId)

  const [
    summary,
    distance,
    elevation,
    peakBoost,
    topRpm,
    wotPulls,
    lambdaStats,
    gpsQuality,
    coolant,
    idleTime,
  ] = await Promise.all([
    queryTsdbObjects(`SELECT coalesce(driving_ms, duration_ms) / 1000.0 AS duration_s, max_obd_speed_kph AS max_speed_kph, max_rpm, obd_samples FROM v_trip_summary WHERE trip_id = ${sqlString(trip.tripId)}`),

    // distance from position speed integration
    queryTsdbObjects(`
      SELECT coalesce(sum(
        speed_mps * least(greatest(epoch_ms(lead_at) - epoch_ms(observed_at), 0), 10000) / 1000.0
      ), 0) AS distance_m
      FROM (
        SELECT observed_at, speed_mps,
          lead(observed_at) OVER (ORDER BY observed_at, mono_ms) AS lead_at
        FROM ${tripPositions(trip)} WHERE ${trip.where()} AND speed_mps IS NOT NULL
      ) WHERE lead_at IS NOT NULL
    `),

    // elevation gain/loss
    queryTsdbObjects(`
      SELECT
        sum(CASE WHEN alt_diff > 0 THEN alt_diff ELSE 0 END) AS gain_m,
        sum(CASE WHEN alt_diff < 0 THEN abs(alt_diff) ELSE 0 END) AS loss_m
      FROM (
        SELECT alt_m - lag(alt_m) OVER (ORDER BY observed_at, mono_ms) AS alt_diff
        FROM ${tripPositions(trip)} WHERE ${trip.where()} AND alt_m IS NOT NULL
      )
    `),

    // peak boost
    queryTsdbObjects(`SELECT max(boost_psi) AS peak_boost_psi FROM boost WHERE ${trip.where()} AND boost_psi IS NOT NULL`),

    // top RPM
    queryTsdbObjects(`SELECT max(rpm) AS max_rpm FROM obd WHERE ${trip.where()} AND rpm IS NOT NULL`),

    // WOT pulls
    queryTsdbObjects(`SELECT count(*) AS cnt FROM v_pulls p JOIN v_boot_start bs ON bs.vehicle_id = p.vehicle_id AND bs.boot_id = p.boot_id WHERE p.vehicle_id = ${trip.vehicleSql} AND bs.started_at BETWEEN ${trip.startSql} AND ${trip.endSql}`),

    // average lambda
    queryTsdbObjects(`SELECT avg(lambda_ratio) AS avg_lambda FROM boost WHERE ${trip.where()} AND lambda_ratio IS NOT NULL`),

    // GPS quality — percentage of position samples with nonzero lat/lon
    queryTsdbObjects(`
      SELECT
        count(*) AS total,
        count(*) FILTER (WHERE lat != 0 AND lon != 0) AS good
      FROM position WHERE ${trip.where()}
    `),

    // coolant temp range
    queryTsdbObjects(`SELECT min(coolant_c) AS min_c, max(coolant_c) AS max_c FROM obd WHERE ${trip.where()} AND coolant_c IS NOT NULL`),

    // idle time — percentage of OBD samples under 5 kph
    queryTsdbObjects(`
      SELECT
        count(*) AS total,
        count(*) FILTER (WHERE speed_kph < 5) AS idle
      FROM obd WHERE ${trip.where()} AND speed_kph IS NOT NULL
    `),
  ])

  if (!summary.length) throw createError({ statusCode: 404, statusMessage: 'Trip not found' })

  const insights: Insight[] = []
  const s = summary[0]

  // ── Drive ──────────────────────────────────────────────────────────

  const distM = distance[0]?.distance_m
  if (distM != null && distM > 0) {
    const distMi = distM / 1609.344
    const distKm = distM / 1000
    insights.push({
      label: 'Distance',
      value: fmt(distMi),
      unit: 'mi',
      detail: `${fmt(distKm)} km`,
      icon: 'road',
      category: 'drive',
    })

    if (s.duration_s > 0) {
      const avgMph = (distM / s.duration_s) * 2.23694
      const avgKph = (distM / s.duration_s) * 3.6
      insights.push({
        label: 'Avg speed',
        value: fmt(avgMph, 0),
        unit: 'mph',
        detail: `${fmt(avgKph, 0)} kph`,
        icon: 'gauge',
        category: 'drive',
      })
    }
  }

  if (s.max_speed_kph != null && s.max_speed_kph > 0) {
    const topMph = s.max_speed_kph / 1.60934
    insights.push({
      label: 'Top speed',
      value: fmt(topMph, 0),
      unit: 'mph',
      detail: `${fmt(s.max_speed_kph, 0)} kph`,
      icon: 'speedometer',
      category: 'drive',
    })
  }

  const gain = elevation[0]?.gain_m
  const loss = elevation[0]?.loss_m
  if (gain != null && gain > 0) {
    const gainFt = gain * 3.28084
    insights.push({
      label: 'Elevation gain',
      value: fmt(gainFt, 0),
      unit: 'ft',
      detail: `${fmt(gain, 0)} m`,
      icon: 'mountain',
      category: 'drive',
    })
  }
  if (loss != null && loss > 0) {
    const lossFt = loss * 3.28084
    insights.push({
      label: 'Elevation loss',
      value: fmt(lossFt, 0),
      unit: 'ft',
      detail: `${fmt(loss, 0)} m`,
      icon: 'valley',
      category: 'drive',
    })
  }

  const idleTotal = idleTime[0]?.total
  const idleCount = idleTime[0]?.idle
  if (idleTotal != null && idleTotal > 0) {
    const pct = (idleCount / idleTotal) * 100
    insights.push({
      label: 'Idle time',
      value: fmt(pct, 0),
      unit: '%',
      detail: `Time spent under 3 mph`,
      icon: 'pause',
      category: 'drive',
    })
  }

  // ── Performance ───────────────────────────────────────────────────

  const boost = peakBoost[0]?.peak_boost_psi
  if (boost != null && boost > 0) {
    insights.push({
      label: 'Peak boost',
      value: fmt(boost),
      unit: 'psi',
      icon: 'turbo',
      category: 'performance',
    })
  }

  const rpm = topRpm[0]?.max_rpm ?? s.max_rpm
  if (rpm != null && rpm > 0) {
    insights.push({
      label: 'Top RPM',
      value: fmt(rpm, 0),
      unit: 'rpm',
      icon: 'tachometer',
      category: 'performance',
    })
  }

  const pullCount = wotPulls[0]?.cnt
  if (pullCount != null && pullCount > 0) {
    insights.push({
      label: 'WOT pulls',
      value: String(pullCount),
      detail: pullCount === 1 ? 'full-throttle pull detected' : 'full-throttle pulls detected',
      icon: 'rocket',
      category: 'performance',
    })
  }

  const avgLambda = lambdaStats[0]?.avg_lambda
  if (avgLambda != null) {
    const richLean = avgLambda < 1.0 ? 'rich' : avgLambda > 1.0 ? 'lean' : 'stoich'
    insights.push({
      label: 'Avg lambda',
      value: fmt(avgLambda, 3),
      detail: `Running ${richLean}`,
      icon: 'flame',
      category: 'performance',
    })
  }

  const minC = coolant[0]?.min_c
  const maxC = coolant[0]?.max_c
  if (minC != null && maxC != null) {
    const minF = minC * 9 / 5 + 32
    const maxF = maxC * 9 / 5 + 32
    insights.push({
      label: 'Coolant range',
      value: `${fmt(minF, 0)}–${fmt(maxF, 0)}`,
      unit: '°F',
      detail: `${fmt(minC, 0)}–${fmt(maxC, 0)} °C`,
      icon: 'thermometer',
      category: 'performance',
    })
  }

  // ── Data Quality ──────────────────────────────────────────────────

  const gpsTotal = gpsQuality[0]?.total
  const gpsGood = gpsQuality[0]?.good
  if (gpsTotal != null && gpsTotal > 0) {
    const pct = (gpsGood / gpsTotal) * 100
    insights.push({
      label: 'GPS quality',
      value: fmt(pct, 0),
      unit: '%',
      detail: `${gpsGood} of ${gpsTotal} fixes with position`,
      icon: 'satellite',
      category: 'quality',
    })
  }

  return { insights }
})
