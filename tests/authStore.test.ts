// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AuthStore, hashToken } from '../server/utils/authStore'

const fresh = () => new AuthStore(mkdtempSync(join(tmpdir(), 'cairn-auth-')))
const cred = (id: string) => ({ id, public_key: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'], name: `key ${id}` })

describe('AuthStore sessions', () => {
  it('stores a hash, not the cookie value', () => {
    const s = fresh()
    const token = s.createSession('owner', 30)
    const raw = readFileSync(join(s.dir, 'auth.sqlite')).toString('latin1') + (existsSync(join(s.dir, 'auth.sqlite-wal')) ? readFileSync(join(s.dir, 'auth.sqlite-wal')).toString('latin1') : '')
    expect(raw).not.toContain(token)
    expect(raw).toContain(hashToken(token))
    expect(s.session(token)?.actor).toBe('owner')
  })
  it('expires, and ends on logout', () => {
    const s = fresh()
    const t = s.createSession('owner', 1, null, 1_000)
    expect(s.session(t, 1_000 + 86_400_000 - 1)).not.toBeNull()
    expect(s.session(t, 1_000 + 86_400_000 + 1)).toBeNull()
    const u = s.createSession('owner', 30)
    s.endSession(u)
    expect(s.session(u)).toBeNull()
  })
  it('does not accept a guess', () => expect(fresh().session('nope')).toBeNull())
  it('removing a passkey ends the sessions it started and no others', () => {
    const s = fresh()
    s.addCredential(cred('a')); s.addCredential(cred('b'))
    const ta = s.createSession('owner', 30, 'a'), tb = s.createSession('owner', 30, 'b')
    expect(s.removeCredential('a')).toBe(true)
    s.endSessionsOf('a')
    expect(s.session(ta)).toBeNull()
    expect(s.session(tb)).not.toBeNull()
    expect(s.removeCredential('a')).toBe(false)
  })
})

describe('AuthStore passkeys', () => {
  it('round-trips a credential', () => {
    const s = fresh()
    s.addCredential(cred('abc'))
    const c = s.credential('abc')!
    expect(Array.from(c.public_key)).toEqual([1, 2, 3])
    expect(c.transports).toEqual(['internal'])
    s.touchCredential('abc', 7)
    expect(s.credential('abc')!.counter).toBe(7)
    expect(s.credential('abc')!.last_used_at).not.toBeNull()
  })
  it('keeps one stable user handle', () => {
    const s = fresh()
    expect(s.userHandle()).toBe(s.userHandle())
    expect(s.userHandle().length).toBeGreaterThan(30)
  })
})

describe('AuthStore audit', () => {
  it('records who, when and which field, newest first', () => {
    const s = fresh()
    s.audit('owner', 'passkey', 'login', 'iPhone', 10)
    s.audit('owner', 'passkey', 'passkey-removed', 'old laptop', 20)
    const t = s.auditTrail()
    expect(t.map(r => r.action)).toEqual(['passkey-removed', 'login'])
    expect(t[0]).toMatchObject({ actor: 'owner', method: 'passkey', target: 'old laptop', ts: 20 })
  })
})

describe('AuthStore secrets on disk', () => {
  it('writes the database, the service token and the code readable by the owner only', () => {
    const s = fresh()
    s.serviceToken(''); s.bootstrapCode('')
    for (const f of ['auth.sqlite', 'service-token', 'bootstrap-code']) expect(statSync(join(s.dir, f)).mode & 0o077, f).toBe(0)
  })
  it('keeps the service token across restarts, and lets the environment win', () => {
    const s = fresh()
    const t = s.serviceToken('')
    expect(new AuthStore(s.dir).serviceToken('')).toBe(t)
    expect(s.serviceToken('from-env')).toBe('from-env')
  })
  it('offers a one-time code until a first passkey exists, then removes it', () => {
    const s = fresh()
    const code = s.bootstrapCode('')!
    expect(code.length).toBeGreaterThan(8)
    expect(s.bootstrapCode('')).toBe(code)
    s.addCredential(cred('first'))
    expect(s.bootstrapCode('')).toBeNull()
    expect(existsSync(join(s.dir, 'bootstrap-code'))).toBe(false)
  })
})
