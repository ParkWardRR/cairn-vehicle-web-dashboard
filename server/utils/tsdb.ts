const config = useRuntimeConfig()

interface TsdbResult {
  columns: string[]
  rows: any[][]
  elapsed_us: number
  truncated: boolean
}

// One error for "the store did not answer", so every route reports it the same
// way and the UI can tell it from a bug in a route.
export const STORE_UNREACHABLE = 'store unreachable'

export function storeUnreachable() {
  return createError({ statusCode: 502, statusMessage: STORE_UNREACHABLE })
}

// A connection failure or timeout has no response; a store that answered with an
// error status does, and keeps its own error.
function noAnswer(e: any): boolean {
  return !e?.response && !e?.statusCode
}

export async function queryTsdb(sql: string): Promise<TsdbResult> {
  try {
    return await $fetch<TsdbResult>(`${config.tsdbUrl}/query`, {
      method: 'POST',
      body: sql,
      headers: { 'Content-Type': 'text/plain' },
    })
  } catch (e) {
    if (noAnswer(e)) throw storeUnreachable()
    throw e
  }
}

export function tsdbRowsToObjects(result: TsdbResult): Record<string, any>[] {
  return result.rows.map((row) => {
    const obj: Record<string, any> = {}
    result.columns.forEach((col, i) => {
      obj[col] = row[i]
    })
    return obj
  })
}

export async function queryTsdbObjects(sql: string): Promise<Record<string, any>[]> {
  const result = await queryTsdb(sql)
  return tsdbRowsToObjects(result)
}

export async function tsdbHealth(): Promise<{ ok: boolean; status?: any }> {
  try {
    const status = await $fetch(`${config.tsdbUrl}/healthz`)
    return { ok: true, status }
  } catch {
    return { ok: false }
  }
}
