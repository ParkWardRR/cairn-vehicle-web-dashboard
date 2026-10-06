import type { H3Event } from 'h3'
import { request as httpRequest } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { AuthStore } from './authStore'
import { bearerToken, clientIp, parseList, tailnetLogin, trustsProxy } from './authPolicy'

// Who is asking. Three ways to be someone, strongest last:
//   service  a bearer token for automation; read-only
//   tailnet  the client's address belongs to an allowlisted person's device on this tailnet
//   passkey  a session started by a WebAuthn assertion; the only kind that can be "fresh"
export interface Identity {
  actor: string
  method: 'service' | 'tailnet' | 'passkey'
  readOnly: boolean
  // Passkey authentication within the last FRESH_MS; secrets-bearing routes need it.
  fresh: boolean
}

export const SESSION_COOKIE = 'cairn_session'
export const FRESH_MS = 5 * 60_000

let store: AuthStore | null = null
export function authStore(): AuthStore {
  if (!store) {
    const c = useRuntimeConfig()
    store = new AuthStore((c.authDataDir as string) || (c.placesDataDir as string))
  }
  return store
}

export function authMode(): 'required' | 'off' {
  return useRuntimeConfig().authMode === 'off' ? 'off' : 'required'
}

export function requestIp(event: H3Event): string | null {
  const peer = event.node.req.socket?.remoteAddress
  return clientIp(peer, getRequestHeader(event, 'x-forwarded-for'))
}

export function isHttps(event: H3Event): boolean {
  const peer = event.node.req.socket?.remoteAddress
  if (trustsProxy(peer) && getRequestHeader(event, 'x-forwarded-proto') === 'https') return true
  return Boolean((event.node.req.socket as any)?.encrypted)
}

// ─── Tailnet ────────────────────────────────────────────────────────────────

const whoisCache = new Map<string, { login: string | null; until: number }>()

function localApiWhois(socketPath: string, ip: string): Promise<any | null> {
  return new Promise((resolve) => {
    const req = httpRequest(
      { socketPath, path: `/localapi/v0/whois?addr=${encodeURIComponent(ip)}`, headers: { Host: 'local-tailscaled.sock' }, timeout: 1500 },
      (res) => {
        let body = ''
        res.on('data', (d) => { body += d })
        res.on('end', () => { try { resolve(res.statusCode === 200 ? JSON.parse(body) : null) } catch { resolve(null) } })
      },
    )
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
    req.end()
  })
}

export async function tailnetIdentity(event: H3Event): Promise<string | null> {
  const c = useRuntimeConfig()
  const allowed = parseList(c.authTailnetUsers as string).map(s => s.toLowerCase())
  const socket = c.authTailscaleSocket as string
  if (!allowed.length || !socket) return null
  const ip = requestIp(event)
  if (!ip) return null
  const hit = whoisCache.get(ip)
  let login: string | null
  if (hit && hit.until > Date.now()) {
    login = hit.login
  } else {
    login = tailnetLogin(await localApiWhois(socket, ip))
    whoisCache.set(ip, { login, until: Date.now() + 60_000 })
  }
  return login && allowed.includes(login) ? login : null
}

// ─── Identity ───────────────────────────────────────────────────────────────

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export async function resolveIdentity(event: H3Event): Promise<Identity | null> {
  // A request the server makes to itself while rendering a page carries the identity that was
  // already established for the page request: nitro hands the outer event's context to the inner
  // request as req.__unenv__, a property only in-process requests have (a client cannot set it).
  const inherited = ((event.node.req as any).__unenv__?.cairnIdentity ?? event.context.cairnIdentity) as Identity | undefined
  if (inherited) return inherited

  const bearer = bearerToken({ get: n => getRequestHeader(event, n as any) })
  if (bearer) {
    const c = useRuntimeConfig()
    const token = authStore().serviceToken(c.authServiceToken as string)
    return sameToken(bearer, token) ? { actor: 'service', method: 'service', readOnly: true, fresh: false } : null
  }

  const cookie = getCookie(event, SESSION_COOKIE)
  if (cookie) {
    const s = authStore().session(cookie)
    if (s) return { actor: s.actor, method: 'passkey', readOnly: false, fresh: Date.now() - s.auth_at <= FRESH_MS }
  }

  const login = await tailnetIdentity(event)
  if (login) return { actor: login, method: 'tailnet', readOnly: false, fresh: false }
  return null
}

// For routes that take a secret or change configuration: a passkey assertion in the last few
// minutes. A Tailnet identity is ambient (it belongs to the machine), so it is never enough.
export function requireFresh(event: H3Event): Identity {
  const id = event.context.cairnIdentity as Identity | undefined
  if (!id) throw createError({ statusCode: 401, statusMessage: 'authentication required' })
  if (id.method !== 'passkey' || !id.fresh) throw createError({ statusCode: 401, statusMessage: 'reauth_required' })
  return id
}

export function requireIdentity(event: H3Event): Identity {
  const id = event.context.cairnIdentity as Identity | undefined
  if (!id) throw createError({ statusCode: 401, statusMessage: 'authentication required' })
  return id
}

export function audit(event: H3Event, action: string, target: string | null = null, actor?: string, method?: string): void {
  const id = event.context.cairnIdentity as Identity | undefined
  authStore().audit(actor ?? id?.actor ?? 'anonymous', method ?? id?.method ?? 'none', action, target)
}

// ─── Attempt limiter ────────────────────────────────────────────────────────

// Counts failures per client address, not attempts: a run of wrong answers is blocked for a few
// minutes, and a success clears the count.
const failures = new Map<string, number[]>()
export async function guardAttempts<T>(event: H3Event, bucket: string, fn: () => Promise<T>, max = 10, windowMs = 5 * 60_000): Promise<T> {
  const key = `${bucket}:${requestIp(event) ?? 'unknown'}`
  const now = Date.now()
  const recent = (failures.get(key) ?? []).filter(t => now - t < windowMs)
  if (recent.length >= max) throw createError({ statusCode: 429, statusMessage: 'too many attempts; wait a few minutes' })
  try {
    const out = await fn()
    failures.delete(key)
    return out
  } catch (e) {
    recent.push(now)
    failures.set(key, recent)
    throw e
  }
}
