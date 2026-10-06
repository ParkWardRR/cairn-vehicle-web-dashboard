// Pure rules for the auth middleware, so they can be unit-tested without a server.

export interface HeaderBag { get(name: string): string | null | undefined }

const PUBLIC_EXACT = new Set(['/login', '/favicon.svg', '/favicon.ico', '/apple-touch-icon.svg', '/site.webmanifest'])

// Reachable without a session. /api/auth/* does its own checks inside each handler.
// Bundles and static files hold no data; every page and every other route needs an identity.
export function isPublicPath(path: string): boolean {
  if (PUBLIC_EXACT.has(path)) return true
  if (path.startsWith('/_nuxt/')) return true
  if (path === '/api/auth' || path.startsWith('/api/auth/')) return true
  return false
}

export function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/')
}

export const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

// A browser always says where a cross-site request came from (Origin, Sec-Fetch-Site), so a
// request that names another origin is refused even when it carries ambient credentials: a
// Tailnet identity belongs to the machine, not to the page that asked. A request that names
// neither is not from a browser page and cannot be a forged form post.
export function csrfRefusal(method: string, headers: HeaderBag): string | null {
  if (SAFE_METHODS.has(method.toUpperCase())) return null
  const site = headers.get('sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') return `cross-site request (${site})`
  const origin = headers.get('origin')
  if (origin && origin !== 'null') {
    let originHost = ''
    try { originHost = new URL(origin).host } catch { return 'malformed Origin' }
    const host = headers.get('x-forwarded-host') ?? headers.get('host') ?? ''
    if (originHost !== host) return 'Origin does not match Host'
  } else if (origin === 'null') {
    return 'opaque Origin'
  }
  return null
}

function isLoopback(ip: string | undefined): boolean {
  if (!ip) return false
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip.startsWith('127.')
}

// The client address. A proxy on this machine (Caddy) is trusted to say who it is proxying
// for; anything else is the peer itself, so a LAN client cannot claim another address.
export function clientIp(peer: string | undefined, forwardedFor: string | null | undefined): string | null {
  if (isLoopback(peer) && forwardedFor) {
    const last = forwardedFor.split(',').map(s => s.trim()).filter(Boolean).pop()
    if (last) return last.replace(/^::ffff:/, '')
  }
  return peer ? peer.replace(/^::ffff:/, '') : null
}

// Whether an address is in the ranges Tailscale hands out (100.64.0.0/10 and fd7a:115c:a1e0::/48).
export function isTailnetAddress(ip: string | null | undefined): boolean {
  if (!ip) return false
  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(ip.replace(/^::ffff:/, ''))
  if (v4) return Number(v4[1]) === 100 && Number(v4[2]) >= 64 && Number(v4[2]) <= 127
  return ip.toLowerCase().startsWith('fd7a:115c:a1e0:')
}

export function trustsProxy(peer: string | undefined): boolean {
  return isLoopback(peer)
}

export function parseList(v: string | undefined | null): string[] {
  return (v ?? '').split(',').map(s => s.trim()).filter(Boolean)
}

// The tailscaled LocalAPI answers whois for a tailnet address. Only a person's own device
// counts: tagged devices have no user, so they never match an allowlisted login.
export function tailnetLogin(whois: any): string | null {
  if (!whois || typeof whois !== 'object') return null
  if (Array.isArray(whois.Node?.Tags) && whois.Node.Tags.length) return null
  const login = whois.UserProfile?.LoginName
  return typeof login === 'string' && login ? login.toLowerCase() : null
}

export function bearerToken(headers: HeaderBag): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(headers.get('authorization') ?? '')
  return m ? m[1] : null
}
