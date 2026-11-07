import { regionById } from '../data/regions'
import { buildGrid } from './terrain'
import type { Grid } from './types'

const cache = new Map<string, Grid>()
export function getGrid(areaId: string): Grid {
  let g = cache.get(areaId)
  if (!g) {
    const r = regionById(areaId)
    g = buildGrid(r.id, r.center, r.seed, r.settlements)
    cache.set(areaId, g)
  }
  return g
}
