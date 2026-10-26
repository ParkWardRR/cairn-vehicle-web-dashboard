// Finds an address typed on the Places page, to put a new place there. POST, so it only
// runs when someone presses Find (no search-as-you-type), and it is sent to a lookup
// service only when external lookups are on.
let last = 0

export default defineEventHandler(async (event) => {
  requireJson(event)
  const body = await readBody(event)
  const q = String(body?.q ?? '').trim()
  if (q.length < 3 || q.length > 200) throw createError({ statusCode: 400, statusMessage: 'Type an address of 3 to 200 characters' })

  const c = useRuntimeConfig()
  if (String(c.placesExternal) === 'false') {
    return { external: false, results: [], attribution: [] }
  }
  // At most one search a second, as Nominatim asks.
  const wait = last + 1000 - Date.now()
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
  last = Date.now()
  try {
    const results = await geocodeAddress(q, String(c.geoapifyKey ?? ''))
    return { external: true, results, attribution: attributionFor(results.map(r => r.source)) }
  } catch (e: any) {
    console.error('[places] address search failed:', e?.message ?? e)
    throw createError({ statusCode: 502, statusMessage: 'The address search did not answer; try again, or enter coordinates' })
  }
})
