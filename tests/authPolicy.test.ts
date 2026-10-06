// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { bearerToken, clientIp, csrfRefusal, isApiPath, isPublicPath, parseList, tailnetLogin, trustsProxy } from '../server/utils/authPolicy'

const h = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null })

describe('which paths are public', () => {
  it('the auth routes, the login page and static bundles only', () => {
    for (const p of ['/login', '/_nuxt/entry.js', '/api/auth/session', '/api/auth/login-verify', '/favicon.svg']) expect(isPublicPath(p), p).toBe(true)
    for (const p of ['/', '/trips', '/api/trips', '/api/heatmap', '/api/places/saved', '/api/authx', '/api/auth-not', '/loginx', '/_payload.json', '/api']) expect(isPublicPath(p), p).toBe(false)
  })
  it('knows an API path', () => {
    expect(isApiPath('/api/trips')).toBe(true)
    expect(isApiPath('/apiary')).toBe(false)
    expect(isApiPath('/trips')).toBe(false)
  })
})

describe('csrfRefusal', () => {
  it('lets reads through whatever they claim', () => {
    expect(csrfRefusal('GET', h({ origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }))).toBeNull()
  })
  it('refuses a cross-site write', () => {
    expect(csrfRefusal('POST', h({ 'sec-fetch-site': 'cross-site', host: 'cairn.lan' }))).toMatch(/cross-site/)
    expect(csrfRefusal('DELETE', h({ 'sec-fetch-site': 'same-site', host: 'cairn.lan' }))).toMatch(/cross-site/)
    expect(csrfRefusal('POST', h({ origin: 'https://evil.example', host: 'cairn.lan' }))).toMatch(/Origin/)
    expect(csrfRefusal('PATCH', h({ origin: 'null', host: 'cairn.lan' }))).toMatch(/opaque/)
    expect(csrfRefusal('POST', h({ origin: 'not a url', host: 'cairn.lan' }))).toMatch(/malformed/)
  })
  it('allows a same-origin write and a non-browser client', () => {
    expect(csrfRefusal('POST', h({ origin: 'https://cairn.lan', host: 'cairn.lan', 'sec-fetch-site': 'same-origin' }))).toBeNull()
    expect(csrfRefusal('POST', h({ origin: 'http://127.0.0.1:3000', host: '127.0.0.1:3000' }))).toBeNull()
    expect(csrfRefusal('POST', h({ host: 'cairn.lan' }))).toBeNull()
    expect(csrfRefusal('POST', h({ 'sec-fetch-site': 'none' }))).toBeNull()
  })
  it('compares against the forwarded host behind the proxy', () => {
    expect(csrfRefusal('POST', h({ origin: 'https://cairn.lan', host: '127.0.0.1:3000', 'x-forwarded-host': 'cairn.lan' }))).toBeNull()
  })
})

describe('clientIp', () => {
  it('trusts a forwarded address only from a proxy on this machine', () => {
    expect(clientIp('127.0.0.1', '100.64.0.7')).toBe('100.64.0.7')
    expect(clientIp('::1', '100.64.0.7')).toBe('100.64.0.7')
    expect(clientIp('::ffff:127.0.0.1', '100.64.0.7')).toBe('100.64.0.7')
  })
  it('ignores a forwarded header from anywhere else', () => {
    expect(clientIp('192.168.1.50', '100.64.0.7')).toBe('192.168.1.50')
    expect(clientIp('::ffff:192.168.1.50', '100.64.0.7')).toBe('192.168.1.50')
  })
  it('takes the address the proxy appended, not one the client supplied', () => {
    expect(clientIp('127.0.0.1', '100.64.0.99, 192.168.1.9')).toBe('192.168.1.9')
  })
  it('falls back to the peer', () => {
    expect(clientIp('127.0.0.1', null)).toBe('127.0.0.1')
    expect(clientIp(undefined, null)).toBeNull()
    expect(trustsProxy('10.0.0.1')).toBe(false)
  })
})

describe('tailnetLogin', () => {
  const node = { Node: { Tags: null }, UserProfile: { LoginName: 'Owner@Example.com' } }
  it('reads the login, lower-cased', () => expect(tailnetLogin(node)).toBe('owner@example.com'))
  it('never matches a tagged device', () => {
    expect(tailnetLogin({ Node: { Tags: ['tag:server'] }, UserProfile: { LoginName: 'tagged-devices' } })).toBeNull()
  })
  it('never matches an unknown or malformed answer', () => {
    for (const w of [null, undefined, 'x', {}, { UserProfile: {} }, { UserProfile: { LoginName: 5 } }]) expect(tailnetLogin(w as any)).toBeNull()
  })
})

describe('small parsers', () => {
  it('parseList', () => expect(parseList(' a, b ,,c ')).toEqual(['a', 'b', 'c']))
  it('bearerToken', () => {
    expect(bearerToken(h({ authorization: 'Bearer abc.def' }))).toBe('abc.def')
    expect(bearerToken(h({ authorization: 'bearer x' }))).toBe('x')
    expect(bearerToken(h({ authorization: 'Basic abc' }))).toBeNull()
    expect(bearerToken(h({}))).toBeNull()
  })
})
