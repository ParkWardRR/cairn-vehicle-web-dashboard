// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { bucketForSpan, bucketStarts, parseDay, periodLabel, periodRange, shiftAnchor } from '../shared/utils/period'

const at = (s: string) => parseDay(s)!

describe('parseDay', () => {
  it('accepts a real day and nothing else', () => {
    expect(parseDay('2026-02-28')).not.toBeNull()
    for (const bad of ['2026-02-30', '2026-13-01', '26-01-01', '2026-1-1', '', null, undefined, 20260101, '2026-01-01T00:00:00Z']) expect(parseDay(bad), String(bad)).toBeNull()
  })
})

describe('periodRange', () => {
  it('year: the calendar year, by month, against the year before', () => {
    expect(periodRange('year', at('2026-06-15'))).toEqual({ period: 'year', from: '2026-01-01', to: '2027-01-01', bucket: 'month', previous: { from: '2025-01-01', to: '2026-01-01' } })
  })
  it('quarter: the quarter containing the day, by week', () => {
    expect(periodRange('quarter', at('2026-05-20'))).toMatchObject({ from: '2026-04-01', to: '2026-07-01', bucket: 'week', previous: { from: '2026-01-01', to: '2026-04-01' } })
    expect(periodRange('quarter', at('2026-01-01'))).toMatchObject({ from: '2026-01-01', to: '2026-04-01', previous: { from: '2025-10-01', to: '2026-01-01' } })
    expect(periodRange('quarter', at('2026-12-31'))).toMatchObject({ from: '2026-10-01', to: '2027-01-01' })
  })
  it('month: by day, and the previous month across a year boundary', () => {
    expect(periodRange('month', at('2026-01-15'))).toMatchObject({ from: '2026-01-01', to: '2026-02-01', bucket: 'day', previous: { from: '2025-12-01', to: '2026-01-01' } })
    expect(periodRange('month', at('2024-02-10'))).toMatchObject({ from: '2024-02-01', to: '2024-03-01' })
  })
  it('week: Monday to Monday, whichever day you ask from', () => {
    for (const d of ['2026-10-05', '2026-10-07', '2026-10-11']) {
      expect(periodRange('week', at(d))).toMatchObject({ from: '2026-10-05', to: '2026-10-12', bucket: 'day', previous: { from: '2026-09-28', to: '2026-10-05' } })
    }
  })
  it('custom: both ends inclusive, compared with the same span before', () => {
    expect(periodRange('custom', at('2026-01-01'), { from: '2026-03-01', to: '2026-03-10' })).toEqual({
      period: 'custom', from: '2026-03-01', to: '2026-03-11', bucket: 'day', previous: { from: '2026-02-19', to: '2026-03-01' },
    })
    expect(periodRange('custom', at('2026-01-01'), { from: '2026-03-05', to: '2026-03-05' })).toMatchObject({ from: '2026-03-05', to: '2026-03-06' })
  })
  it('custom: refuses a missing, backwards or enormous range', () => {
    const a = at('2026-01-01')
    expect(() => periodRange('custom', a, {})).toThrow(RangeError)
    expect(() => periodRange('custom', a, { from: '2026-03-10', to: '2026-03-01' })).toThrow(/after/)
    expect(() => periodRange('custom', a, { from: '2000-01-01', to: '2026-01-01' })).toThrow(/too long/)
    expect(() => periodRange('custom', a, { from: 'x', to: '2026-01-01' })).toThrow(RangeError)
  })
  it('picks a bucket that gives a readable chart', () => {
    expect(bucketForSpan(31)).toBe('day')
    expect(bucketForSpan(120)).toBe('week')
    expect(bucketForSpan(900)).toBe('month')
  })
})

describe('bucketStarts', () => {
  it('lists every day, with no holes', () => {
    const r = periodRange('week', at('2026-10-07'))
    expect(bucketStarts(r.from, r.to, r.bucket)).toEqual(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'])
  })
  it('lists whole months for a year, and Mondays for a quarter', () => {
    const y = periodRange('year', at('2026-03-01'))
    expect(bucketStarts(y.from, y.to, y.bucket)).toHaveLength(12)
    const q = periodRange('quarter', at('2026-05-01'))
    const w = bucketStarts(q.from, q.to, q.bucket)
    expect(w[0]).toBe('2026-03-30')   // the Monday on or before 1 April
    expect(w.every(d => new Date(`${d}T00:00:00Z`).getUTCDay() === 1)).toBe(true)
  })
})

describe('shiftAnchor and periodLabel', () => {
  it('steps whole periods, never skipping a short month', () => {
    expect(shiftAnchor('month', at('2026-03-31'), -1).toISOString().slice(0, 10)).toBe('2026-02-01')
    expect(shiftAnchor('month', at('2026-12-15'), 1).toISOString().slice(0, 10)).toBe('2027-01-01')
    expect(shiftAnchor('year', at('2026-06-15'), -1).toISOString().slice(0, 10)).toBe('2025-01-01')
    expect(shiftAnchor('quarter', at('2026-02-10'), -1).toISOString().slice(0, 10)).toBe('2025-10-01')
    expect(shiftAnchor('week', at('2026-10-07'), 1).toISOString().slice(0, 10)).toBe('2026-10-14')
  })
  it('a step and its inverse land in the same period', () => {
    for (const p of ['year', 'quarter', 'month', 'week'] as const) {
      const a = at('2026-05-31')
      const there = shiftAnchor(p, a, 1)
      expect(periodRange(p, shiftAnchor(p, there, -1)).from, p).toBe(periodRange(p, a).from)
    }
  })
  it('labels a period for a heading', () => {
    expect(periodLabel(periodRange('year', at('2026-06-01')))).toBe('2026')
    expect(periodLabel(periodRange('quarter', at('2026-05-01')))).toBe('Q2 2026')
    expect(periodLabel(periodRange('month', at('2026-03-09')))).toBe('March 2026')
    expect(periodLabel(periodRange('week', at('2026-10-07')))).toBe('Oct 5 – Oct 11, 2026')
    expect(periodLabel(periodRange('custom', at('2026-01-01'), { from: '2025-12-20', to: '2026-01-05' }))).toBe('Dec 20, 2025 – Jan 5, 2026')
  })
})
