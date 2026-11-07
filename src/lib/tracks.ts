import { haversineM } from '../sim/geo'
import type { ResponseRecord } from '../sim/types'

/** The latest trip under way at step `s` (a newer order replaces an older trip). */
export function activeMove(moves: ResponseRecord['tracks'][number]['moves'], s: number) {
  for (let k = moves.length - 1; k >= 0; k--) {
    const m = moves[k]
    if (m.fromStep <= s) return s < m.toStep ? m : null
  }
  return null
}

const pathLengths = new WeakMap<[number, number][], number[]>()
/** Point at fraction `f` (0–1) of a path's length, at even speed. */
export function alongPath(path: [number, number][], f: number): [number, number] {
  let cum = pathLengths.get(path)
  if (!cum) {
    cum = [0]
    for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + haversineM(path[i - 1], path[i]))
    pathLengths.set(path, cum)
  }
  const target = Math.min(1, Math.max(0, f)) * cum[cum.length - 1]
  let i = 1
  while (i < path.length - 1 && cum[i] < target) i++
  const t = (target - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1])
  return [path[i - 1][0] + (path[i][0] - path[i - 1][0]) * t, path[i - 1][1] + (path[i][1] - path[i - 1][1]) * t]
}


/** Position of a resource track at fractional step `s`: along its trip if under way, else between samples. */
export function trackPosition(tr: ResponseRecord['tracks'][number], s: number): { ll: [number, number]; status: ResponseRecord['tracks'][number]['points'][number]['status'] } | null {
  const pts = tr.points
  let lo = 0
  let hi = pts.length - 1
  let i = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (pts[mid].step <= s) {
      i = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  if (i < 0 || pts[i].status === 'unavailable') return null
  const p0 = pts[i]
  const p1 = pts[i + 1]
  const mv = activeMove(tr.moves, s)
  if (mv) return { ll: alongPath(mv.path, (s - mv.fromStep) / Math.max(1e-6, mv.toStep - mv.fromStep)), status: p0.status }
  const f = p1 && p1.step === p0.step + 1 ? Math.min(1, Math.max(0, s - p0.step)) : 0
  return { ll: p1 ? [p0.lat + (p1.lat - p0.lat) * f, p0.lon + (p1.lon - p0.lon) * f] : [p0.lat, p0.lon], status: p0.status }
}
