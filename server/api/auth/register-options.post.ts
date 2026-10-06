import type { H3Event } from 'h3'
import { generateRegistrationOptions } from '@simplewebauthn/server'
import type { Identity } from '../../utils/auth'

// A first passkey: from an allowlisted Tailnet device, or with the one-time code on the host.
// Any later one: only with a passkey used in the last few minutes, so ambient access (a Tailnet
// address, a stolen session) cannot enrol a second way in.
export default defineEventHandler((event) => {
  requireJson(event)
  return guardAttempts(event, 'register', () => handle(event))
})

async function handle(event: H3Event) {
  const body = await readBody(event)
  const store = authStore()
  const id = event.context.cairnIdentity as Identity | undefined
  let actor = 'owner'
  if (store.credentials().length === 0) {
    const cfg = useRuntimeConfig()
    const byCode = sameSecret(body?.bootstrapCode, store.bootstrapCode(cfg.authBootstrapCode as string))
    if (!(id?.method === 'tailnet') && !byCode) {
      audit(event, 'enrol-refused', 'first passkey', 'anonymous', 'none')
      throw createError({ statusCode: 401, statusMessage: 'enrolment needs a Tailnet device or the code on the host' })
    }
    if (id?.method === 'tailnet') actor = id.actor
  } else {
    actor = requireFresh(event).actor
  }
  const { rpID } = webauthnConfig(event)
  const options = await generateRegistrationOptions({
    rpName: 'Cairn',
    rpID,
    userName: 'owner',
    userID: Buffer.from(store.userHandle(), 'base64url'),
    attestationType: 'none',
    excludeCredentials: store.credentials().map(c => ({ id: c.id, transports: c.transports as any })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
  })
  return { challengeId: putChallenge(options.challenge, 'register', actor), options }
}
