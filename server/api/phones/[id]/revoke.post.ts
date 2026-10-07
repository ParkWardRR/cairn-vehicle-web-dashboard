// Stops a phone for good: its next request, and any token it holds, is refused. It needs a passkey
// used in the last five minutes (a Tailnet address or the service token is never enough), and the
// trail records who did it and which phone by name.
export default defineEventHandler(async (event) => {
  const id = requireFresh(event)
  const phoneId = (getRouterParam(event, 'id') ?? '').toLowerCase()
  if (!/^[0-9a-f]{32}$/.test(phoneId)) throw createError({ statusCode: 400, statusMessage: 'that is not a phone id' })
  const body = (await readBody(event).catch(() => ({}))) as { reason?: unknown } | null
  const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 80) : ''

  let name = phoneId.slice(0, 8)
  try {
    const list = await localGet<{ clients: LocalClient[] }>('/v1/local/clients')
    const found = list.clients?.find(c => c.id === phoneId)
    if (!found) throw createError({ statusCode: 404, statusMessage: 'no such phone' })
    name = found.name?.trim() || name
    await localPost(`/v1/local/clients/${phoneId}/revoke`, { reason, actor: id.actor })
  } catch (e: any) {
    if (e?.statusCode === 404 || e?.status === 404) throw createError({ statusCode: 404, statusMessage: 'no such phone' })
    if (e?.statusCode) throw e
    throw createError({ statusCode: 502, statusMessage: 'cairn-server would not revoke the phone' })
  }
  audit(event, 'phone-revoked', name)
  return { ok: true }
})
