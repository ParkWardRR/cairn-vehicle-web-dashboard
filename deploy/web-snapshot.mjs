// Snapshot and restore-test for the web layer's own state. Runs on the host, as root
// (the files belong to the service user and the snapshot must not be world-readable).
//
//   node web-snapshot.mjs snapshot <state-dir> <build-dir> <dest-root>   prints the snapshot dir
//   node web-snapshot.mjs verify   <snapshot-dir> [<state-dir>]
//
// A snapshot holds a consistent copy of every SQLite store (VACUUM INTO, safe while the
// service writes), the saved-places file, and the deployed build, plus a manifest of hashes
// and row counts. `verify` restores it into a scratch directory, opens every restored store,
// and checks integrity, row counts and hashes against the manifest; with <state-dir> it also
// compares the restored saved-places file with the live one. These files hold real locations.
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

function walk(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else if (e.isFile()) out.push(p)
  }
  return out.sort()
}

function treeHash(dir) {
  const h = createHash('sha256')
  for (const f of walk(dir)) h.update(relative(dir, f) + '\0' + sha(f) + '\0')
  return { files: walk(dir).length, sha256: h.digest('hex') }
}

function rowCounts(file, readOnly = true) {
  const db = new DatabaseSync(file, { readOnly })
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    const counts = {}
    for (const { name } of tables) counts[name] = db.prepare(`SELECT count(*) AS n FROM "${name}"`).get().n
    return { integrity, counts }
  } finally {
    db.close()
  }
}

function snapshot(stateDir, buildDir, destRoot) {
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const dest = join(destRoot, ts)
  mkdirSync(join(dest, 'state'), { recursive: true, mode: 0o700 })
  chmodSync(destRoot, 0o700)
  const manifest = { taken_at: new Date().toISOString(), state: {}, build: null }

  for (const name of readdirSync(stateDir).sort()) {
    const src = join(stateDir, name)
    if (!statSync(src).isFile()) continue
    if (/\.sqlite$/.test(name)) {
      const out = join(dest, 'state', name)
      const db = new DatabaseSync(src, { readOnly: true })
      try { db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`) } finally { db.close() }
      manifest.state[name] = { kind: 'sqlite', sha256: sha(out), ...rowCounts(out) }
    } else if (name === 'saved-places.json') {
      const out = join(dest, 'state', name)
      cpSync(src, out)
      manifest.state[name] = { kind: 'file', sha256: sha(out) }
    }
    // -wal and -shm are folded into the VACUUM copy; backups/ is the app's own dated copies.
  }

  if (existsSync(buildDir)) {
    cpSync(buildDir, join(dest, 'build'), { recursive: true })
    manifest.build = treeHash(join(dest, 'build'))
  }
  writeFileSync(join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 })
  console.log(dest)
}

function verify(snapDir, liveState) {
  const manifest = JSON.parse(readFileSync(join(snapDir, 'manifest.json'), 'utf8'))
  const scratch = mkdtempSync(join(tmpdir(), 'cairn-restore-'))
  const problems = []
  const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) problems.push(what) }
  try {
    cpSync(snapDir, scratch, { recursive: true })
    for (const [name, m] of Object.entries(manifest.state)) {
      const f = join(scratch, 'state', name)
      check(existsSync(f) && sha(f) === m.sha256, `${name}: restored file matches its hash`)
      if (m.kind === 'sqlite') {
        const r = rowCounts(f)
        check(r.integrity === 'ok', `${name}: integrity_check is ok`)
        check(JSON.stringify(r.counts) === JSON.stringify(m.counts), `${name}: row counts match the snapshot (${Object.entries(r.counts).map(([t, n]) => `${t}=${n}`).join(', ') || 'no tables'})`)
      }
    }
    if (manifest.build) {
      const t = treeHash(join(scratch, 'build'))
      check(t.sha256 === manifest.build.sha256 && t.files === manifest.build.files, `build: ${t.files} files restored, tree hash matches`)
    }
    if (liveState) {
      const live = join(liveState, 'saved-places.json')
      const snap = join(scratch, 'state', 'saved-places.json')
      if (existsSync(live) && existsSync(snap)) check(sha(live) === sha(snap), 'saved-places.json: the restored copy equals the live one')
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  if (problems.length) { console.error(`restore test failed: ${problems.length} check(s)`); process.exit(1) }
  console.log('restore test passed')
}

const [cmd, ...args] = process.argv.slice(2)
if (cmd === 'snapshot' && args.length === 3) snapshot(...args)
else if (cmd === 'verify' && (args.length === 1 || args.length === 2)) verify(...args)
else { console.error('usage: web-snapshot.mjs snapshot <state-dir> <build-dir> <dest-root> | verify <snapshot-dir> [<state-dir>]'); process.exit(2) }
