import { X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'

// The cairn://configure link the phone app opens: the app listener's URL(s), a single-use
// invitation code and the private CA, so one scan sets the server, trusts its certificate for
// the app's own connections and enrols the phone. The format is mirrored by
//   cairn-vehicle-server  cmd/cairn-admin/configlink.go   (the CLI's `client invite --qr`)
//   cairn-ios-companion-app  CairnCore/Auth/ConfigureLink.swift   (the app that parses it)
// so change all three together.
//
//   cairn://configure?ca=<DER, base64url, unpadded>&code=<code>&tailnet=<https>&url=<https>&v=1
export interface PhoneLink {
  serverUrl: string
  tailnetUrl?: string
  code: string
  caDer?: Buffer
}

export function isHttpsUrl(s: string): boolean {
  try {
    const u = new URL(s)
    return u.protocol === 'https:' && u.hostname !== ''
  } catch {
    return false
  }
}

export function buildPhoneLink(l: PhoneLink): string {
  if (!isHttpsUrl(l.serverUrl)) throw new Error('the phone server URL must be an https:// URL with a host')
  if (l.tailnetUrl && !isHttpsUrl(l.tailnetUrl)) throw new Error('the Tailnet URL must be an https:// URL with a host')
  // Same keys, in the same (sorted) order, as the CLI's url.Values.Encode.
  const q = new URLSearchParams()
  if (l.caDer) q.set('ca', l.caDer.toString('base64url'))
  q.set('code', l.code)
  if (l.tailnetUrl) q.set('tailnet', l.tailnetUrl)
  q.set('url', l.serverUrl)
  q.set('v', '1')
  return `cairn://configure?${q.toString()}`
}

// The CA the phone must trust, as DER. Refuses anything that is not a CA certificate, so a
// leaf or a wrong file can never be embedded as a trust anchor.
export function readCaDer(path: string): Buffer {
  const cert = new X509Certificate(readFileSync(path))
  if (!cert.ca) throw new Error('the CA file does not hold a CA certificate')
  return Buffer.from(cert.raw)
}

export interface LocalInvite {
  code: string
  expires_at: string
}

// Asks cairn-server's loopback API for a user invitation. The API demands the shared write
// token; who may cause this call (a fresh passkey) is decided by the route, not here.
export async function mintInvite(
  base: string, token: string, req: { name: string, actor: string, ttlSeconds: number },
): Promise<LocalInvite> {
  const res = await $fetch<LocalInvite>(`${base.replace(/\/$/, '')}/v1/local/clients/invite`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: { name: req.name, actor: req.actor, ttl_seconds: req.ttlSeconds },
    timeout: 5000,
  })
  if (typeof res?.code !== 'string' || typeof res?.expires_at !== 'string') throw new Error('unexpected invitation reply')
  return res
}

export function cleanDeviceName(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : ''
  return s.slice(0, 64)
}
