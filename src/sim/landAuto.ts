import { haversineM, type LatLon } from './geo'
import { cellCenter, cellOf } from './terrain'
import type { Grid, TerrainType } from './types'

/**
 * "Arazi ve yakıt" worked out from data instead of set by hand:
 * - terrain class from the slope of the real elevation (Copernicus DEM, baked) within 1.5 km of the ignition,
 * - fuel state from how dry the vegetation is on the latest clear Sentinel-2 pass before the fire date: the
 *   Normalized Difference Moisture Index NDMI = (NIR − SWIR1) / (NIR + SWIR1) of vegetation pixels within 2 km.
 *   Low NDMI = dry leaves and needles = fire spreads more easily. Read in the browser from the public Earth Search
 *   STAC (AWS, Copernicus data); nothing is stored.
 */

export interface LandAuto {
  terrain: { meanSlopePct: number; steepPct: number }
  fuel: { ndmi: number; date: string; sceneId: string; cloudPct: number } | { fallback: string }
  /**
   * Current vegetation per grid cell from the latest clear Sentinel-2 passes (scene classification): base64, one
   * byte per cell, share of vegetated pixels 0–254, 255 = no clear data. Bare ground, rock and recent burns show
   * up here even where the 2021 land-cover map still has forest.
   */
  cover?: { b64: string; date: string; barePct: number } | null
}

/** Slope of a cell (%): magnitude of the elevation gradient from its neighbours (central differences). */
function slopePct(grid: Grid, i: number): number {
  const x = i % grid.cols
  const y = (i / grid.cols) | 0
  const e = (xx: number, yy: number) => grid.elev[Math.min(grid.rows - 1, Math.max(0, yy)) * grid.cols + Math.min(grid.cols - 1, Math.max(0, xx))]
  const dx = (e(x + 1, y) - e(x - 1, y)) / (2 * grid.cellM)
  const dy = (e(x, y + 1) - e(x, y - 1)) / (2 * grid.cellM)
  return Math.hypot(dx, dy) * 100
}

/** Terrain class from the land within `radiusM` of the point. */
export function autoTerrain(grid: Grid, at: LatLon, radiusM = 1500): { terrain: TerrainType; meanSlopePct: number; steepPct: number } {
  const c0 = cellOf(grid, at[0], at[1])
  let sum = 0
  let steep = 0
  let n = 0
  if (c0 >= 0) {
    const R = Math.ceil(radiusM / grid.cellM)
    const x0 = c0 % grid.cols
    const y0 = (c0 / grid.cols) | 0
    for (let dy = -R; dy <= R; dy++)
      for (let dx = -R; dx <= R; dx++) {
        const x = x0 + dx
        const y = y0 + dy
        if (x < 0 || y < 0 || x >= grid.cols || y >= grid.rows) continue
        const i = y * grid.cols + x
        if (grid.kind[i] === 0 || haversineM(cellCenter(grid, i), at) > radiusM) continue
        const s = slopePct(grid, i)
        sum += s
        if (s > 30) steep++
        n++
      }
  }
  const meanSlopePct = n ? sum / n : 0
  const steepPct = n ? (steep / n) * 100 : 0
  // thresholds on the mean slope around the start (1.5 km): flat below 8 %, steep above 22 %
  const terrain: TerrainType = meanSlopePct < 8 ? 'coastal-plain' : meanSlopePct < 22 ? 'rolling-hills' : 'steep-mountain'
  return { terrain, meanSlopePct, steepPct }
}

/**
 * Fuel multiplier from NDMI (approximate mapping for Mediterranean pine and maquis): ~0.15 is a normal summer
 * canopy (×1.0), ≤ −0.05 very dry (×1.4), ≥ 0.35 moist (×0.6).
 */
export const fuelFromNdmi = (ndmi: number) => Math.min(1.4, Math.max(0.6, 1 + (0.15 - ndmi) * 2))

/** Seasonal fallback when no clear pass is available: dry summers, moist winters. */
export function seasonalFuel(month: number): number {
  return [0.75, 0.75, 0.8, 0.85, 0.95, 1.1, 1.2, 1.25, 1.15, 1, 0.85, 0.75][month - 1]
}

/** UTM forward projection (WGS84) for a zone. */
function toUtm(lat: number, lon: number, zone: number): [number, number] {
  const a = 6378137
  const f = 1 / 298.257223563
  const k0 = 0.9996
  const e2 = f * (2 - f)
  const ep2 = e2 / (1 - e2)
  const phi = (lat * Math.PI) / 180
  const lam = ((lon - (zone * 6 - 183)) * Math.PI) / 180
  const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2)
  const T = Math.tan(phi) ** 2
  const C = ep2 * Math.cos(phi) ** 2
  const A = lam * Math.cos(phi)
  const M = a * ((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * phi - ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * phi) + ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi) - ((35 * e2 ** 3) / 3072) * Math.sin(6 * phi))
  const x = k0 * N * (A + ((1 - T + C) * A ** 3) / 6 + ((5 - 18 * T + T ** 2 + 72 * C - 58 * ep2) * A ** 5) / 120) + 500000
  const y = k0 * (M + N * Math.tan(phi) * (A ** 2 / 2 + ((5 - T + 9 * C + 4 * C ** 2) * A ** 4) / 24 + ((61 - 58 * T + T ** 2 + 600 * C - 330 * ep2) * A ** 6) / 720))
  return [x, y]
}

const fuelCache = new Map<string, Promise<LandAuto['fuel']>>()

/** NDMI of the vegetation around `at` on the latest clear Sentinel-2 pass in the 45 days before `dateIso`. */
export function fuelState(at: LatLon, dateIso: string, radiusM = 2000): Promise<LandAuto['fuel']> {
  const today = new Date().toISOString().slice(0, 10)
  const end = dateIso.slice(0, 10) > today ? today : dateIso.slice(0, 10)
  const key = `${at[0].toFixed(3)},${at[1].toFixed(3)},${end}`
  let p = fuelCache.get(key)
  if (!p) {
    p = readFuel(at, end, radiusM).catch((e: Error) => ({ fallback: e.message }))
    fuelCache.set(key, p)
  }
  return p
}

async function readFuel(at: LatLon, end: string, radiusM: number): Promise<LandAuto['fuel']> {
  const start = new Date(new Date(end).getTime() - 45 * 86400000).toISOString().slice(0, 10)
  const r = await fetch('https://earth-search.aws.element84.com/v1/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      collections: ['sentinel-2-l2a'],
      intersects: { type: 'Point', coordinates: [at[1], at[0]] },
      datetime: `${start}T00:00:00Z/${end}T23:59:59Z`,
      query: { 'eo:cloud_cover': { lt: 40 } },
      sortby: [{ field: 'properties.datetime', direction: 'desc' }],
      limit: 6,
    }),
  })
  if (!r.ok) throw new Error(`uydu kataloğu yanıt vermedi (${r.status})`)
  const feats = ((await r.json()).features ?? []) as any[]
  if (!feats.length) throw new Error('son 45 günde bulutsuz uydu geçişi yok')
  const { fromUrl } = await import('geotiff')
  for (const f of feats) {
    try {
      const zone = Number(String(f.properties['proj:epsg'] ?? f.properties['proj:code'] ?? '32635').slice(-2))
      const [ux, uy] = toUtm(at[0], at[1], zone)
      const imgs = await Promise.all([f.assets.nir08.href, f.assets.swir16.href, f.assets.scl.href].map(async (u: string) => (await fromUrl(u)).getImage()))
      const [ox, oy] = imgs[0].getOrigin()
      const [rx, ry] = imgs[0].getResolution()
      const cx = Math.floor((ux - ox) / rx)
      const cy = Math.floor((uy - oy) / ry)
      const R = Math.ceil(radiusM / rx)
      const win = [Math.max(0, cx - R), Math.max(0, cy - R), Math.min(imgs[0].getWidth(), cx + R), Math.min(imgs[0].getHeight(), cy + R)]
      if (win[2] <= win[0] || win[3] <= win[1]) continue
      const [[nir], [swir], [scl]] = (await Promise.all(imgs.map((im) => im.readRasters({ window: win })))) as unknown as [Uint16Array][]
      const w = win[2] - win[0]
      let sum = 0
      let n = 0
      for (let j = 0; j < nir.length; j++) {
        if (scl[j] !== 4) continue // vegetation only
        const px = win[0] + (j % w) - cx
        const py = win[1] + ((j / w) | 0) - cy
        if (px * px + py * py > R * R) continue
        const a = nir[j]
        const b = swir[j]
        if (a + b === 0) continue
        sum += (a - b) / (a + b)
        n++
      }
      if (n < 150) continue
      return { ndmi: sum / n, date: String(f.properties.datetime).slice(0, 10), sceneId: f.id, cloudPct: Math.round(f.properties['eo:cloud_cover'] ?? 0) }
    } catch {
      // try the next pass
    }
  }
  throw new Error('yakın geçişlerde bitki pikseli bulutsuz değil')
}

const shareCache = new Map<string, Uint8Array>()
/** Decoded per-cell vegetation share of `LandAuto.cover`. */
export function liveCoverShare(b64: string, n: number): Uint8Array | null {
  let v = shareCache.get(b64)
  if (!v) {
    v = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))
    shareCache.set(b64, v)
  }
  return v.length === n ? v : null
}

const coverCache = new Map<string, Promise<LandAuto['cover']>>()

/** Share of vegetated 20 m pixels in every grid cell on the latest clear passes in the 45 days before `dateIso`. */
export function liveCover(grid: Grid, dateIso: string): Promise<LandAuto['cover']> {
  const today = new Date().toISOString().slice(0, 10)
  const end = dateIso.slice(0, 10) > today ? today : dateIso.slice(0, 10)
  const key = `${grid.areaId}:${end}`
  let p = coverCache.get(key)
  if (!p) {
    p = readCover(grid, end).catch(() => null)
    coverCache.set(key, p)
  }
  return p
}

async function readCover(grid: Grid, end: string): Promise<LandAuto['cover']> {
  const start = new Date(new Date(end).getTime() - 45 * 86400000).toISOString().slice(0, 10)
  const bbox = [grid.lon0, grid.lat0 - grid.rows * grid.dLat, grid.lon0 + grid.cols * grid.dLon, grid.lat0]
  const r = await fetch('https://earth-search.aws.element84.com/v1/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      collections: ['sentinel-2-l2a'],
      bbox,
      datetime: `${start}T00:00:00Z/${end}T23:59:59Z`,
      query: { 'eo:cloud_cover': { lt: 30 } },
      sortby: [{ field: 'properties.datetime', direction: 'desc' }],
      limit: 12,
    }),
  })
  if (!r.ok) return null
  const feats = ((await r.json()).features ?? []) as any[]
  const n = grid.cols * grid.rows
  const veg = new Uint16Array(n)
  const valid = new Uint16Array(n)
  const done = new Uint8Array(n)
  let filled = 0
  let landCells = 0
  for (let i = 0; i < n; i++) if (grid.kind[i] !== 0) landCells++
  let date = ''
  const { fromUrl } = await import('geotiff')
  for (const f of feats.slice(0, 6)) {
    if (filled >= landCells * 0.97) break
    try {
      const zone = Number(String(f.properties['proj:epsg'] ?? f.properties['proj:code'] ?? '32635').slice(-2))
      const img = await (await fromUrl(f.assets.scl.href as string)).getImage()
      const [ox, oy] = img.getOrigin()
      const [rx, ry] = img.getResolution()
      const corners = [[grid.lat0, grid.lon0], [grid.lat0, bbox[2]], [bbox[1], grid.lon0], [bbox[1], bbox[2]]].map(([la, lo]) => toUtm(la, lo, zone))
      const xs = corners.map((c) => c[0])
      const ys = corners.map((c) => c[1])
      const win = [
        Math.max(0, Math.floor((Math.min(...xs) - ox) / rx)),
        Math.max(0, Math.floor((Math.max(...ys) - oy) / ry)),
        Math.min(img.getWidth(), Math.ceil((Math.max(...xs) - ox) / rx)),
        Math.min(img.getHeight(), Math.ceil((Math.min(...ys) - oy) / ry)),
      ]
      if (win[2] <= win[0] || win[3] <= win[1]) continue
      const [scl] = (await img.readRasters({ window: win })) as unknown as Uint8Array[]
      const w = win[2] - win[0]
      const h = win[3] - win[1]
      // per pixel: back to the grid cell it falls in
      const sv = new Uint16Array(n)
      const sn = new Uint16Array(n)
      for (let py = 0; py < h; py += 1)
        for (let px = 0; px < w; px += 1) {
          const s = scl[py * w + px]
          // 4 vegetation, 5 not vegetated (bare), 6 water; skip clouds, shadows, no data
          if (s !== 4 && s !== 5 && s !== 6) continue
          const ux = ox + (win[0] + px + 0.5) * rx
          const uy = oy + (win[1] + py + 0.5) * ry
          const [la, lo] = fromUtm(ux, uy, zone)
          const c = cellOf(grid, la, lo)
          if (c < 0 || done[c]) continue
          sn[c]++
          if (s === 4) sv[c]++
        }
      let used = 0
      for (let i = 0; i < n; i++) {
        if (done[i] || sn[i] < 12) continue
        veg[i] = sv[i]
        valid[i] = sn[i]
        done[i] = 1
        if (grid.kind[i] !== 0) filled++
        used++
      }
      if (used && !date) date = String(f.properties.datetime).slice(0, 10)
    } catch {
      // try the next pass
    }
  }
  if (!filled) return null
  const out = new Uint8Array(n).fill(255)
  let bare = 0
  for (let i = 0; i < n; i++) {
    if (!done[i]) continue
    out[i] = Math.round((veg[i] / valid[i]) * 254)
    if (grid.kind[i] >= 2 && out[i] < 40) bare++
  }
  let b = ''
  for (let i = 0; i < n; i += 8192) b += String.fromCharCode(...out.subarray(i, i + 8192))
  return { b64: btoa(b), date, barePct: (bare / Math.max(1, landCells)) * 100 }
}

/** UTM inverse projection (WGS84) for a zone: easting, northing -> lat, lon. */
function fromUtm(x: number, y: number, zone: number): [number, number] {
  const a = 6378137
  const f = 1 / 298.257223563
  const k0 = 0.9996
  const e2 = f * (2 - f)
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2))
  const ep2 = e2 / (1 - e2)
  const M = y / k0
  const mu = M / (a * (1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256))
  const phi1 = mu + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) + ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu)
  const N1 = a / Math.sqrt(1 - e2 * Math.sin(phi1) ** 2)
  const T1 = Math.tan(phi1) ** 2
  const C1 = ep2 * Math.cos(phi1) ** 2
  const R1 = (a * (1 - e2)) / Math.pow(1 - e2 * Math.sin(phi1) ** 2, 1.5)
  const D = (x - 500000) / (N1 * k0)
  const lat = phi1 - ((N1 * Math.tan(phi1)) / R1) * (D ** 2 / 2 - ((5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * ep2) * D ** 4) / 24 + ((61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * ep2 - 3 * C1 ** 2) * D ** 6) / 720)
  const lon = (D - ((1 + 2 * T1 + C1) * D ** 3) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * ep2 + 24 * T1 ** 2) * D ** 5) / 120) / Math.cos(phi1)
  return [(lat * 180) / Math.PI, zone * 6 - 183 + (lon * 180) / Math.PI]
}
