// What phones, trips and the dashboard have done lately, in plain words, newest first.
export default defineEventHandler(async (event) => {
  requireHuman(event)
  setResponseHeader(event, 'Cache-Control', 'no-store')
  const api = localApi()
  if ('missing' in api) return { configured: false, events: [] }
  const q = getQuery(event)
  const days = Math.min(Math.max(Number(q.days) || 7, 1), 31)
  try {
    const [clients, activity] = await Promise.all([
      localGet<{ clients: LocalClient[] }>('/v1/local/clients'),
      localGet<{ activity: ServerAudit[] }>(`/v1/local/activity?days=${days}&limit=500`),
    ])
    const since = Date.now() - days * 86_400_000
    const mine = authStore().auditTrail(300).filter(r => r.ts >= since)
    return { configured: true, events: mergeActivity(activity.activity ?? [], mine, phoneNames(clients.clients ?? [])) }
  } catch {
    throw createError({ statusCode: 502, statusMessage: 'cairn-server would not share its activity' })
  }
})
