// Shared by the routes that read a trip's GPS track.

const MAX_IMPLIED_MPS = 56 // ~200 kph — anything faster is a bad fix

export function distM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dx = (lon2 - lon1) * Math.cos(lat1 * Math.PI / 180) * 111320
  const dy = (lat2 - lat1) * 110540
  return Math.sqrt(dx * dx + dy * dy)
}

export function filterOutliers(positions: any[]): any[] {
  if (positions.length < 3) return positions

  const keep: any[] = [positions[0]]
  for (let i = 1; i < positions.length; i++) {
    const prev = keep[keep.length - 1]
    const cur = positions[i]
    const dt = (cur.mono_ms - prev.mono_ms) / 1000
    if (dt <= 0) continue
    const dm = distM(prev.lat, prev.lon, cur.lat, cur.lon)
    if (dm / dt > MAX_IMPLIED_MPS) continue
    keep.push(cur)
  }
  return keep
}

