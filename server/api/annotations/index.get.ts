// Bookmarks, tags and notes on trips. ?tag=…  ?bookmarked=1
export default defineEventHandler((event) => {
  const q = getQuery(event)
  return {
    annotations: getAnnotations().list({
      tag: typeof q.tag === 'string' && q.tag ? q.tag.toLowerCase() : undefined,
      bookmarked: q.bookmarked === undefined ? undefined : q.bookmarked === '1' || q.bookmarked === 'true',
    }),
    tags: getAnnotations().tags(),
  }
})
