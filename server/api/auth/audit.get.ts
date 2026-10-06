// Who changed what and when. Field names only; a value is never recorded.
export default defineEventHandler((event) => {
  requireHuman(event)
  return { audit: authStore().auditTrail(200) }
})
