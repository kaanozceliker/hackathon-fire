import { fbm } from './rng'
import type { Grid, Settlement } from './types'
import { haversineM } from './geo'

export const GRID_COLS = 130
export const GRID_ROWS = 100
export const CELL_M = 110

/**
 * Builds a synthetic but reproducible landscape (elevation, vegetation, land cover) around a centre point.
 * This is illustrative terrain, not surveyed DEM or land-cover data.
 * Later this can be swapped for Copernicus DEM + CORINE rasters sampled into the same Grid shape.
 */
export function buildGrid(areaId: string, center: [number, number], seed: number, settlements: Settlement[]): Grid {
  const cols = GRID_COLS
  const rows = GRID_ROWS
  const dLat = CELL_M / 111320
  const dLon = CELL_M / (111320 * Math.cos((center[0] * Math.PI) / 180))
  const lat0 = center[0] + (rows * dLat) / 2
  const lon0 = center[1] - (cols * dLon) / 2

  const n = cols * rows
  const elev = new Float32Array(n)
  const veg = new Float32Array(n)
  const kind = new Uint8Array(n)

  // Marmaris bay (only for the demo area) – an ellipse of open water north of the southern coast.
  const bay = areaId === 'mugla' ? { lat: 36.835, lon: 28.285, rx: 2300, ry: 1500 } : null

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x
      const base = fbm(x * 0.035, y * 0.035, seed, 4)
      const ridge = 1 - Math.abs(2 * fbm(x * 0.022 + 50, y * 0.022 + 50, seed + 7, 3) - 1)
      const northBias = (1 - y / rows) * 0.38
      const eNorm = Math.min(1, Math.max(0, 0.45 * base + 0.28 * ridge + northBias - 0.1))
      elev[i] = 15 + eNorm * 920

      let v = 0.2 + 1.1 * (fbm(x * 0.06, y * 0.06, seed + 31, 3) - 0.35)
      v += 0.18 * (1 - Math.abs(eNorm - 0.55) * 2)
      if (fbm(x * 0.05, y * 0.05, seed + 77, 2) > 0.7) v = 0.1 // valley fields
      veg[i] = Math.min(1, Math.max(0.05, v))

      const lat = lat0 - y * dLat
      const lon = lon0 + x * dLon
      let water = y > rows * 0.92 + 3 * Math.sin(x * 0.09 + seed)
      if (bay) {
        const dyM = (lat - bay.lat) * 111320
        const dxM = (lon - bay.lon) * 111320 * Math.cos((lat * Math.PI) / 180)
        if ((dxM / bay.rx) ** 2 + (dyM / bay.ry) ** 2 < 1) water = true
      }
      if (water) {
        kind[i] = 0
        veg[i] = 0
        elev[i] = 0
        continue
      }
      let urban = false
      for (const st of settlements) {
        if (haversineM([lat, lon], st.pos) < st.radiusM) {
          urban = true
          break
        }
      }
      if (urban) {
        kind[i] = 1
        veg[i] = 0.04
        continue
      }
      kind[i] = veg[i] < 0.22 ? 2 : veg[i] < 0.5 ? 3 : 4
    }
  }
  return { areaId, cols, rows, cellM: CELL_M, lat0, lon0, dLat, dLon, elev, veg, kind }
}

export function cellOf(grid: Grid, lat: number, lon: number): number {
  const col = Math.floor((lon - grid.lon0) / grid.dLon)
  const row = Math.floor((grid.lat0 - lat) / grid.dLat)
  if (col < 0 || row < 0 || col >= grid.cols || row >= grid.rows) return -1
  return row * grid.cols + col
}

export function cellCenter(grid: Grid, i: number): [number, number] {
  const col = i % grid.cols
  const row = Math.floor(i / grid.cols)
  return [grid.lat0 - (row + 0.5) * grid.dLat, grid.lon0 + (col + 0.5) * grid.dLon]
}

export function gridBounds(grid: Grid): [[number, number], [number, number]] {
  return [
    [grid.lat0 - grid.rows * grid.dLat, grid.lon0],
    [grid.lat0, grid.lon0 + grid.cols * grid.dLon],
  ]
}
