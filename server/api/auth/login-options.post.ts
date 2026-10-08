import { generateAuthenticationOptions } from '@simplewebauthn/server'

// `{ discoverable: true }` asks for a request that names no credential, so the phone or browser
// offers whatever passkeys it holds for this site: what Safari's autofill and an iOS app's native
// sign-in sheet use, and what lets someone sign in without knowing which device made the passkey.
export default defineEventHandler(async (event) => {
  requireJson(event)
  const body = await readBody(event).catch(() => null)
  const discoverable = body?.discoverable === true
  const { rpID } = webauthnConfig(event)
  const creds = authStore().credentials()
  if (!creds.length) throw createError({ statusCode: 409, statusMessage: 'no passkey is enrolled yet' })
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'required',
    ...(discoverable ? {} : { allowCredentials: creds.map(c => ({ id: c.id, transports: c.transports as any })) }),
  })
  // an autofill prompt can wait a while for a tap; a modal one cannot
  return { challengeId: putChallenge(options.challenge, 'login', 'owner', discoverable ? 5 * 60_000 : undefined), options }
})
