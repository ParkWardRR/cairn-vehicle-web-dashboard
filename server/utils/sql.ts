export function sqlString(val: string): string {
  return `'${val.replace(/'/g, "''")}'`
}

export function sqlInt(val: string): number {
  const n = parseInt(val, 10)
  if (isNaN(n)) throw createError({ statusCode: 400, statusMessage: 'Invalid integer parameter' })
  return n
}

// The positions a trip's single-track figures (distance, stops, elevation, the scrubber) are read
// from: the dongle's own GNSS fixes, or, when it never had a fix on this boot, the phone's.
// The store also holds the phone's fixes under the same boot (source_flags bit 5); reading both
// would drive the same road twice. Use as `FROM ${primaryPositions(id)} WHERE ...`; `bootSql` is
// an already-quoted SQL literal.
export function primaryPositions(bootSql: string): string {
  return `(
    SELECT * FROM position
    WHERE boot_id = ${bootSql}
      AND (coalesce(source_flags, 0) & 32 = 0
           OR NOT EXISTS (SELECT 1 FROM position d
                          WHERE d.boot_id = ${bootSql} AND coalesce(d.source_flags, 0) & 32 = 0
                            AND d.lat != 0 AND d.lon != 0))
  ) AS pos`
}
