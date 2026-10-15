import { timingSafeEqual } from 'node:crypto'

export default defineEventHandler(async (event) => {
  const { passphrase } = await readBody<{ passphrase?: string }>(event)
  if (typeof passphrase !== 'string') {
    throw createError({ statusCode: 400, statusMessage: 'passphrase is required' })
  }

  const expected = useRuntimeConfig().authPassphrase as string
  if (!expected) {
    throw createError({ statusCode: 503, statusMessage: 'passphrase auth not configured' })
  }

  await guardAttempts(event, 'passphrase', async () => {
    const a = Buffer.from(passphrase)
    const b = Buffer.from(expected)
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw createError({ statusCode: 401, statusMessage: 'wrong passphrase' })
    }
  })

  startSession(event, 'owner', null, 'passphrase')
  audit(event, 'login', null, 'owner', 'passphrase')
  return { ok: true }
})
