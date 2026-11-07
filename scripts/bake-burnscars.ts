/**
 * Bakes recent burn scars into the simulation grid of every region (no API keys).
 *
 * Source: Sentinel-2 L2A (Copernicus data) from the Earth Search STAC on AWS. For each fire season (year) the clearest
 * early-summer passes (1–30 June) are compared with the clearest autumn passes (1 October – 15 November): a cell
 * whose Normalized Burn Ratio NBR = (NIR − SWIR2) / (NIR + SWIR2) dropped by more than 0.27 (dNBR) burned that year.
 * Only forest and shrub cells that were green before count (crop harvest also lowers NBR), and a burn needs at least
 * 5 connected cells. Fires outside June–October are missed.
 *
 * Output: src/data/burnscars.generated.ts – per area, the last burn year of each cell (base64, 0 = none, else
 * year − 2000). Run with `npm run bake:burnscars` (optionally with area ids, merged into the existing file).
 */
import { existsSync, writeFileSync } from 'node:fs'
import { fromUrl } from 'geotiff'
import { REGIONS } from '../src/data/regions'
import { getGrid } from '../src/sim/gridCache'
import { cellCenter } from '../src/sim/terrain'

const YEARS = [2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025]
const DNBR = 0.27
const MAX_SCENES = 6
const ONLY = process.argv.slice(2)
const AREAS = ONLY.length ? REGIONS.filter((r) => ONLY.includes(r.id)) : REGIONS

/** UTM forward projection (WGS84) for a given zone. */
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

interface Scene { id: string; zone: number; nir: string; swir: string; scl: string }

async function scenes(bbox: number[], from: string, to: string): Promise<Scene[]> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch('https://earth-search.aws.element84.com/v1/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          collections: ['sentinel-2-l2a'],
          bbox,
          datetime: `${from}T00:00:00Z/${to}T23:59:59Z`,
          query: { 'eo:cloud_cover': { lt: 30 } },
          sortby: [{ field: 'properties.eo:cloud_cover', direction: 'asc' }],
          limit: 30,
        }),
      })
      if (!r.ok) throw new Error(`STAC ${r.status}`)
      const j = await r.json()
      return (j.features as any[]).map((f) => ({
        id: f.id as string,
        zone: Number(String(f.properties['proj:epsg'] ?? f.properties['proj:code'] ?? '32635').slice(-2)),
        nir: f.assets.nir08.href as string,
        swir: f.assets.swir22.href as string,
        scl: f.assets.scl.href as string,
      }))
    } catch (e) {
      console.log(`  search retry (${(e as Error).message})`)
      await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)))
    }
  }
  return []
}

/** NBR of every grid cell from the clearest scenes of a window (NaN where no clear data). */
async function nbr(centers: [number, number][], need: Uint8Array, bbox: number[], from: string, to: string): Promise<Float32Array> {
  const n = centers.length
  const out = new Float32Array(n).fill(NaN)
  const target = need.reduce((a, b) => a + b, 0)
  let filled = 0
  let used = 0
  for (const sc of await scenes(bbox, from, to)) {
    if (used >= MAX_SCENES || filled > target * 0.97) break
    try {
      const utm = centers.map(([la, lo]) => toUtm(la, lo, sc.zone))
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
      for (const [x, y] of utm) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
      const [nirImg, swirImg, sclImg] = await Promise.all([sc.nir, sc.swir, sc.scl].map(async (u) => (await fromUrl(u)).getImage()))
      const [ox, oy] = nirImg.getOrigin()
      const [rx, ry] = nirImg.getResolution()
      const px0 = Math.max(0, Math.floor((x0 - 80 - ox) / rx))
      const px1 = Math.min(nirImg.getWidth(), Math.ceil((x1 + 80 - ox) / rx))
      const py0 = Math.max(0, Math.floor((y1 + 80 - oy) / ry))
      const py1 = Math.min(nirImg.getHeight(), Math.ceil((y0 - 80 - oy) / ry))
      if (px1 <= px0 || py1 <= py0) continue
      const win = [px0, py0, px1, py1]
      const [[a], [b], [s]] = (await Promise.all([nirImg, swirImg, sclImg].map((im) => im.readRasters({ window: win })))) as unknown as [Uint16Array][]
      const w = px1 - px0
      const h = py1 - py0
      used++
      for (let i = 0; i < n; i++) {
        if (!need[i] || !Number.isNaN(out[i])) continue
        const cx = Math.floor((utm[i][0] - ox) / rx) - px0
        const cy = Math.floor((utm[i][1] - oy) / ry) - py0
        let sum = 0
        let k = 0
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) {
            const x = cx + dx
            const y = cy + dy
            if (x < 0 || y < 0 || x >= w || y >= h) continue
            const j = y * w + x
            // SCL: 4 vegetation, 5 bare, 7 unclassified
            if (s[j] !== 4 && s[j] !== 5 && s[j] !== 7) continue
            if (a[j] + b[j] === 0) continue
            sum += (a[j] - b[j]) / (a[j] + b[j])
            k++
          }
        if (k >= 8) {
          out[i] = sum / k
          filled++
        }
      }
    } catch (e) {
      console.log(`  skip ${sc.id}: ${(e as Error).message}`)
    }
  }
  console.log(`    ${from}…${to}: ${used} scene(s), ${Math.round((filled / Math.max(1, target)) * 100)}% of forest and shrub cells`)
  return out
}

async function bake(region: (typeof REGIONS)[number]) {
  const g = getGrid(region.id)
  const n = g.cols * g.rows
  const centers = Array.from({ length: n }, (_, i) => cellCenter(g, i))
  const bbox = [g.lon0, g.lat0 - g.rows * g.dLat, g.lon0 + g.cols * g.dLon, g.lat0]
  const last = new Uint8Array(n)
  // only forest and shrub cells can carry a burn scar here
  const need = new Uint8Array(n)
  for (let i = 0; i < n; i++) need[i] = g.kind[i] >= 3 ? 1 : 0
  // read the seasons in parallel, then mark them oldest first so the last burn wins
  const seasons = await Promise.all(YEARS.map(async (y) => ({ y, pre: await nbr(centers, need, bbox, `${y}-06-01`, `${y}-06-30`), post: await nbr(centers, need, bbox, `${y}-10-01`, `${y}-11-15`) })))
  for (const { y, pre, post } of seasons) {
    const hit = new Uint8Array(n)
    for (let i = 0; i < n; i++) if (g.kind[i] >= 3 && pre[i] > 0.25 && pre[i] - post[i] > DNBR) hit[i] = 1
    // keep patches of at least 5 connected cells
    const seen = new Uint8Array(n)
    let count = 0
    for (let i = 0; i < n; i++) {
      if (!hit[i] || seen[i]) continue
      const patch: number[] = []
      const st = [i]
      seen[i] = 1
      while (st.length) {
        const u = st.pop()!
        patch.push(u)
        const ux = u % g.cols
        const uy = (u / g.cols) | 0
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const x = ux + dx
            const yy = uy + dy
            if (x < 0 || yy < 0 || x >= g.cols || yy >= g.rows) continue
            const v = yy * g.cols + x
            if (hit[v] && !seen[v]) {
              seen[v] = 1
              st.push(v)
            }
          }
      }
      if (patch.length >= 5) for (const u of patch) last[u] = y - 2000
      if (patch.length >= 5) count += patch.length
    }
    console.log(`    burned ${y}: ${Math.round((count * g.cellM * g.cellM) / 10000)} ha`)
  }
  return Buffer.from(last).toString('base64')
}

const FILE = new URL('../src/data/burnscars.generated.ts', import.meta.url)
const result: Record<string, string> = ONLY.length && existsSync(FILE) ? { ...(await import('../src/data/burnscars.generated')).BURNSCARS } : {}
for (const r of AREAS) {
  console.log(`baking ${r.id}`)
  result[r.id] = await bake(r)
  writeFileSync(
    FILE,
    `// GENERATED by scripts/bake-burnscars.ts – do not edit.\n// Burn scars from Sentinel-2 L2A dNBR (Copernicus data, Earth Search STAC), fire seasons ${YEARS[0]}–${YEARS[YEARS.length - 1]}.\n// Base64, one byte per grid cell: last burn year − 2000, 0 = no burn found.\nexport const BURNSCARS: Record<string, string> = {\n${Object.entries(result).map(([k, v]) => `  ${k}: '${v}',`).join('\n')}\n}\n`,
  )
}
console.log('wrote src/data/burnscars.generated.ts')
