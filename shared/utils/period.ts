// Calendar periods for the statistics page. Dates are UTC calendar days ("YYYY-MM-DD"); a range
// is [from, to): `to` is the first day after it, so ranges join up with no gap or overlap.

export type Period = 'year' | 'quarter' | 'month' | 'week' | 'custom'
export type Bucket = 'day' | 'week' | 'month'

export interface PeriodRange {
  period: Period
  from: string
  to: string
  bucket: Bucket
  // the same-length range just before this one, for "compared with"
  previous: { from: string; to: string }
}

export const PERIODS: Period[] = ['year', 'quarter', 'month', 'week', 'custom']
export const MAX_CUSTOM_DAYS = 3660

const DAY = 86_400_000
const iso = (d: Date) => d.toISOString().slice(0, 10)

export function parseDay(s: unknown): Date | null {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const d = new Date(`${s}T00:00:00Z`)
  return Number.isNaN(d.getTime()) || iso(d) !== s ? null : d
}

const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY)
const utc = (y: number, m: number, d = 1) => new Date(Date.UTC(y, m, d))

// Monday of the week containing d (ISO weeks).
function mondayOf(d: Date): Date {
  const dow = (d.getUTCDay() + 6) % 7
  return addDays(utc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()), -dow)
}

export function bucketForSpan(days: number): Bucket {
  if (days <= 62) return 'day'
  if (days <= 400) return 'week'
  return 'month'
}

export function periodRange(period: Period, anchor: Date, custom?: { from?: string; to?: string }): PeriodRange {
  const y = anchor.getUTCFullYear()
  const m = anchor.getUTCMonth()
  let from: Date, to: Date, prev: { from: Date; to: Date }, bucket: Bucket
  switch (period) {
    case 'year':
      from = utc(y, 0); to = utc(y + 1, 0); prev = { from: utc(y - 1, 0), to: from }; bucket = 'month'; break
    case 'quarter': {
      const q = Math.floor(m / 3) * 3
      from = utc(y, q); to = utc(y, q + 3); prev = { from: utc(y, q - 3), to: from }; bucket = 'week'; break
    }
    case 'month':
      from = utc(y, m); to = utc(y, m + 1); prev = { from: utc(y, m - 1), to: from }; bucket = 'day'; break
    case 'week':
      from = mondayOf(anchor); to = addDays(from, 7); prev = { from: addDays(from, -7), to: from }; bucket = 'day'; break
    case 'custom': {
      const a = parseDay(custom?.from), b = parseDay(custom?.to)
      if (!a || !b) throw new RangeError('give from and to as YYYY-MM-DD')
      if (b < a) throw new RangeError('from must not be after to')
      from = a; to = addDays(b, 1)
      const days = Math.round((to.getTime() - from.getTime()) / DAY)
      if (days > MAX_CUSTOM_DAYS) throw new RangeError('that range is too long')
      prev = { from: addDays(from, -days), to: from }; bucket = bucketForSpan(days); break
    }
  }
  return { period, from: iso(from), to: iso(to), bucket, previous: { from: iso(prev.from), to: iso(prev.to) } }
}

// Every bucket start in [from, to), so a chart has no holes where nothing was driven.
export function bucketStarts(from: string, to: string, bucket: Bucket): string[] {
  const end = parseDay(to)!
  const out: string[] = []
  let d = parseDay(from)!
  if (bucket === 'week') d = mondayOf(d)
  if (bucket === 'month') d = utc(d.getUTCFullYear(), d.getUTCMonth())
  while (d < end) {
    out.push(iso(d))
    d = bucket === 'day' ? addDays(d, 1) : bucket === 'week' ? addDays(d, 7) : utc(d.getUTCFullYear(), d.getUTCMonth() + 1)
  }
  return out
}

// The day to ask about to move one period back (-1) or forward (+1). Months and quarters are
// stepped from their first day, so the 31st never skips a short month.
export function shiftAnchor(period: Period, anchor: Date, dir: -1 | 1): Date {
  const y = anchor.getUTCFullYear(), m = anchor.getUTCMonth()
  switch (period) {
    case 'year': return utc(y + dir, 0)
    case 'quarter': return utc(y, Math.floor(m / 3) * 3 + 3 * dir)
    case 'month': return utc(y, m + dir)
    case 'week': return addDays(anchor, 7 * dir)
    case 'custom': return anchor
  }
}

// What to call a range, for a heading.
export function periodLabel(r: { period: Period; from: string; to: string }): string {
  const a = parseDay(r.from)!
  const last = addDays(parseDay(r.to)!, -1)
  const mon = (d: Date, y = false) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(y ? { year: 'numeric' } : {}), timeZone: 'UTC' })
  switch (r.period) {
    case 'year': return String(a.getUTCFullYear())
    case 'quarter': return `Q${Math.floor(a.getUTCMonth() / 3) + 1} ${a.getUTCFullYear()}`
    case 'month': return a.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
    default: return `${mon(a, a.getUTCFullYear() !== last.getUTCFullYear())} – ${mon(last, true)}`
  }
}
