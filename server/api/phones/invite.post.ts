import { renderSVG } from 'uqr'

// Makes a single-use phone invitation and the QR code that carries it. An invitation lets a
// phone read every trip, so it needs a passkey used in the last five minutes (a Tailnet
// address or the service token is never enough). The code is returned once, in this response
// only: it is never stored here, never logged, and the audit trail records the device name.
const TTL_SECONDS = 10 * 60

export default defineEventHandler(async (event) => {
  const id = requireFresh(event)
  setResponseHeader(event, 'Cache-Control', 'no-store')

  const cfg = phoneSetupConfig()
  if (!cfg.ok) throw createError({ statusCode: 503, statusMessage: `phone setup is not configured: ${cfg.missing.join(', ')}` })
  const { config } = cfg

  const body = (await readBody(event).catch(() => ({}))) as { name?: unknown } | null
  const name = cleanDeviceName(body?.name) || 'iPhone'

  let invite
  try {
    invite = await mintInvite(config.base, config.token, { name, actor: id.actor, ttlSeconds: TTL_SECONDS })
  } catch {
    throw createError({ statusCode: 502, statusMessage: 'cairn-server would not make an invitation' })
  }

  let link: string
  try {
    link = buildPhoneLink({
      serverUrl: config.serverUrl,
      tailnetUrl: config.tailnetUrl || undefined,
      code: invite.code,
      caDer: config.caFile ? readCaDer(config.caFile) : undefined,
    })
  } catch (e: any) {
    throw createError({ statusCode: 500, statusMessage: `could not build the setup link: ${e?.message ?? 'unknown error'}` })
  }

  audit(event, 'phone-invite', name)
  return {
    link,
    // Black on white whatever the page theme, with a quiet zone, so any camera can read it.
    svg: renderSVG(link, { ecc: 'L', border: 2, whiteColor: '#ffffff', blackColor: '#000000' }),
    expires_at: invite.expires_at,
    name,
  }
})
