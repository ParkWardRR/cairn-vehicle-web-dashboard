// Draws a trip's route to a PNG in the browser. No map tiles are fetched, so nothing about the
// trip leaves this device. The data it draws from is already redacted by the server
// (/api/trips/:bootId/image-data): privacy zones removed, the true start and end never included.

interface Seg { lat: number; lon: number; speed_kph: number | null }
export interface ImageData {
  segments: Seg[][]
  summary: { day: string | null; duration_s: number; distance_m: number; max_speed_kph: number }
  redaction: { trim_m: number; zones: number; points_removed: number }
}

const W = 1600
const H = 1000

// blue (slow) through amber to red (fast)
function speedColour(kph: number | null, max: number): string {
  const t = kph == null || max <= 0 ? 0 : Math.min(1, kph / max)
  const hue = 215 - 215 * t   // 215 (blue) → 0 (red)
  return `hsl(${hue.toFixed(0)} 85% ${t > 0.35 && t < 0.6 ? 52 : 56}%)`
}

export function drawTripImage(canvas: HTMLCanvasElement, d: ImageData, scale: number, dark = true): void {
  canvas.width = W * scale
  canvas.height = H * scale
  const g = canvas.getContext('2d')!
  g.scale(scale, scale)
  const bg = dark ? '#0f1117' : '#f8f9fb', fg = dark ? '#e8eaf0' : '#1a1d27', dim = dark ? '#8b90a0' : '#5b6070'
  g.fillStyle = bg
  g.fillRect(0, 0, W, H)

  const pts = d.segments.flat()
  const header = 120, footer = 70, pad = 90
  if (!pts.length) return
  const lat0 = pts.reduce((n, p) => n + p.lat, 0) / pts.length
  const kx = Math.cos(lat0 * Math.PI / 180)
  const xs = pts.map(p => p.lon * kx), ys = pts.map(p => -p.lat)
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys)
  const spanX = Math.max(maxX - minX, 1e-9), spanY = Math.max(maxY - minY, 1e-9)
  const availW = W - pad * 2, availH = H - header - footer - pad
  const s = Math.min(availW / spanX, availH / spanY)
  const ox = pad + (availW - spanX * s) / 2, oy = header + (availH - spanY * s) / 2
  const px = (p: Seg) => ox + (p.lon * kx - minX) * s
  const py = (p: Seg) => oy + (-p.lat - minY) * s

  const max = Math.max(d.summary.max_speed_kph, ...pts.map(p => p.speed_kph ?? 0), 1)
  g.lineCap = 'round'
  g.lineJoin = 'round'
  for (const seg of d.segments) {
    // a soft halo under the line, then the line coloured by speed
    g.strokeStyle = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'
    g.lineWidth = 14
    g.beginPath(); seg.forEach((p, i) => (i ? g.lineTo(px(p), py(p)) : g.moveTo(px(p), py(p)))); g.stroke()
    g.lineWidth = 6
    for (let i = 1; i < seg.length; i++) {
      g.strokeStyle = speedColour(seg[i].speed_kph, max)
      g.beginPath(); g.moveTo(px(seg[i - 1]), py(seg[i - 1])); g.lineTo(px(seg[i]), py(seg[i])); g.stroke()
    }
  }

  const sans = 'Inter, system-ui, -apple-system, sans-serif'
  const miles = d.summary.distance_m / 1609.344
  const mins = Math.round(d.summary.duration_s / 60)
  const dur = mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`
  const day = d.summary.day ? new Date(`${d.summary.day}T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : 'A drive'
  g.fillStyle = fg
  g.font = `600 44px ${sans}`
  g.fillText(day, pad, 78)
  g.fillStyle = dim
  g.font = `400 26px ${sans}`
  g.fillText(`${miles.toFixed(miles < 100 ? 1 : 0)} mi  ·  ${dur}  ·  top ${Math.round(d.summary.max_speed_kph / 1.60934)} mph`, pad, 114)

  g.font = `400 20px ${sans}`
  g.fillText(`Start and end hidden${d.redaction.zones ? ' · private places removed' : ''} · drawn on this device, no map`, pad, H - 28)
  g.textAlign = 'right'
  g.fillStyle = fg
  g.font = `600 22px ${sans}`
  g.fillText('CAIRN', W - pad, H - 28)
  g.textAlign = 'left'
}

export function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('could not make the picture'))), 'image/png'))
}
