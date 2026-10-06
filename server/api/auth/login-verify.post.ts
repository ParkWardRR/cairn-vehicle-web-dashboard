import type { H3Event } from 'h3'
import { verifyAuthenticationResponse } from '@simplewebauthn/server'

export default defineEventHandler((event) => {
  requireJson(event)
  return guardAttempts(event, 'login', () => handle(event))
})

async function handle(event: H3Event) {
  const body = await readBody(event)
  const ch = takeChallenge(body?.challengeId, 'login')
  const { rpID, origins } = webauthnConfig(event)
  const cred = authStore().credential(String(body?.response?.id ?? ''))
  if (!cred) {
    audit(event, 'login-failed', 'unknown passkey', 'anonymous', 'none')
    throw createError({ statusCode: 401, statusMessage: 'passkey not recognised' })
  }
  try {
    const v = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: ch.challenge,
      expectedOrigin: origins,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: { id: cred.id, publicKey: cred.public_key as Uint8Array<ArrayBuffer>, counter: cred.counter, transports: cred.transports as any },
    })
    if (!v.verified) throw new Error('not verified')
    authStore().touchCredential(cred.id, v.authenticationInfo.newCounter)
  } catch {
    audit(event, 'login-failed', cred.name, 'anonymous', 'none')
    throw createError({ statusCode: 401, statusMessage: 'passkey rejected' })
  }
  startSession(event, 'owner', cred.id)
  audit(event, 'login', cred.name, 'owner', 'passkey')
  return { ok: true }
}
