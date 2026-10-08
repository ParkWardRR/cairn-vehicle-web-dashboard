// A trip's GPS track as GeoJSON. The first LineString is the one the map draws and the rest of the
// page reads: both receivers' fixes combined (or, with one source, that source alone). The
// device's and the phone's own tracks follow, each tagged `track`, so the page can show either.
const COLUMNS = 'lat, lon, alt_m, speed_mps, heading_deg, h_acc_m, hdop, sats_used, fix_type, source_flags, mono_ms, observed_at'

function lineFeature(rows: any[], track: 'combined' | 'device' | 'phone', extra: Record<string, unknown> = {}) {
  return {
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: rows.map((p: any) => [p.lon, p.lat, p.alt_m ?? 0]) },
    properties: {
      track,
      speeds: rows.map((p: any) => p.speed_mps),
      timestamps: rows.map((p: any) => p.observed_at),
      headings: rows.map((p: any) => p.heading_deg),
      accuracies: rows.map((p: any) => p.h_acc_m),
      sats: rows.map((p: any) => p.sats_used),
      ...extra,
    },
  }
}

export default defineEventHandler(async (event) => {
  const bootId = getRouterParam(event, 'bootId')
  if (!bootId) throw createError({ statusCode: 400, statusMessage: 'bootId required' })
  const id = sqlString(bootId)

  const raw = await queryTsdbObjects(`
    SELECT ${COLUMNS}
    FROM position
    WHERE boot_id = ${id} AND lat != 0 AND lon != 0
    ORDER BY mono_ms ASC
  `)

  const { device: deviceRaw, phone: phoneRaw } = splitGpsSources(raw as GpsPositionRow[])
  const device = filterOutliers(deviceRaw)
  const phone = filterOutliers(phoneRaw)

  // One source: exactly that source's fixes, as ever. Two: the combined track.
  const both = device.length > 0 && phone.length > 0
  const combined = both ? combineGps(device, phone) : (device.length ? device : phone)

  const gaps = await queryTsdbObjects(`
    SELECT * FROM gap WHERE boot_id = ${id} ORDER BY seq ASC
  `)

  const features: any[] = []

  if (combined.length >= 2) {
    features.push(lineFeature(combined as any[], 'combined', {
      sources: both ? (combined as GpsCombinedPoint[]).map(p => p.source) : undefined,
    }))
  }

  for (const gap of gaps) {
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [0, 0] },
      properties: { type: 'gap', ...gap },
    })
  }

  if (device.length >= 2) features.push(lineFeature(device, 'device'))
  if (phone.length >= 2) features.push(lineFeature(phone, 'phone'))

  return {
    type: 'FeatureCollection',
    features,
    sources: { device: device.length, phone: phone.length },
  }
})
