import { AnnotationError, checkBoot } from '../../utils/annotations'

export default defineEventHandler((event) => {
  try {
    const id = checkBoot(getRouterParam(event, 'bootId'))
    return { annotation: getAnnotations().get(id) ?? { boot_id: id, bookmarked: false, note: null, tags: [], updated_at: 0 } }
  } catch (e) {
    if (e instanceof AnnotationError) throw createError({ statusCode: 400, statusMessage: e.message })
    throw e
  }
})
