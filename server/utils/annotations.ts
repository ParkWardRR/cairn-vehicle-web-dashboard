import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// A person's marks on trips: a bookmark, tags and a note. Keyed by boot id (the trip), kept apart
// from the store (which the web layer only reads). These cannot be derived from anything, so every
// change is mirrored to annotations.json (written atomically), a lost database is rebuilt from it
// on the next start, and the whole set exports and imports (a merge that is safe to repeat).

export interface Annotation {
  boot_id: string
  bookmarked: boolean
  note: string | null
  tags: string[]
  updated_at: number
}

export interface AnnotationInput { bookmarked?: boolean; note?: string | null; tags?: string[] }

export interface AnnotationExport { version: 1; exported_at: string; annotations: Annotation[] }

export class AnnotationError extends Error {}

export const MAX_TAGS = 20
export const MAX_TAG_LEN = 32
export const MAX_NOTE_LEN = 2000
const BOOT_RE = /^[0-9a-f]{32}$/

export function normaliseTag(t: unknown): string {
  if (typeof t !== 'string') throw new AnnotationError('a tag is text')
  const tag = t.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!tag || tag.length > MAX_TAG_LEN) throw new AnnotationError(`a tag is 1 to ${MAX_TAG_LEN} characters`)
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _\-/.]*$/u.test(tag)) throw new AnnotationError('a tag uses letters, numbers, spaces and - _ / .')
  return tag
}

export function checkBoot(id: unknown): string {
  if (typeof id !== 'string' || !BOOT_RE.test(id)) throw new AnnotationError('boot id must be 32 hex characters')
  return id
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trip_marks (
  boot_id TEXT PRIMARY KEY, bookmarked INTEGER NOT NULL DEFAULT 0, note TEXT, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS trip_tags (
  boot_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY (boot_id, tag)
);
CREATE INDEX IF NOT EXISTS trip_tags_tag ON trip_tags (tag);
`

export class AnnotationStore {
  private db: DatabaseSync
  private mirror: string

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'annotations.sqlite')
    this.mirror = join(dir, 'annotations.json')
    const fresh = !existsSync(file)
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode=WAL')
    this.db.exec(SCHEMA)
    if (fresh && existsSync(this.mirror)) this.merge(JSON.parse(readFileSync(this.mirror, 'utf8')).annotations ?? [], false)
  }

  private rows(where = '', ...args: any[]): Annotation[] {
    const marks = this.db.prepare(`SELECT * FROM trip_marks ${where}`).all(...args) as any[]
    const tags = this.db.prepare('SELECT boot_id, tag FROM trip_tags ORDER BY tag').all() as any[]
    const byBoot = new Map<string, string[]>()
    for (const t of tags) byBoot.set(t.boot_id, [...(byBoot.get(t.boot_id) ?? []), t.tag])
    return marks.map(m => ({ boot_id: m.boot_id, bookmarked: !!m.bookmarked, note: m.note, tags: byBoot.get(m.boot_id) ?? [], updated_at: m.updated_at }))
  }

  get(bootId: string): Annotation | null {
    return this.rows('WHERE boot_id = ?', bootId)[0] ?? null
  }

  list(f: { tag?: string; bookmarked?: boolean } = {}): Annotation[] {
    let all = this.rows('ORDER BY updated_at DESC')
    if (f.tag) all = all.filter(a => a.tags.includes(f.tag!))
    if (f.bookmarked !== undefined) all = all.filter(a => a.bookmarked === f.bookmarked)
    return all
  }

  tags(): Array<{ tag: string; trips: number }> {
    return this.db.prepare('SELECT tag, count(*) AS trips FROM trip_tags GROUP BY tag ORDER BY trips DESC, tag').all() as any[]
  }

  // Boot ids whose note or tags mention `q`, for search.
  matching(q: string): string[] {
    const like = `%${q.replace(/[\\%_]/g, c => `\\${c}`)}%`
    const rows = this.db.prepare(
      `SELECT boot_id FROM trip_marks WHERE note LIKE ? ESCAPE '\\'
       UNION SELECT boot_id FROM trip_tags WHERE tag LIKE ? ESCAPE '\\'`,
    ).all(like, like) as any[]
    return rows.map(r => r.boot_id)
  }

  set(bootId: string, input: AnnotationInput, now = Date.now()): Annotation {
    checkBoot(bootId)
    let tags: string[] | undefined
    if (input.tags !== undefined) {
      if (!Array.isArray(input.tags)) throw new AnnotationError('tags is a list')
      tags = [...new Set(input.tags.map(normaliseTag))]
      if (tags.length > MAX_TAGS) throw new AnnotationError(`at most ${MAX_TAGS} tags`)
    }
    if (input.note != null && (typeof input.note !== 'string' || input.note.length > MAX_NOTE_LEN)) {
      throw new AnnotationError(`a note is text up to ${MAX_NOTE_LEN} characters`)
    }
    if (input.bookmarked !== undefined && typeof input.bookmarked !== 'boolean') throw new AnnotationError('bookmarked is true or false')

    const cur = this.get(bootId)
    const next = {
      bookmarked: input.bookmarked ?? cur?.bookmarked ?? false,
      note: input.note === undefined ? (cur?.note ?? null) : (input.note?.trim() || null),
      tags: tags ?? cur?.tags ?? [],
    }
    this.write(bootId, next, now)
    return this.get(bootId) ?? { boot_id: bootId, bookmarked: false, note: null, tags: [], updated_at: now }
  }

  // An empty mark (no bookmark, note or tags) is removed rather than stored.
  private write(bootId: string, a: { bookmarked: boolean; note: string | null; tags: string[] }, now: number, mirror = true) {
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM trip_tags WHERE boot_id=?').run(bootId)
      if (!a.bookmarked && !a.note && !a.tags.length) {
        this.db.prepare('DELETE FROM trip_marks WHERE boot_id=?').run(bootId)
      } else {
        this.db.prepare('INSERT INTO trip_marks (boot_id, bookmarked, note, updated_at) VALUES (?,?,?,?) ON CONFLICT(boot_id) DO UPDATE SET bookmarked=excluded.bookmarked, note=excluded.note, updated_at=excluded.updated_at')
          .run(bootId, a.bookmarked ? 1 : 0, a.note, now)
        const ins = this.db.prepare('INSERT INTO trip_tags (boot_id, tag) VALUES (?,?)')
        for (const t of a.tags) ins.run(bootId, t)
      }
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
    if (mirror) this.writeMirror()
  }

  remove(bootId: string): boolean {
    checkBoot(bootId)
    const had = this.get(bootId) !== null
    this.write(bootId, { bookmarked: false, note: null, tags: [] }, Date.now())
    return had
  }

  export(): AnnotationExport {
    return { version: 1, exported_at: new Date().toISOString(), annotations: this.rows('ORDER BY boot_id') }
  }

  // Merge: a trip's marks are replaced only by a newer copy, so importing the same file twice, or
  // an older file over newer work, changes nothing. Returns how many trips changed.
  import(data: unknown): number {
    const list = (data as any)?.annotations
    if ((data as any)?.version !== 1 || !Array.isArray(list)) throw new AnnotationError('not a Cairn annotations export')
    if (list.length > 100_000) throw new AnnotationError('too many annotations')
    return this.merge(list, true)
  }

  private merge(list: any[], mirror: boolean): number {
    let changed = 0
    for (const a of list) {
      const boot = checkBoot(a?.boot_id)
      const at = Number.isFinite(a?.updated_at) ? Number(a.updated_at) : 0
      const cur = this.get(boot)
      if (cur && cur.updated_at >= at) continue
      const tags = [...new Set((Array.isArray(a.tags) ? a.tags : []).map(normaliseTag))]
      if (tags.length > MAX_TAGS) throw new AnnotationError(`at most ${MAX_TAGS} tags`)
      const note = typeof a.note === 'string' ? a.note.slice(0, MAX_NOTE_LEN).trim() || null : null
      this.write(boot, { bookmarked: a.bookmarked === true, note, tags }, at || Date.now(), false)
      changed++
    }
    if (mirror && changed) this.writeMirror()
    return changed
  }

  private writeMirror() {
    const tmp = `${this.mirror}.tmp`
    writeFileSync(tmp, JSON.stringify(this.export(), null, 1), { mode: 0o600 })
    renameSync(tmp, this.mirror)
  }
}

let singleton: AnnotationStore | null = null
export function getAnnotations(): AnnotationStore {
  if (!singleton) singleton = new AnnotationStore(String(useRuntimeConfig().placesDataDir))
  return singleton
}
