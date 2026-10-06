import { AnnotationError } from '../../utils/annotations'

// Sets any of { bookmarked, note, tags } for a trip; what is not sent is left as it was.
export default defineEventHandler(async (event) => {
  requireJson(event)
  const body = await readBody(event)
  try {
    return { annotation: getAnnotations().set(getRouterParam(event, 'bootId') ?? '', { bookmarked: body?.bookmarked, note: body?.note, tags: body?.tags }) }
  } catch (e) {
    if (e instanceof AnnotationError) throw createError({ statusCode: 400, statusMessage: e.message })
    throw e
  }
})
