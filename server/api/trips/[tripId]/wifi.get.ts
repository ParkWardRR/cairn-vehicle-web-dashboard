// Where the car was while GNSS had no fix, from the Wi-Fi access points it heard: the
// trip's span and ten minutes either side (never reaching into the car's previous or next
// trip), so a cold start from home shows. Estimates only; the track, the stops and every
// figure on the page come from GNSS alone. See server/utils/wifiPositions.ts.
export default defineEventHandler(async (event) => {
  const tripId = getRouterParam(event, 'tripId')
  if (!tripId) throw createError({ statusCode: 400, statusMessage: 'tripId required' })
  const trip = await resolveTrip(tripId)

  const cap = await wifiCapability()
  if (!cap.unfixed) {
    // An older store: no Wi-Fi data to show, which is not an error.
    return { available: false, estimates: [], scans: 0, unresolved: 0, pending: false, attribution: [] }
  }

  const window = await tripWifiWindow(trip)
  const { scans, aps } = await unfixedScansIn(window)
  const { saved } = getPlaceResolver()
  const r = resolveScans(scans, aps, saved, getBeaconDb())

  return {
    available: true,
    window: { from: window.from, to: window.to },
    estimates: groupEstimates(r.estimates),
    scans: scans.length,
    unresolved: r.unresolved,
    pending: r.pending,
    attribution: wifiAttribution(r.sources),
  }
})
