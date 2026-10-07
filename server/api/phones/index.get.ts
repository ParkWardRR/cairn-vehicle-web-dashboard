// The enrolled phones, working ones first. Readable by anyone signed in; changing them is not.
export default defineEventHandler(async (event) => {
  requireHuman(event)
  setResponseHeader(event, 'Cache-Control', 'no-store')
  const api = localApi()
  if ('missing' in api) return { configured: false, missing: api.missing, phones: [] }
  try {
    const res = await localGet<{ clients: LocalClient[] }>('/v1/local/clients')
    return { configured: true, phones: presentPhones(res.clients ?? []) }
  } catch {
    throw createError({ statusCode: 502, statusMessage: 'cairn-server would not list the phones' })
  }
})
