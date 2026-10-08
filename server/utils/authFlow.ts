import type { H3Event } from 'h3'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { parseList } from './authPolicy'

// Shared by the passkey endpoints: where WebAuthn is allowed to happen, the one-shot
// challenges, and the session cookie.

export function webauthnConfig(event: H3Event): { rpID: string; origins: string[] } {
  const c = useRuntimeConfig()
  let origins = parseList(c.authOrigins as string)
  if (!origins.length) {
    // Only a local, unproxied run may guess its own origin. A real host names it.
    const host = getRequestHeader(event, 'host') ?? ''
    const name = host.replace(/:\d+$/, '')
    if (name !== 'localhost' && name !== '127.0.0.1') {
      throw createError({ statusCode: 503, statusMessage: 'passkeys are not configured (set NUXT_AUTH_ORIGINS)' })
    }
    origins = [`http://${host}`]
  }
  const rpID = (c.authRpId as string) || new URL(origins[0]).hostname
  return { rpID, origins }
}

interface Challenge { challenge: string; kind: 'register' | 'login'; expires: number; actor: string }
const challenges = new Map<string, Challenge>()

// `ttlMs` is longer for passkey autofill, where the prompt may sit on screen while someone types elsewhere.
export function putChallenge(challenge: string, kind: Challenge['kind'], actor: string, ttlMs = 2 * 60_000): string {
  const now = Date.now()
  for (const [k, v] of challenges) if (v.expires < now) challenges.delete(k)
  const id = randomBytes(16).toString('base64url')
  challenges.set(id, { challenge, kind, expires: now + ttlMs, actor })
  return id
}

// Single use: a challenge is gone whether or not the response verifies.
export function takeChallenge(id: unknown, kind: Challenge['kind']): Challenge {
  const ch = typeof id === 'string' ? challenges.get(id) : undefined
  if (typeof id === 'string') challenges.delete(id)
  if (!ch || ch.kind !== kind || ch.expires < Date.now()) {
    throw createError({ statusCode: 400, statusMessage: 'challenge expired; start again' })
  }
  return ch
}

export function sameSecret(a: unknown, b: string | null): boolean {
  if (typeof a !== 'string' || !b) return false
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export function startSession(event: H3Event, actor: string, credentialId: string | null): void {
  const days = Number(useRuntimeConfig().authSessionDays) || 30
  const old = getCookie(event, SESSION_COOKIE)
  if (old) authStore().endSession(old)
  const token = authStore().createSession(actor, days, credentialId)
  setCookie(event, SESSION_COOKIE, token, {
    httpOnly: true, sameSite: 'strict', secure: isHttps(event), path: '/', maxAge: days * 86_400,
  })
}

export function requireHuman(event: H3Event) {
  const id = requireIdentity(event)
  if (id.method === 'service') throw createError({ statusCode: 403, statusMessage: 'this credential is read-only' })
  return id
}
