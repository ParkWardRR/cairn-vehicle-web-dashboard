// "Networks seen here" for a saved place: access points the learned map puts inside the
// place's circle, and those heard in unfixed scans as trips left from or arrived at it.
// Counts and when last seen; never names (none are recorded). Attaching one is a PATCH
// of the place's `bssids`.
export default defineEventHandler(async (event) => {
  const id = Number(getRouterParam(event, 'id'))
  if (!Number.isInteger(id)) throw createError({ statusCode: 400, statusMessage: 'bad id' })
  const resolver = getPlaceResolver()
  const place = resolver.saved.get(id)
  if (!place) throw createError({ statusCode: 404, statusMessage: 'No such saved place' })

  const cap = await wifiCapability()
  const endsSql = cap.unfixed ? endpointObsSql(endpointWindows(place, resolver.store.allVisits())) : null
  const [learned, ends] = await Promise.all([
    cap.learned ? wifiQuery(learnedNearSql(place)) : Promise.resolve([]),
    endsSql ? wifiQuery(endsSql) : Promise.resolve([]),
  ])

  return {
    available: cap.learned || cap.unfixed,
    place_id: place.id,
    radius_m: place.radius_m,
    attached: place.bssids,
    networks: mergeCandidates(place, learned, ends),
  }
})
