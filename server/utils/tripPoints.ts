// Shared by the routes that read a trip's GPS track.

const MAX_IMPLIED_MPS = 56 // ~200 kph — anything faster is a bad fix

export function distM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dx = (lon2 - lon1) * Math.cos(lat1 * Math.PI / 180) * 111320
  const dy = (lat2 - lat1) * 110540
  return Math.sqrt(dx * dx + dy * dy)
}

// Seconds between two fixes. A trip can span boots and the monotonic clock restarts at each one, so
// mono_ms across a boundary runs backwards and would discard every fix of the later boot; the wall
// clock is the only one that is comparable across them. mono_ms stays the fallback for a fix with
// no wall-clock time.
function stepSeconds(prev: any, cur: any): number {
  const a = Date.parse(prev.observed_at), b = Date.parse(cur.observed_at)
  if (Number.isFinite(a) && Number.isFinite(b) && a > Date.UTC(2000, 0, 1) && b > Date.UTC(2000, 0, 1)) return (b - a) / 1000
  return (cur.mono_ms - prev.mono_ms) / 1000
}

export function filterOutliers(positions: any[]): any[] {
  if (positions.length < 3) return positions

  const keep: any[] = [positions[0]]
  for (let i = 1; i < positions.length; i++) {
    const prev = keep[keep.length - 1]
    const cur = positions[i]
    const dt = stepSeconds(prev, cur)
    if (dt <= 0) continue
    const dm = distM(prev.lat, prev.lon, cur.lat, cur.lon)
    if (dm / dt > MAX_IMPLIED_MPS) continue
    keep.push(cur)
  }
  return keep
}

