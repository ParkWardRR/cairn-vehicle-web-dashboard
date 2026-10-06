import type { H3Event } from 'h3'
import { verifyRegistrationResponse } from '@simplewebauthn/server'

export default defineEventHandler((event) => {
  requireJson(event)
  return guardAttempts(event, 'register', () => handle(event))
})

async function handle(event: H3Event) {
  const body = await readBody(event)
  const ch = takeChallenge(body?.challengeId, 'register')
  const { rpID, origins } = webauthnConfig(event)
  const store = authStore()
  const first = store.credentials().length === 0
  let info
  try {
    const v = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: ch.challenge,
      expectedOrigin: origins,
      expectedRPID: rpID,
      requireUserVerification: true,
    })
    if (!v.verified || !v.registrationInfo) throw new Error('not verified')
    info = v.registrationInfo
  } catch {
    audit(event, 'enrol-failed', 'passkey', ch.actor, 'none')
    throw createError({ statusCode: 400, statusMessage: 'passkey could not be verified' })
  }
  const name = String(body?.name ?? '').trim().slice(0, 60) || `Passkey ${store.credentials().length + 1}`
  store.addCredential({
    id: info.credential.id,
    public_key: info.credential.publicKey,
    counter: info.credential.counter,
    transports: (info.credential.transports ?? []) as string[],
    name,
  })
  audit(event, 'passkey-added', name, ch.actor, first ? 'enrolment' : 'passkey')
  if (first) {
    store.bootstrapCode('')   // removes the one-time code
    startSession(event, 'owner', info.credential.id)
  }
  return { ok: true, signed_in: first }
}
