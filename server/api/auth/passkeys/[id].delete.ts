// Removing a passkey needs a fresh one, and ends every session it started.
export default defineEventHandler((event) => {
  requireFresh(event)
  const id = getRouterParam(event, 'id') ?? ''
  const cred = authStore().credential(id)
  if (!cred) throw createError({ statusCode: 404, statusMessage: 'No such passkey' })
  authStore().removeCredential(id)
  authStore().endSessionsOf(id)
  audit(event, 'passkey-removed', cred.name)
  return { ok: true }
})
