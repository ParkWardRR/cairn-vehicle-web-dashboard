// Runs every query the web layer sends the store (deploy/required-queries.json, written by
// tests/staging.sh --capture) as EXPLAIN against a live store, and fails if the store cannot
// plan one. The store's own error names the missing table, view or column.
//
//   node check-capabilities.mjs <queries.json> <store-url>
//
// EXPLAIN binds the statement without running it, so this is cheap and reads no data. It runs
// on the host (deploy-ui.sh copies it there), where the store listens on loopback.
import { readFileSync } from 'node:fs'

const [file, base] = process.argv.slice(2)
if (!file || !base) {
  console.error('usage: check-capabilities.mjs <queries.json> <store-url>')
  process.exit(2)
}
const queries = JSON.parse(readFileSync(file, 'utf8'))

const failures = new Map()
let unreachable = false
for (const sql of queries) {
  let text = ''
  let ok = false
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: `EXPLAIN ${sql}`,
      signal: AbortSignal.timeout(30_000),
    })
    text = await res.text()
    ok = res.ok
  } catch (e) {
    unreachable = true
    text = `the store did not answer: ${e.message}`
  }
  if (!ok) {
    // The first line of the store's message names the problem; repeats are folded together.
    const why = text.split('\n').find(l => l.trim()) ?? 'unknown error'
    const entry = failures.get(why) ?? { count: 0, example: sql.replace(/\s+/g, ' ').trim().slice(0, 140) }
    entry.count++
    failures.set(why, entry)
    if (unreachable) break
  }
}

if (failures.size) {
  console.error(`the live store cannot plan ${[...failures.values()].reduce((n, f) => n + f.count, 0)} of ${queries.length} queries this build sends:`)
  for (const [why, f] of failures) console.error(`  - ${why}  (${f.count}x, e.g. ${f.example})`)
  process.exit(1)
}
console.log(`the live store can plan all ${queries.length} queries this build sends`)
