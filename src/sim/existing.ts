import { EXISTING } from '../data/existing.generated'
import { BURNSCARS } from '../data/burnscars.generated'
import MANUAL from '../data/existingMeasures.json'
import { haversineM, type LatLon } from './geo'
import { cellOf } from './terrain'
import type { Grid, SimConfig } from './types'

/**
 * Fire protection that already exists in an area, applied to every run unless `config.ignoreExisting`:
 * - roads (OSM) and mapped fire breaks (OSM + existingMeasures.json) are partial fuel breaks,
 * - recent burn scars (Sentinel-2 dNBR, fire seasons 2018–2025) carry less fuel while the vegetation grows back,
 * - lookout towers and cameras let the fire be spotted earlier,
 * - fire ponds and water tanks are extra water points, summer bases extra crews.
 */

export interface ExistingMeasures {
  towers: { name: string; pos: LatLon; rangeKm: number; source: string }[]
  ponds: { name: string; pos: LatLon; source: string }[]
  firebreaks: { name: string; geom: LatLon[]; widthM: number; source: string }[]
  bases: { name: string; pos: LatLon; crews: number; dozers: number; source: string }[]
  /** Road class per cell: 0 none, 1 minor / forest track, 2 secondary, 3 major. */
  roads: Uint8Array | null
  /** Last burn year per cell − 2000, 0 = none. */
  burnYear: Uint8Array | null
}

/** Earlier detection when a lookout tower or camera sees the ignition. */
export const DETECTION_GAIN_MIN = 20
const ROAD_MULT = [1, 0.85, 0.7, 0.55]

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
type Manual = { towers: { name: string; pos: number[]; rangeKm?: number; source?: string }[]; ponds: { name: string; pos: number[]; source?: string }[]; firebreaks: { name: string; path: number[][]; widthM?: number; source?: string }[]; bases: { name: string; pos: number[]; crews?: number; dozers?: number; source?: string }[] }

const cache = new Map<string, ExistingMeasures>()
export function existingFor(areaId: string): ExistingMeasures {
  let v = cache.get(areaId)
  if (v) return v
  const osm = EXISTING[areaId]
  const man = (MANUAL.regions as Record<string, Manual>)[areaId]
  const ll = (p: number[]): LatLon => [p[0], p[1]]
  // the same pond is sometimes mapped twice
  const ponds: ExistingMeasures['ponds'] = []
  for (const p of [...(man?.ponds ?? []).map((x) => ({ name: x.name, pos: ll(x.pos), source: x.source ?? 'Elle girildi' })), ...(osm?.ponds ?? []).map((x) => ({ name: x.name, pos: x.pos, source: 'OpenStreetMap' }))])
    if (!ponds.some((q) => haversineM(q.pos, p.pos) < 100)) ponds.push(p)
  v = {
    towers: [...(man?.towers ?? []).map((x) => ({ name: x.name, pos: ll(x.pos), rangeKm: x.rangeKm ?? 15, source: x.source ?? 'Elle girildi' })), ...(osm?.towers ?? []).map((x) => ({ name: x.name, pos: x.pos, rangeKm: 15, source: 'OpenStreetMap' }))],
    ponds,
    firebreaks: [...(man?.firebreaks ?? []).map((x) => ({ name: x.name, geom: x.path.map(ll), widthM: x.widthM ?? 30, source: x.source ?? 'Elle girildi' })), ...(osm?.firebreaks ?? []).map((x) => ({ name: x.name, geom: x.geom, widthM: x.widthM || 30, source: 'OpenStreetMap' }))],
    bases: (man?.bases ?? []).map((x) => ({ name: x.name, pos: ll(x.pos), crews: x.crews ?? 2, dozers: x.dozers ?? 0, source: x.source ?? 'Elle girildi' })),
    roads: osm ? b64(osm.roads) : null,
    burnYear: BURNSCARS[areaId] ? b64(BURNSCARS[areaId]) : null,
  }
  cache.set(areaId, v)
  return v
}

/** The year of the simulated fire: burn scars of that season or later do not exist yet. */
export const simYear = (config: SimConfig) => (config.weather ? Number(config.weather.startIso.slice(0, 4)) : new Date().getFullYear())

/** Fuel left on a burn scar `age` years later (forest regrows slower than maquis). */
export function scarFuel(kind: number, age: number): number {
  if (age < 1) return 1
  return kind === 4 ? Math.min(1, 0.2 + 0.1 * age) : Math.min(1, 0.3 + 0.17 * age)
}

/** Cells along a line, sampled every ~30 m. */
export function lineCells(grid: Grid, geom: LatLon[]): number[] {
  const out = new Set<number>()
  for (let k = 1; k < geom.length; k++) {
    const [a, b] = [geom[k - 1], geom[k]]
    const steps = Math.max(1, Math.ceil(haversineM(a, b) / 30))
    for (let s = 0; s <= steps; s++) {
      const c = cellOf(grid, a[0] + ((b[0] - a[0]) * s) / steps, a[1] + ((b[1] - a[1]) * s) / steps)
      if (c >= 0) out.add(c)
    }
  }
  return [...out]
}

const multCache = new Map<string, Float32Array>()
/** Fuel multiplier per cell from roads, fire breaks and burn scars (1 = unchanged). */
export function existingFuelMult(grid: Grid, year: number): Float32Array {
  const key = `${grid.areaId}:${year}`
  let m = multCache.get(key)
  if (m) return m
  const ex = existingFor(grid.areaId)
  const n = grid.cols * grid.rows
  m = new Float32Array(n).fill(1)
  if (ex.roads) for (let i = 0; i < n; i++) m[i] = ROAD_MULT[ex.roads[i]]
  for (const fb of ex.firebreaks) {
    // a break narrower than the cell removes that share of the fuel; wide breaks almost all of it
    const f = Math.max(0.12, 1 - Math.min(1, fb.widthM / grid.cellM) * 0.9)
    for (const c of lineCells(grid, fb.geom)) m[c] = Math.min(m[c], f)
  }
  if (ex.burnYear)
    for (let i = 0; i < n; i++) {
      const y = ex.burnYear[i]
      if (y && 2000 + y < year) m[i] *= scarFuel(grid.kind[i], year - 2000 - y)
    }
  multCache.set(key, m)
  return m
}

/** Burned area (ha) per fire season within the grid, seasons before `year` only. */
export function burnScarSummary(grid: Grid, year: number): { year: number; ha: number }[] {
  const ex = existingFor(grid.areaId)
  if (!ex.burnYear) return []
  const haC = (grid.cellM * grid.cellM) / 10000
  const by = new Map<number, number>()
  for (const y of ex.burnYear) if (y && 2000 + y < year) by.set(2000 + y, (by.get(2000 + y) ?? 0) + haC)
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([y, ha]) => ({ year: y, ha: Math.round(ha) }))
}

/** The nearest lookout tower that sees this point, if any. */
export function towerSeeing(areaId: string, pos: LatLon): ExistingMeasures['towers'][number] | null {
  let best: ExistingMeasures['towers'][number] | null = null
  let bd = Infinity
  for (const t of existingFor(areaId).towers) {
    const d = haversineM(t.pos, pos)
    if (d <= t.rangeKm * 1000 && d < bd) {
      bd = d
      best = t
    }
  }
  return best
}
