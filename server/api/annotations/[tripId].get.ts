import { AnnotationError, checkTripId } from '../../utils/annotations'

export default defineEventHandler((event) => {
  try {
    const id = checkTripId(getRouterParam(event, 'tripId'))
    return { annotation: getAnnotations().get(id) ?? { trip_id: id, bookmarked: false, note: null, tags: [], updated_at: 0 } }
  } catch (e) {
    if (e instanceof AnnotationError) throw createError({ statusCode: 400, statusMessage: e.message })
    throw e
  }
})
