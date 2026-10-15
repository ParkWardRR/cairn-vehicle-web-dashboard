export type StopCategory = 'short' | 'medium' | 'long'

export interface Stop {
  // Wall-clock start, or null when the trip has no trustworthy UTC basis.
  start_at: string | null
  // Seconds from the trip's first fix; always available.
  start_offset_s: number
  // The device's monotonic times at the stop's first and last fix. Only comparable within one
  // boot: a trip can span boots and mono_ms restarts at each.
  start_mono_ms: number
  end_mono_ms: number
  // The same two moments on the trip's clock (shared/utils/tripClock.ts): wall-clock ms when the
  // trip has a UTC basis, else mono_ms. This is what places a stop on the trip scrubber.
  start_t_ms: number
  end_t_ms: number
  duration_s: number
  lat: number
  lon: number
  category: StopCategory
  // True when the stop is inferred from a silence in GPS fixes between two
  // nearby points, rather than observed as a run of stationary fixes.
  inferred: boolean
}

export interface StopFix {
  lat: number
  lon: number
  speed_mps: number | null
  mono_ms: number
  observed_at: string | null
}

// Some bundles carry no UTC basis, so their fixes decode to 1970. Wall-clock
// time is therefore rebuilt as one base for the trip plus each fix's monotonic
// offset, taking the base from any fix whose own timestamp is plausible.
export function tripBaseMs(fixes: StopFix[]): number | null {
  for (const f of fixes) {
    if (!f.observed_at) continue
    const t = Date.parse(f.observed_at)
    if (Number.isFinite(t) && t > Date.parse('2020-01-01T00:00:00Z')) return t - f.mono_ms
  }
  return null
}

// Each fix's time on the trip's clock, in ms, and whether that is a wall clock.
//
// A fix with a plausible timestamp of its own is placed by it. One without (a bundle that lost its
// UTC basis) is placed by the base of the nearest plausible fix before it, or failing that the first
// one after it, plus its own mono_ms: the base belongs to one boot, and a trip can span several. A
// trip with no plausible fix at all is placed on mono_ms alone.
function fixTimes(fixes: StopFix[]): { t: number[]; wall: boolean } {
  let base = tripBaseMs(fixes)
  if (base == null) return { t: fixes.map(f => f.mono_ms), wall: false }
  const floor = Date.parse('2020-01-01T00:00:00Z')
  const t = fixes.map((f) => {
    const own = f.observed_at ? Date.parse(f.observed_at) : NaN
    if (Number.isFinite(own) && own > floor) {
      base = own - f.mono_ms
      return own
    }
    return base! + f.mono_ms
  })
  return { t, wall: true }
}

// What counts as a stop, and how long each kind is, in seconds. Anything under
// MIN_STOP_S is a light or a queue and is not reported.
//   short  3-5 min    a pickup, a drive-through, a quick errand
//   medium 5-20 min   a shop, a meal to go
//   long   20+ min    parked for a while
export const MIN_STOP_S = 180
export const SHORT_MAX_S = 300
export const MEDIUM_MAX_S = 1200
const STILL_RADIUS_M = 60
const STILL_SPEED_MPS = 1.5
// The device records sparsely while stationary, so a pause in fixes between two
// nearby points is itself evidence of a stop.
const SILENT_GAP_S = 120
const SILENT_GAP_RADIUS_M = 400

function distM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dx = (lon2 - lon1) * Math.cos(lat1 * Math.PI / 180) * 111320
  const dy = (lat2 - lat1) * 110540
  return Math.sqrt(dx * dx + dy * dy)
}

export function categorize(durationS: number): StopCategory {
  if (durationS <= SHORT_MAX_S) return 'short'
  if (durationS <= MEDIUM_MAX_S) return 'medium'
  return 'long'
}

// Finds the places the vehicle stopped, from fixes in time order (by observed_at,
// not mono_ms, for a trip that spans boots).
//
// The first and last fixes are the trip's own start and end, which the map
// already marks, so a stop that touches either end is not reported.
export function detectStops(fixes: StopFix[]): Stop[] {
  if (fixes.length < 3) return []
  const { t, wall } = fixTimes(fixes)

  interface Run { from: number; to: number; secs: number; inferred: boolean }
  const runs: Run[] = []
  let cur: Run | null = null

  for (let i = 1; i < fixes.length; i++) {
    const a = fixes[i - 1]
    const b = fixes[i]
    const dt = (t[i] - t[i - 1]) / 1000
    if (dt <= 0) continue
    const dist = distM(a.lat, a.lon, b.lat, b.lon)

    const slow = (b.speed_mps ?? 0) < STILL_SPEED_MPS
    const observed = dist < STILL_RADIUS_M && (slow || dt > 20)
    const silent = dt >= SILENT_GAP_S && dist < SILENT_GAP_RADIUS_M

    if (observed || silent) {
      if (!cur) {
        cur = { from: i - 1, to: i, secs: 0, inferred: false }
        runs.push(cur)
      }
      cur.to = i
      cur.secs += dt
      if (silent && !observed) cur.inferred = true
    } else {
      cur = null
    }
  }

  const stops: Stop[] = []
  for (const r of runs) {
    if (r.secs < MIN_STOP_S) continue
    if (r.from === 0 || r.to === fixes.length - 1) continue

    const pts = fixes.slice(r.from, r.to + 1)
    const lat = pts.reduce((s, p) => s + p.lat, 0) / pts.length
    const lon = pts.reduce((s, p) => s + p.lon, 0) / pts.length
    stops.push({
      start_at: wall ? new Date(t[r.from]).toISOString() : null,
      start_offset_s: Math.round((t[r.from] - t[0]) / 1000),
      start_mono_ms: fixes[r.from].mono_ms,
      end_mono_ms: fixes[r.to].mono_ms,
      start_t_ms: t[r.from],
      end_t_ms: t[r.to],
      duration_s: Math.round(r.secs),
      lat,
      lon,
      category: categorize(r.secs),
      inferred: r.inferred,
    })
  }
  return stops
}
