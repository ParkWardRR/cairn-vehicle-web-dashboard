import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Passkeys, sessions and the audit trail. Sessions are stored as a hash of the cookie value, so
// a copy of this file cannot be replayed. The audit trail records who did what to which field
// and never a value.

export interface Credential {
  id: string
  public_key: Uint8Array
  counter: number
  transports: string[]
  name: string
  created_at: number
  last_used_at: number | null
}

export interface Session {
  actor: string
  method: 'passkey'
  created_at: number
  auth_at: number
  expires_at: number
}

export interface AuditRow { id: number; ts: number; actor: string; method: string; action: string; target: string | null }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY, public_key BLOB NOT NULL, counter INTEGER NOT NULL,
  transports TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, actor TEXT NOT NULL, created_at INTEGER NOT NULL,
  auth_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, credential_id TEXT
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, actor TEXT NOT NULL,
  method TEXT NOT NULL, action TEXT NOT NULL, target TEXT
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`

export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex')

export class AuthStore {
  private db: DatabaseSync

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, 'auth.sqlite')
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode=WAL')
    this.db.exec(SCHEMA)
    try { chmodSync(file, 0o600) } catch { /* best effort on exotic filesystems */ }
  }

  // The WebAuthn user handle: stable, random, not the owner's name.
  userHandle(): string {
    const row = this.db.prepare("SELECT v FROM meta WHERE k='user_handle'").get() as { v: string } | undefined
    if (row) return row.v
    const v = randomBytes(32).toString('base64url')
    this.db.prepare("INSERT INTO meta (k, v) VALUES ('user_handle', ?)").run(v)
    return v
  }

  credentials(): Credential[] {
    return (this.db.prepare('SELECT * FROM credentials ORDER BY created_at').all() as any[]).map(r => ({
      ...r, transports: JSON.parse(r.transports), public_key: new Uint8Array(r.public_key),
    }))
  }

  credential(id: string): Credential | null {
    return this.credentials().find(c => c.id === id) ?? null
  }

  addCredential(c: Omit<Credential, 'created_at' | 'last_used_at'>, now = Date.now()): void {
    this.db.prepare('INSERT INTO credentials (id, public_key, counter, transports, name, created_at) VALUES (?,?,?,?,?,?)')
      .run(c.id, c.public_key, c.counter, JSON.stringify(c.transports), c.name, now)
  }

  touchCredential(id: string, counter: number, now = Date.now()): void {
    this.db.prepare('UPDATE credentials SET counter=?, last_used_at=? WHERE id=?').run(counter, now, id)
  }

  removeCredential(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM credentials WHERE id=?').run(id).changes) > 0
  }

  createSession(actor: string, days: number, credentialId: string | null = null, now = Date.now()): string {
    const token = randomBytes(32).toString('base64url')
    this.db.prepare('INSERT INTO sessions (token_hash, actor, created_at, auth_at, expires_at, credential_id) VALUES (?,?,?,?,?,?)')
      .run(hashToken(token), actor, now, now, now + days * 86_400_000, credentialId)
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now)
    return token
  }

  session(token: string, now = Date.now()): Session | null {
    const r = this.db.prepare('SELECT * FROM sessions WHERE token_hash=?').get(hashToken(token)) as any
    if (!r || r.expires_at < now) return null
    return { actor: r.actor, method: 'passkey', created_at: r.created_at, auth_at: r.auth_at, expires_at: r.expires_at }
  }

  endSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token))
  }

  // Removing a passkey ends every session it started, so a lost device is locked out at once.
  endSessionsOf(credentialId: string): void {
    this.db.prepare('DELETE FROM sessions WHERE credential_id=?').run(credentialId)
  }

  audit(actor: string, method: string, action: string, target: string | null = null, now = Date.now()): void {
    this.db.prepare('INSERT INTO audit (ts, actor, method, action, target) VALUES (?,?,?,?,?)').run(now, actor, method, action, target)
  }

  auditTrail(limit = 100): AuditRow[] {
    return this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit) as unknown as AuditRow[]
  }

  // The service token (automation: the deploy walk, staging). Read-only by policy; the file is
  // created on first use so a fresh host needs no step, and an environment value wins.
  serviceToken(fromEnv: string): string {
    if (fromEnv) return fromEnv
    const file = join(this.dir, 'service-token')
    if (existsSync(file)) return readFileSync(file, 'utf8').trim()
    const t = randomBytes(32).toString('base64url')
    writeFileSync(file, t + '\n', { mode: 0o600 })
    return t
  }

  // Until a first passkey exists, a one-time code written to this directory lets the owner
  // enrol from anywhere with shell access to the host. It goes away with the first passkey.
  bootstrapCode(fromEnv: string): string | null {
    const file = join(this.dir, 'bootstrap-code')
    if (this.credentials().length) {
      if (existsSync(file)) unlinkSync(file)
      return null
    }
    if (fromEnv) return fromEnv
    if (existsSync(file)) return readFileSync(file, 'utf8').trim()
    const c = randomBytes(9).toString('base64url')
    writeFileSync(file, c + '\n', { mode: 0o600 })
    return c
  }
}
