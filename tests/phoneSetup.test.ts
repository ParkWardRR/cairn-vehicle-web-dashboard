// @vitest-environment node
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildPhoneLink, cleanDeviceName, isHttpsUrl, readCaDer } from '../server/utils/phoneSetup'

const der = Buffer.from([0x30, 0x82, 0x01, 0xfb, 0xff, 0xfe, 0x3e, 0x3f, 0x00])

describe('buildPhoneLink', () => {
  it('carries the server, the code and the CA in the form the app parses', () => {
    const link = buildPhoneLink({ serverUrl: 'https://cairn.alpina.casa:8444', tailnetUrl: 'https://cairn.ts.net', code: 'a9e6-2d47', caDer: der })
    const u = new URL(link)
    expect(`${u.protocol}//${u.hostname}`).toBe('cairn://configure')
    expect(u.searchParams.get('v')).toBe('1')
    expect(u.searchParams.get('url')).toBe('https://cairn.alpina.casa:8444')
    expect(u.searchParams.get('tailnet')).toBe('https://cairn.ts.net')
    expect(u.searchParams.get('code')).toBe('a9e6-2d47')
    // base64url, unpadded: no '+', '/' or '=' that the query string would have to escape
    const ca = u.searchParams.get('ca')!
    expect(ca).not.toMatch(/[+/=]/)
    expect(Buffer.from(ca, 'base64url')).toEqual(der)
  })

  it('lists its keys in the same order as the vehicle server CLI', () => {
    const link = buildPhoneLink({ serverUrl: 'https://h.lan', tailnetUrl: 'https://t.ts.net', code: 'c', caDer: der })
    expect([...new URL(link).searchParams.keys()]).toEqual(['ca', 'code', 'tailnet', 'url', 'v'])
  })

  it('leaves out what it was not given', () => {
    const link = buildPhoneLink({ serverUrl: 'https://h.lan', code: 'c' })
    expect([...new URL(link).searchParams.keys()]).toEqual(['code', 'url', 'v'])
  })

  it('refuses a server the phone would refuse', () => {
    expect(() => buildPhoneLink({ serverUrl: 'http://h.lan', code: 'c' })).toThrow()
    expect(() => buildPhoneLink({ serverUrl: 'cairn.alpina.casa', code: 'c' })).toThrow()
    expect(() => buildPhoneLink({ serverUrl: 'https://h.lan', tailnetUrl: 'http://t', code: 'c' })).toThrow()
  })
})

describe('isHttpsUrl / cleanDeviceName', () => {
  it('accepts only https URLs with a host', () => {
    expect(isHttpsUrl('https://cairn.alpina.casa:8444')).toBe(true)
    for (const s of ['http://x', 'x', 'https://', '']) expect(isHttpsUrl(s)).toBe(false)
  })
  it('tidies a name and caps it', () => {
    expect(cleanDeviceName("  Sam's   iPhone ")).toBe("Sam's iPhone")
    expect(cleanDeviceName('x'.repeat(100))).toHaveLength(64)
    expect(cleanDeviceName(42)).toBe('')
    expect(cleanDeviceName(undefined)).toBe('')
  })
})

describe('readCaDer', () => {
  // Public certificates only (no keys): the private CA and a server leaf signed by it.
  const fixture = (n: string) => join(__dirname, 'fixtures', n)

  it('returns the DER of a CA certificate, as the app expects (an ASN.1 SEQUENCE)', () => {
    const d = readCaDer(fixture('private-ca.pem'))
    expect(d[0]).toBe(0x30)
    expect(d.length).toBeGreaterThan(200)
    expect(d.length).toBeLessThan(4096)
  })

  it('refuses a certificate that is not a CA, so a leaf is never embedded as a trust anchor', () => {
    expect(() => readCaDer(fixture('server-leaf.pem'))).toThrow(/CA/)
  })

  it('refuses a file that is not a certificate', () => {
    expect(() => readCaDer(fixture('../phoneSetup.test.ts'))).toThrow()
  })
})
