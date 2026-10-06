import { AnnotationError } from '../../utils/annotations'

// Merges an export back in. Safe to repeat: a trip's marks are replaced only by a newer copy.
export default defineEventHandler(async (event) => {
  requireJson(event)
  try {
    return { ok: true, changed: getAnnotations().import(await readBody(event)) }
  } catch (e) {
    if (e instanceof AnnotationError) throw createError({ statusCode: 400, statusMessage: e.message })
    throw e
  }
})
