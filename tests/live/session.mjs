// Mints or removes the short-lived session the live UI suite signs in with. Runs on the host, as
// the user that owns the auth store:
//
//   sudo -u cairn node session.mjs create   # prints the cookie value
//   sudo -u cairn node session.mjs end      # removes every e2e-test session
//
// Passkey auth is not loosened for testing: this writes a real session with a two-hour life, and
// records both ends in the audit trail so the owner can see the suite ran.
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes } from 'node:crypto'

const DIR = process.env.CAIRN_UI_DATA_DIR || '/var/lib/cairn-ui'
const ACTOR = 'e2e-test'
const TARGET = 'playwright-live-ui-suite'

const db = new DatabaseSync(`${DIR}/auth.sqlite`)
const hash = t => createHash('sha256').update(t).digest('hex')
const now = Date.now()
const note = (action, target) =>
  db.prepare('INSERT INTO audit (ts, actor, method, action, target) VALUES (?,?,?,?,?)').run(now, ACTOR, 'passkey', action, target)

if (process.argv[2] === 'create') {
  const token = randomBytes(32).toString('base64url')
  db.prepare('INSERT INTO sessions (token_hash, actor, created_at, auth_at, expires_at, credential_id) VALUES (?,?,?,?,?,?)')
    .run(hash(token), ACTOR, now, now, now + 2 * 3_600_000, null)
  note('test-session-created', `${TARGET}: 2 hours, no passkey`)
  console.log(token)
} else if (process.argv[2] === 'end') {
  const { changes } = db.prepare('DELETE FROM sessions WHERE actor=?').run(ACTOR)
  note('test-session-removed', `${TARGET}: sessions removed: ${changes}`)
  console.log(`removed ${changes}`)
} else {
  console.error('usage: session.mjs create|end')
  process.exit(2)
}
