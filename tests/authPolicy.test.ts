// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { appleAppIds, bearerToken, clientIp, csrfRefusal, isApiPath, isPublicPath, isTailnetAddress, parseList, tailnetLogin, trustsProxy } from '../server/utils/authPolicy'

const h = (o: Record<string, string>) => ({ get: (n: string) => o[n.toLowerCase()] ?? null })

describe('which paths are public', () => {
  it('the auth routes, the login page and static bundles only', () => {
    for (const p of ['/login', '/_nuxt/entry.js', '/api/auth/session', '/api/auth/login-verify', '/favicon.svg', '/.well-known/apple-app-site-association']) expect(isPublicPath(p), p).toBe(true)
    for (const p of ['/', '/trips', '/api/trips', '/api/heatmap', '/api/places/saved', '/api/authx', '/api/auth-not', '/loginx', '/_payload.json', '/api', '/.well-known/', '/.well-known/apple-app-site-association/x', '/.well-known/other']) expect(isPublicPath(p), p).toBe(false)
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

describe('isTailnetAddress', () => {
  it('knows the ranges Tailscale uses', () => {
    for (const ip of ['100.64.0.1', '100.100.100.100', '100.127.255.254', '::ffff:100.70.92.86', 'fd7a:115c:a1e0::1d37:5c56', 'FD7A:115C:A1E0:ab12::1']) expect(isTailnetAddress(ip), ip).toBe(true)
  })
  it('and nothing else', () => {
    for (const ip of ['100.63.255.255', '100.128.0.1', '172.16.6.80', '192.168.1.5', '127.0.0.1', '::1', 'fd00::1', 'x', '', null, undefined]) expect(isTailnetAddress(ip as any), String(ip)).toBe(false)
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

describe('appleAppIds', () => {
  it('keeps well-formed TEAMID.bundle ids and drops the rest', () => {
    expect(appleAppIds('ABCDE12345.app.cairn.companion, nope, abcde12345.app.x,ABCDE12345.')).toEqual(['ABCDE12345.app.cairn.companion'])
    expect(appleAppIds('')).toEqual([])
    expect(appleAppIds(undefined)).toEqual([])
  })
})
