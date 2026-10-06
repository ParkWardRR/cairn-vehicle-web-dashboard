// @vitest-environment node
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AnnotationError, AnnotationStore, normaliseTag } from '../server/utils/annotations'

const dir = () => mkdtempSync(join(tmpdir(), 'cairn-ann-'))
const A = 'a'.repeat(32), B = 'b'.repeat(32), C = 'c'.repeat(32)

describe('tags', () => {
  it('are lower-cased, trimmed and tidy', () => {
    expect(normaliseTag('  Track Day ')).toBe('track day')
    expect(normaliseTag('road-trip/2026')).toBe('road-trip/2026')
    expect(normaliseTag('Café')).toBe('café')
  })
  it('refuse nothing, too long, or odd characters', () => {
    for (const bad of ['', '   ', 'x'.repeat(33), "a'b", 'a;b', '<b>', '-lead', 5, null]) expect(() => normaliseTag(bad), String(bad)).toThrow(AnnotationError)
  })
})

describe('AnnotationStore', () => {
  it('sets, merges and reads back a trip\'s marks', () => {
    const s = new AnnotationStore(dir())
    expect(s.get(A)).toBeNull()
    s.set(A, { bookmarked: true, tags: ['Scenic', 'scenic', 'coast'] }, 100)
    expect(s.get(A)).toEqual({ boot_id: A, bookmarked: true, note: null, tags: ['coast', 'scenic'], updated_at: 100 })
    // what is not sent is left alone
    s.set(A, { note: ' great light ' }, 200)
    expect(s.get(A)).toMatchObject({ bookmarked: true, note: 'great light', tags: ['coast', 'scenic'], updated_at: 200 })
  })
  it('forgets a trip with nothing left on it', () => {
    const s = new AnnotationStore(dir())
    s.set(A, { bookmarked: true })
    s.set(A, { bookmarked: false })
    expect(s.get(A)).toBeNull()
    expect(s.list()).toEqual([])
    s.set(B, { tags: ['x'] })
    expect(s.remove(B)).toBe(true)
    expect(s.remove(B)).toBe(false)
  })
  it('refuses bad input', () => {
    const s = new AnnotationStore(dir())
    expect(() => s.set('nope', {})).toThrow(/32 hex/)
    expect(() => s.set(A, { tags: 'x' as any })).toThrow(/list/)
    expect(() => s.set(A, { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) })).toThrow(/at most/)
    expect(() => s.set(A, { note: 'x'.repeat(2001) })).toThrow(/2000/)
    expect(() => s.set(A, { bookmarked: 'yes' as any })).toThrow(/true or false/)
    expect(s.list()).toEqual([])
  })
  it('lists by tag and by bookmark, and counts tags', () => {
    const s = new AnnotationStore(dir())
    s.set(A, { bookmarked: true, tags: ['coast'] }); s.set(B, { tags: ['coast', 'work'] }); s.set(C, { bookmarked: true })
    expect(s.list({ tag: 'coast' }).map(a => a.boot_id).sort()).toEqual([A, B])
    expect(s.list({ bookmarked: true }).map(a => a.boot_id).sort()).toEqual([A, C])
    expect(s.list({ tag: 'coast', bookmarked: true }).map(a => a.boot_id)).toEqual([A])
    expect(s.tags()).toEqual([{ tag: 'coast', trips: 2 }, { tag: 'work', trips: 1 }])
  })
  it('finds trips by note or tag text, and treats % and _ as plain text', () => {
    const s = new AnnotationStore(dir())
    s.set(A, { note: 'Lovely light at the lookout' }); s.set(B, { tags: ['lookout-point'] }); s.set(C, { note: '100% sure' })
    expect(s.matching('lookout').sort()).toEqual([A, B])
    expect(s.matching('LIGHT')).toEqual([A])
    expect(s.matching('%')).toEqual([C])
    expect(s.matching('_')).toEqual([])
  })
})

describe('export and import', () => {
  it('round-trips into a fresh store', () => {
    const a = new AnnotationStore(dir())
    a.set(A, { bookmarked: true, tags: ['x'], note: 'n' }, 10); a.set(B, { tags: ['y'] }, 20)
    const b = new AnnotationStore(dir())
    expect(b.import(a.export())).toBe(2)
    expect(b.export().annotations).toEqual(a.export().annotations)
  })
  it('is safe to repeat, and never lets an older copy overwrite newer work', () => {
    const a = new AnnotationStore(dir())
    a.set(A, { note: 'old' }, 10)
    const old = a.export()
    a.set(A, { note: 'new' }, 20)
    expect(a.import(old)).toBe(0)
    expect(a.get(A)?.note).toBe('new')
    const b = new AnnotationStore(dir())
    expect(b.import(old)).toBe(1)
    expect(b.import(old)).toBe(0)
  })
  it('refuses something that is not an export, or has a bad entry, without partial changes to what is valid', () => {
    const s = new AnnotationStore(dir())
    for (const bad of [null, {}, { version: 2, annotations: [] }, { version: 1, annotations: 'x' }]) expect(() => s.import(bad)).toThrow(AnnotationError)
    expect(() => s.import({ version: 1, annotations: [{ boot_id: 'bad' }] })).toThrow(/32 hex/)
    expect(() => s.import({ version: 1, annotations: [{ boot_id: A, tags: ["a'b"] }] })).toThrow(AnnotationError)
  })
})

describe('backup mirror', () => {
  it('writes annotations.json after every change, owner-only', () => {
    const d = dir()
    const s = new AnnotationStore(d)
    s.set(A, { bookmarked: true })
    expect(existsSync(join(d, 'annotations.json'))).toBe(true)
    expect(statSync(join(d, 'annotations.json')).mode & 0o077).toBe(0)
    expect(existsSync(join(d, 'annotations.json.tmp'))).toBe(false)
  })
  it('rebuilds a lost database from the mirror on the next start', () => {
    const d = dir()
    const s = new AnnotationStore(d)
    s.set(A, { bookmarked: true, tags: ['kept'], note: 'still here' }, 50)
    for (const f of ['annotations.sqlite', 'annotations.sqlite-wal', 'annotations.sqlite-shm']) rmSync(join(d, f), { force: true })
    const again = new AnnotationStore(d)
    expect(again.get(A)).toMatchObject({ bookmarked: true, tags: ['kept'], note: 'still here', updated_at: 50 })
  })
})
