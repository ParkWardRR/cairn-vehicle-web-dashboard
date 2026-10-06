import { AnnotationError, AnnotationStore } from '../../utils/annotations'
import { SavedPlaceError, SavedPlaces } from '../../utils/placeSaved'

// Restores a file from /api/data/export. A merge, safe to repeat: places already there are
// skipped and a trip's marks are replaced only by a newer copy. Both parts are checked before
// either is applied, so a bad file changes nothing.
export default defineEventHandler(async (event) => {
  requireJson(event)
  const body = await readBody(event)
  if (body?.kind !== 'cairn-data' || body?.version !== 1) throw createError({ statusCode: 400, statusMessage: 'not a Cairn data export' })
  if (body.saved_places?.version !== 1 || !Array.isArray(body.saved_places?.saved)) throw createError({ statusCode: 400, statusMessage: 'the saved places part is not valid' })
  if (body.trip_marks?.version !== 1 || !Array.isArray(body.trip_marks?.annotations)) throw createError({ statusCode: 400, statusMessage: 'the trip marks part is not valid' })
  try {
    // each part is first applied to an empty scratch store, which throws on anything invalid
    new SavedPlaces(':memory:').importAll(body.saved_places)
    new AnnotationStore(':memory:').import(body.trip_marks)
    const saved_places = getPlaceResolver().saved.importAll(body.saved_places)
    const changed = getAnnotations().import(body.trip_marks)
    return { ok: true, saved_places, trip_marks: { changed } }
  } catch (e) {
    if (e instanceof SavedPlaceError || e instanceof AnnotationError) throw createError({ statusCode: 400, statusMessage: e.message })
    throw e
  }
})
