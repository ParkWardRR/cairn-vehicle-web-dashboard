import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// This repository has pinned a contracts release since the split and nothing read it, so
// the pin sat four releases behind for days without any check noticing. A pin nobody
// consumes is decoration. This is the consumer.
//
// What it proves: every table, view and macro the built queries read is one the pinned
// store/v1 contract declares. The queries are not guessed — deploy/required-queries.json
// is captured from the running build by tests/staging.sh --capture, and CI already fails
// when it drifts from what the build sends. So the chain is: the build's real SQL, against
// the contract, in a unit test.
//
// What it does NOT prove: that a live store serves them. That needs a real server release
// to compare a native schema against, which is web #10.

const contractsRoot =
  process.env.CAIRN_CONTRACTS && process.env.CAIRN_CONTRACTS !== ''
    ? process.env.CAIRN_CONTRACTS
    : join(__dirname, '..', '.contracts', 'contracts')

const schemaPath = join(contractsRoot, 'store', 'v1', 'schema.json')

interface Schema {
  contract: string
  store_contract: string
  tables: Record<string, { columns: { name: string; type: string }[] }>
  views: Record<string, unknown>
  macros?: Record<string, unknown>
}

// DuckDB's own catalogue, not store/v1 relations. Named rather than pattern-matched away,
// so adding a dependency on the engine's internals is a visible edit to this list: the
// store contract cannot promise anything about them, and a query that reads one is asking
// the engine about itself rather than asking the store about the car.
const ENGINE_CATALOGUE = ['information_schema', 'pg_catalog', 'duckdb_tables', 'duckdb_views']

/** Relations named after FROM or JOIN. A CTE or subquery alias is excluded below. */
function relationsIn(sql: string): string[] {
  return [...sql.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)/gi)]
    .map((m) => m[1].toLowerCase())
    .filter((r) => !ENGINE_CATALOGUE.includes(r))
}

/**
 * Names the query binds itself, so reading them proves nothing about the store:
 * `WITH x AS (` and `, x AS (`.
 *
 * Nothing else needs excluding, which is worth saying because the obvious wider version is
 * wrong. A table alias (`FROM position d`) is never captured, because `relationsIn` takes
 * only the first token after FROM. An inline subquery (`FROM ( … ) AS pos`) is never
 * captured either, because `(` does not match an identifier. An earlier draft also
 * subtracted "any identifier after a closing paren", meaning to catch subquery aliases —
 * that matches `count(*) AS n` and most of SQL besides, and it quietly swallowed real
 * relation names until a mutation test caught it being vacuous.
 */
function boundNames(sql: string): Set<string> {
  return new Set(
    [...sql.matchAll(/(?:\bwith|,)\s+([a-z_][a-z0-9_]*)\s+as\s*\(/gi)].map((m) =>
      m[1].toLowerCase(),
    ),
  )
}

describe('the pinned store/v1 contract', () => {
  it('is fetched: run scripts/fetch-contracts.sh (or set CAIRN_CONTRACTS)', () => {
    expect(existsSync(schemaPath), `missing ${schemaPath}`).toBe(true)
  })

  const schema: Schema = existsSync(schemaPath)
    ? JSON.parse(readFileSync(schemaPath, 'utf8'))
    : ({ contract: '', store_contract: '', tables: {}, views: {} } as Schema)

  it('is a store/v1 release, so this layer may rely on it being additive', () => {
    expect(schema.contract).toBe('store/v1')
    expect(schema.store_contract).toMatch(/^store\/v1\.\d+$/)
  })

  it('declares every relation the built queries read', () => {
    const declared = new Set([
      ...Object.keys(schema.tables),
      ...Object.keys(schema.views),
      ...Object.keys(schema.macros ?? {}),
    ])
    const queries: string[] = JSON.parse(
      readFileSync(join(__dirname, '..', 'deploy', 'required-queries.json'), 'utf8'),
    )
    expect(queries.length).toBeGreaterThan(0)

    const missing = new Map<string, string>()
    const read = new Set<string>()
    for (const sql of queries) {
      const bound = boundNames(sql)
      for (const rel of relationsIn(sql)) {
        if (bound.has(rel)) continue
        read.add(rel)
        if (declared.has(rel) || missing.has(rel)) continue
        missing.set(rel, sql.trim().slice(0, 120))
      }
    }
    expect(
      [...missing].map(([rel, where]) => `${rel} — first read in: ${where}`),
      'a relation the build reads is not in the pinned contract',
    ).toEqual([])

    // Guard the guard: if the extraction ever stops finding relations, the check above
    // passes by finding nothing to complain about. These are the ones the pages cannot
    // work without, and dropping any of them from the contract must fail this test.
    for (const rel of ['obd', 'position', 'boost', 'bundles', 'v_telemetry', 'v_drive_summary', 'v_vehicles']) {
      expect(read, `the extraction no longer sees ${rel} being read`).toContain(rel)
    }
  })

  // The guard has to be able to fail, or it is worth nothing. A relation this layer does
  // not read must be absent from the contract's own vocabulary for the check above to mean
  // "declared", not "anything goes".
  it('does not declare a relation that was never in store/v1', () => {
    const declared = new Set([...Object.keys(schema.tables), ...Object.keys(schema.views)])
    expect(declared.has('v_not_a_real_view')).toBe(false)
    expect(declared.size).toBeGreaterThan(10)
  })
})
