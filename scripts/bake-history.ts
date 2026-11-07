/**
 * Bakes a past fire for the "Geçmişteki Yangınlar" page from open data (no API keys):
 * - Burned area by date from Sentinel-2 L2A (Earth Search STAC on AWS, Copernicus data): the Normalized Burn Ratio
 *   NBR = (NIR − SWIR2) / (NIR + SWIR2) of each cloud-free pass after the fire is compared with the last pass before
 *   it (dNBR). A 100 m cell counts as burned from the first pass where dNBR > 0.27 and it stays burned at the last pass.
 * - Hourly weather of those days at the burned area from the Open-Meteo archive (ERA5).
 * Output: src/data/history.generated.ts. Run with `npm run bake:history`.
 */
import { writeFileSync } from 'node:fs'
import { fromUrl } from 'geotiff'

const FIRE = {
  id: 'izmir-2025-06-29',
  name: 'Menderes–Seferihisar yangını',
  started: '2025-06-29',
  bbox: [26.7, 37.95, 27.25, 38.35] as [number, number, number, number], // w s e n
  pre: '2025-06-25',
  posts: ['2025-06-30', '2025-07-02', '2025-07-05', '2025-07-10'],
}
const CELL_M = 100
const DNBR = 0.27

// --- UTM zone 35N forward projection (WGS84) ---
function toUtm35(lat: number, lon: number): [number, number] {
  const a = 6378137
  const f = 1 / 298.257223563
  const k0 = 0.9996
  const e2 = f * (2 - f)
  const ep2 = e2 / (1 - e2)
  const phi = (lat * Math.PI) / 180
  const lam = ((lon - 27) * Math.PI) / 180
  const N = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2)
  const T = Math.tan(phi) ** 2
  const C = ep2 * Math.cos(phi) ** 2
  const A = lam * Math.cos(phi)
  const M = a * ((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * phi - ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * phi) + ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi) - ((35 * e2 ** 3) / 3072) * Math.sin(6 * phi))
  const x = k0 * N * (A + ((1 - T + C) * A ** 3) / 6 + ((5 - 18 * T + T ** 2 + 72 * C - 58 * ep2) * A ** 5) / 120) + 500000
  const y = k0 * (M + N * Math.tan(phi) * (A ** 2 / 2 + ((5 - T + 9 * C + 4 * C ** 2) * A ** 4) / 24 + ((61 - 58 * T + T ** 2 + 600 * C - 330 * ep2) * A ** 6) / 720))
  return [x, y]
}

async function scenes(date: string) {
  const r = await fetch('https://earth-search.aws.element84.com/v1/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ collections: ['sentinel-2-l2a'], bbox: FIRE.bbox, datetime: `${date}T00:00:00Z/${date}T23:59:59Z`, limit: 10 }),
  })
  const j = await r.json()
  return (j.features as any[]).map((f) => ({ id: f.id as string, nir: f.assets.nir08.href as string, swir: f.assets.swir22.href as string, scl: f.assets.scl.href as string }))
}

// cell grid over the bbox
const [W, S, E, N] = FIRE.bbox
const lat0 = N
const dLat = CELL_M / 111320
const dLon = CELL_M / (111320 * Math.cos((((S + N) / 2) * Math.PI) / 180))
const rows = Math.round((N - S) / dLat)
const cols = Math.round((E - W) / dLon)
const n = rows * cols
const utm = Array.from({ length: n }, (_, i) => toUtm35(lat0 - ((i / cols) | 0) * dLat - dLat / 2, W + (i % cols) * dLon + dLon / 2))
const UX = [Infinity, -Infinity]
const UY = [Infinity, -Infinity]
for (const [x, y] of utm) {
  UX[0] = Math.min(UX[0], x)
  UX[1] = Math.max(UX[1], x)
  UY[0] = Math.min(UY[0], y)
  UY[1] = Math.max(UY[1], y)
}

/** NBR of every cell for one date (NaN where no clear data): mean of the 20 m pixels in the cell. */
async function nbrFor(date: string): Promise<Float32Array> {
  const out = new Float32Array(n).fill(NaN)
  for (const sc of await scenes(date)) {
    const [nirImg, swirImg, sclImg] = await Promise.all([sc.nir, sc.swir, sc.scl].map(async (u) => (await fromUrl(u)).getImage()))
    const [ox, oy] = nirImg.getOrigin()
    const [rx, ry] = nirImg.getResolution()
    const px0 = Math.max(0, Math.floor((UX[0] - 60 - ox) / rx))
    const px1 = Math.min(nirImg.getWidth(), Math.ceil((UX[1] + 60 - ox) / rx))
    const py0 = Math.max(0, Math.floor((UY[1] + 60 - oy) / ry))
    const py1 = Math.min(nirImg.getHeight(), Math.ceil((UY[0] - 60 - oy) / ry))
    if (px1 <= px0 || py1 <= py0) continue
    const win = [px0, py0, px1, py1]
    const [[nir], [swir], [scl]] = (await Promise.all([nirImg, swirImg, sclImg].map((im) => im.readRasters({ window: win })))) as unknown as [Uint16Array][]
    const w = px1 - px0
    let used = 0
    for (let i = 0; i < n; i++) {
      if (!Number.isNaN(out[i])) continue
      const cx = Math.floor((utm[i][0] - ox) / rx) - px0
      const cy = Math.floor((utm[i][1] - oy) / ry) - py0
      let sum = 0
      let k = 0
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const x = cx + dx
          const y = cy + dy
          if (x < 0 || y < 0 || x >= w || y >= py1 - py0) continue
          const j = y * w + x
          const s = scl[j]
          // SCL: 4 vegetation, 5 bare, 7 unclassified; skip no data, saturated, shadows, cloud, water, snow
          if (s !== 4 && s !== 5 && s !== 7) continue
          const a = nir[j]
          const b = swir[j]
          if (a + b === 0) continue
          sum += (a - b) / (a + b)
          k++
        }
      if (k >= 6) {
        out[i] = sum / k
        used++
      }
    }
    console.log(`  ${date} ${sc.id}: ${used} cells`)
  }
  return out
}

const pre = await nbrFor(FIRE.pre)
const post: Float32Array[] = []
for (const d of FIRE.posts) post.push(await nbrFor(d))
const last = post[post.length - 1]
const first = new Uint8Array(n) // 0 = not burned, k = burned from posts[k-1]
for (let i = 0; i < n; i++) {
  if (Number.isNaN(pre[i]) || Number.isNaN(last[i]) || pre[i] - last[i] <= DNBR) continue
  for (let k = 0; k < post.length; k++)
    if (!Number.isNaN(post[k][i]) && pre[i] - post[k][i] > DNBR) {
      first[i] = k + 1
      break
    }
}
// remove speckle: a burned cell needs at least 3 burned neighbours
const clean = new Uint8Array(n)
for (let i = 0; i < n; i++) {
  if (!first[i]) continue
  const x = i % cols
  const y = (i / cols) | 0
  let nb = 0
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue
      const xx = x + dx
      const yy = y + dy
      if (xx >= 0 && yy >= 0 && xx < cols && yy < rows && first[yy * cols + xx]) nb++
    }
  if (nb >= 3) clean[i] = first[i]
}
// keep the largest burned patch (the fire) – other burns in the bbox are different events
const comp = new Int32Array(n).fill(-1)
let bestId = -1
let bestSize = 0
for (let i = 0; i < n; i++) {
  if (!clean[i] || comp[i] >= 0) continue
  const id = i
  let size = 0
  const st = [i]
  comp[i] = id
  while (st.length) {
    const u = st.pop()!
    size++
    const x = u % cols
    const y = (u / cols) | 0
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const xx = x + dx
        const yy = y + dy
        if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) continue
        const v = yy * cols + xx
        if (clean[v] && comp[v] < 0) {
          comp[v] = id
          st.push(v)
        }
      }
  }
  if (size > bestSize) {
    bestSize = size
    bestId = id
  }
}
for (let i = 0; i < n; i++) if (comp[i] !== bestId) clean[i] = 0
// crop to the fire with a margin
let r0 = rows
let r1 = 0
let c0 = cols
let c1 = 0
for (let i = 0; i < n; i++)
  if (clean[i]) {
    const x = i % cols
    const y = (i / cols) | 0
    r0 = Math.min(r0, y)
    r1 = Math.max(r1, y)
    c0 = Math.min(c0, x)
    c1 = Math.max(c1, x)
  }
const M = 15
r0 = Math.max(0, r0 - M)
c0 = Math.max(0, c0 - M)
r1 = Math.min(rows - 1, r1 + M)
c1 = Math.min(cols - 1, c1 + M)
const cr = r1 - r0 + 1
const cc = c1 - c0 + 1
const crop = new Uint8Array(cr * cc)
const haBy = FIRE.posts.map(() => 0)
for (let y = 0; y < cr; y++)
  for (let x = 0; x < cc; x++) {
    const v = clean[(y + r0) * cols + x + c0]
    crop[y * cc + x] = v
    if (v) for (let k = v - 1; k < FIRE.posts.length; k++) haBy[k] += (CELL_M * CELL_M) / 10000
  }
const north = lat0 - r0 * dLat
const west = W + c0 * dLon
const south = north - cr * dLat
const east = west + cc * dLon
let cy = 0
let cx = 0
let cn = 0
for (let i = 0; i < crop.length; i++)
  if (crop[i]) {
    cy += north - (((i / cc) | 0) + 0.5) * dLat
    cx += west + ((i % cc) + 0.5) * dLon
    cn++
  }
const centre = [cy / cn, cx / cn]
console.log(`burned ${haBy.map((h, k) => `${FIRE.posts[k]}: ${Math.round(h)} ha`).join(', ')}; grid ${cc}×${cr}`)

// hourly weather at the burn centre, from the day before to two days after
const wx = await (await fetch(`https://archive-api.open-meteo.com/v1/archive?latitude=${centre[0].toFixed(4)}&longitude=${centre[1].toFixed(4)}&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m&timezone=Europe%2FIstanbul&start_date=2025-06-28&end_date=2025-07-10`)).json()

const data = {
  id: FIRE.id,
  name: FIRE.name,
  started: FIRE.started,
  bounds: [[south, west], [north, east]],
  cols: cc,
  rows: cr,
  cellM: CELL_M,
  centre,
  pre: FIRE.pre,
  passes: FIRE.posts.map((d, k) => ({ date: d, time: '12:10', burnedHa: Math.round(haBy[k]) })),
  firstPass: Buffer.from(crop).toString('base64'),
  weather: {
    time: wx.hourly.time as string[],
    temperatureC: wx.hourly.temperature_2m as number[],
    humidityPct: wx.hourly.relative_humidity_2m as number[],
    windKmh: wx.hourly.wind_speed_10m as number[],
    gustKmh: wx.hourly.wind_gusts_10m as number[],
    windFromDeg: wx.hourly.wind_direction_10m as number[],
  },
}
writeFileSync(
  new URL('../src/data/history.generated.ts', import.meta.url),
  `// GENERATED by scripts/bake-history.ts – do not edit.\n// Burned area: contains modified Copernicus Sentinel data (2025), via Earth Search (Element 84). Weather: Open-Meteo archive (ERA5), CC BY 4.0.\nimport type { HistoryFire } from './historyTypes'

export const HISTORY_FIRES: HistoryFire[] = [${JSON.stringify(data)}]\n`,
)
console.log('wrote src/data/history.generated.ts')
