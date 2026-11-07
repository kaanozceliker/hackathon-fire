export type LatLon = [number, number]

export function haversineM(a: LatLon, b: LatLon): number {
  const R = 6371000
  const dLat = ((b[0] - a[0]) * Math.PI) / 180
  const dLon = ((b[1] - a[1]) * Math.PI) / 180
  const la1 = (a[0] * Math.PI) / 180
  const la2 = (b[0] * Math.PI) / 180
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

export function polylineLengthM(pts: LatLon[]): number {
  let t = 0
  for (let i = 1; i < pts.length; i++) t += haversineM(pts[i - 1], pts[i])
  return t
}

/** Resample a polyline to roughly `stepM` spacing, keeping original vertices out of the way. */
export function densify(pts: LatLon[], stepM: number): LatLon[] {
  const out: LatLon[] = [pts[0]]
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    const n = Math.max(1, Math.round(haversineM(a, b) / stepM))
    for (let k = 1; k <= n; k++) {
      const t = k / n
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
    }
  }
  return out
}

const DIRS = ['K', 'KKD', 'KD', 'DKD', 'D', 'DGD', 'GD', 'GGD', 'G', 'GGB', 'GB', 'BGB', 'B', 'BKB', 'KB', 'KKB']
export function compass(deg: number): string {
  return DIRS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]
}

export function fmtDuration(min: number): string {
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  return `${h}:${String(m).padStart(2, '0')}`
}
