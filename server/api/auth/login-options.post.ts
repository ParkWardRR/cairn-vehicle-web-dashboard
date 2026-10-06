import { generateAuthenticationOptions } from '@simplewebauthn/server'

export default defineEventHandler(async (event) => {
  requireJson(event)
  const { rpID } = webauthnConfig(event)
  const creds = authStore().credentials()
  if (!creds.length) throw createError({ statusCode: 409, statusMessage: 'no passkey is enrolled yet' })
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'required',
    allowCredentials: creds.map(c => ({ id: c.id, transports: c.transports as any })),
  })
  return { challengeId: putChallenge(options.challenge, 'login', 'owner'), options }
})
