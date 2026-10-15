// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { filterOutliers } from '../server/utils/tripPoints'

// A fix a second apart, 11 m/s north: lat step 0.0001 degree is ~11 m.
const fix = (i: number, boot: number, monoMs: number, at: string) => ({ boot, mono_ms: monoMs, observed_at: at, lat: 34 + i * 0.0001, lon: -118 })

describe('filterOutliers', () => {
  it('keeps a trip\'s second boot: mono_ms restarts at a boot, the wall clock does not', () => {
    const a = [0, 1, 2].map(i => fix(i, 1, 900_000 + i * 1000, `2026-10-15T02:00:0${i}.000Z`))
    // The second boot starts its monotonic clock again, so every mono_ms here is smaller than the last of boot one.
    const b = [3, 4, 5].map(i => fix(i, 2, 1000 + (i - 3) * 1000, `2026-10-15T02:00:0${i}.000Z`))
    expect(filterOutliers([...a, ...b])).toHaveLength(6)
  })

  it('still drops a fix that is implausibly far from the last one', () => {
    const pts = [0, 1, 2, 3].map(i => fix(i, 1, i * 1000, `2026-10-15T02:00:0${i}.000Z`))
    pts[2] = { ...pts[2], lat: 35 } // 111 km in a second
    expect(filterOutliers(pts).map(p => p.mono_ms)).toEqual([0, 1000, 3000])
  })

  it('falls back to mono_ms for fixes with no wall-clock time', () => {
    const pts = [0, 1, 2].map(i => ({ mono_ms: i * 1000, observed_at: null, lat: 34 + i * 0.0001, lon: -118 }))
    expect(filterOutliers(pts)).toHaveLength(3)
  })
})
