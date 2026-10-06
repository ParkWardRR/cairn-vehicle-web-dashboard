import { parseDay } from '../../../shared/utils/period'
import { distM } from '../../utils/placeLabel'

// Find trips by what you wrote about them or where they went.
//
//   q          matches a trip's note, its tags, and the names of saved places it visited
//   tag        only trips with this tag          bookmarked=1   only bookmarked trips
//   from, to   trips that started on these days (inclusive, YYYY-MM-DD, UTC)
//   limit, offset
//
// Trips with no filter at all are listed newest first, like /api/trips.
const CAP = 1000

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const text = typeof q.q === 'string' ? q.q.trim().slice(0, 100) : ''
  const tag = typeof q.tag === 'string' ? q.tag.trim().toLowerCase() : ''
  const bookmarked = q.bookmarked === '1' || q.bookmarked === 'true'
  const from = q.from === undefined ? null : parseDay(q.from)
  const to = q.to === undefined ? null : parseDay(q.to)
  if ((q.from !== undefined && !from) || (q.to !== undefined && !to)) throw createError({ statusCode: 400, statusMessage: 'from and to are YYYY-MM-DD' })
  const limit = Math.min(Math.max(parseInt(String(q.limit ?? '20'), 10) || 20, 1), 200)
  const offset = Math.max(parseInt(String(q.offset ?? '0'), 10) || 0, 0)

  const marks = getAnnotations()
  let candidates: Set<string> | null = null
  const narrow = (ids: Iterable<string>) => {
    const s = new Set(ids)
    candidates = candidates ? new Set([...candidates].filter(x => s.has(x))) : s
  }

  if (tag || bookmarked) narrow(marks.list({ tag: tag || undefined, bookmarked: bookmarked || undefined }).map(a => a.boot_id))
  if (text) {
    const hits = new Set(marks.matching(text))
    const needle = text.toLowerCase()
    const resolver = getPlaceResolver()
    const named = resolver.saved.list().filter(p => p.name.toLowerCase().includes(needle))
    if (named.length) {
      for (const v of resolver.store.allVisits()) {
        if (named.some(p => distM(p.lat, p.lon, v.lat, v.lon) <= p.radius_m)) hits.add(v.boot_id)
      }
    }
    narrow(hits)
  }

  const v = await vehicleScope(event)
  const where: string[] = []
  if (candidates) {
    const ids = [...(candidates as Set<string>)].filter(id => /^[0-9a-f]{32}$/.test(id)).slice(0, CAP)
    if (!ids.length) return { trips: [], total: 0, query: { q: text, tag, bookmarked } }
    where.push(`d.boot_id IN (${ids.map(id => `'${id}'`).join(',')})`)
  }
  if (from) where.push(`first_pos.observed_at >= ${sqlString(from.toISOString().slice(0, 10))}::TIMESTAMP`)
  if (to) where.push(`first_pos.observed_at < ${sqlString(new Date(to.getTime() + 86_400_000).toISOString().slice(0, 10))}::TIMESTAMP`)
  const vehicle = v.and('d').replace(/^ AND /, '')
  if (vehicle) where.push(vehicle)
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const base = `
    FROM v_drive_summary d
    LEFT JOIN (
      SELECT vehicle_id, boot_id, observed_at, lat, lon
      FROM (SELECT *, row_number() OVER (PARTITION BY vehicle_id, boot_id ORDER BY mono_ms ASC) AS rn FROM position${v.where()}) WHERE rn = 1
    ) first_pos USING (vehicle_id, boot_id)
    ${clause}`
  const [trips, total] = await Promise.all([
    queryTsdbObjects(`
      SELECT d.*, first_pos.observed_at AS start_time, first_pos.lat AS start_lat, first_pos.lon AS start_lon
      ${base} ORDER BY first_pos.observed_at DESC LIMIT ${limit} OFFSET ${offset}`),
    queryTsdbObjects(`SELECT count(*) AS total ${base}`),
  ])
  const marked = new Map(marks.list().map(a => [a.boot_id, a]))
  return {
    trips: trips.map(t => ({ ...t, annotation: marked.get(t.boot_id) ?? null })),
    total: Number(total[0]?.total ?? 0),
    query: { q: text, tag, bookmarked },
  }
})
