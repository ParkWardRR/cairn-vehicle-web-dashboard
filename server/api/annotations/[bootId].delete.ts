import { AnnotationError } from '../../utils/annotations'

export default defineEventHandler((event) => {
  try {
    if (!getAnnotations().remove(getRouterParam(event, 'bootId') ?? '')) throw createError({ statusCode: 404, statusMessage: 'No marks on that trip' })
  } catch (e) {
    if (e instanceof AnnotationError) throw createError({ statusCode: 400, statusMessage: e.message })
    throw e
  }
  return { ok: true }
})
