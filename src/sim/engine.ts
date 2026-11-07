import { hash3 } from './rng'
import { cellCenter, cellOf } from './terrain'
import { haversineM } from './geo'
import type { Grid, SettlementImpact, SimConfig, SimResult, Settlement, StepStat } from './types'

/**
 * Simplified cellular-automata fire spread. ILLUSTRATIVE ONLY – not a validated wildfire model.
 *
 * - 8-neighbour Moore neighbourhood, 10 minute time step, 110 m cells.
 * - Ignition probability per burning neighbour = base × wind × slope × humidity × temperature × rain × fuel.
 * - Long-range ember spotting downwind when wind is strong.
 * - Burned cells never reignite. All randomness is hashed from (seed, cell, step) so a scenario is reproducible.
 *
 * It is intentionally independent of React/Leaflet so a backend model can replace `runSimulation` later.
 */

export const STEP_MIN = 10

const NEIGHBOURS: [number, number][] = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
]

const TERRAIN_SLOPE_MULT = { 'coastal-plain': 0.45, 'rolling-hills': 1, 'steep-mountain': 1.7 } as const
const INTENSITY = {
  low: { radius: 0, mult: 0.85 },
  medium: { radius: 1, mult: 1 },
  high: { radius: 2, mult: 1.2 },
} as const

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function fuelOf(grid: Grid, i: number, fuelLoad: number): number {
  const k = grid.kind[i]
  if (k === 0) return 0
  // Built-up land: gardens and the odd structure can catch at the wildland edge, but streets and buildings do not
  // carry a forest-type fire front.
  if (k === 1) return 0.05
  return clamp(grid.veg[i] * fuelLoad * 1.15, 0.05, 1)
}

/** How strongly a burning cell pushes fire into its neighbours. Burning built-up cells barely propagate. */
const SOURCE_STRENGTH = [0, 0.2, 1, 1, 1]

/** Steps a cell keeps burning: forest fuel smoulders for up to ~2 h, built-up cells burn out quickly. */
const burnSteps = (fuel: number, kind: number) => (kind === 1 ? 2 : Math.round(3 + 9 * Math.max(fuel, 0.3)))

export function seedFor(config: SimConfig): number {
  // Seed depends only on area + ignition so changing weather keeps the same "random" luck → clean what-if comparisons.
  return Math.floor(config.ignition[0] * 1e4) * 31 + Math.floor(config.ignition[1] * 1e4) + config.areaId.length
}

function findOrigin(grid: Grid, config: SimConfig): number {
  let c = cellOf(grid, config.ignition[0], config.ignition[1])
  if (c < 0) c = Math.floor(grid.rows / 2) * grid.cols + Math.floor(grid.cols / 2)
  if (grid.kind[c] !== 0) return c
  // nearest non-water cell (spiral)
  const cx = c % grid.cols
  const cy = Math.floor(c / grid.cols)
  for (let r = 1; r < 30; r++) {
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || y < 0 || x >= grid.cols || y >= grid.rows) continue
        if (grid.kind[y * grid.cols + x] !== 0) return y * grid.cols + x
      }
  }
  return c
}

export function runSimulation(grid: Grid, config: SimConfig, settlements: Settlement[]): SimResult {
  const { cols, rows, cellM } = grid
  const n = cols * rows
  const steps = (config.durationH * 60) / STEP_MIN
  const seed = seedFor(config)
  const ig = new Int16Array(n).fill(-1)
  const burnout = new Int16Array(n).fill(-1)
  const origin = findOrigin(grid, config)

  const fuel = new Float32Array(n)
  for (let i = 0; i < n; i++) fuel[i] = fuelOf(grid, i, config.fuelLoad)

  // --- environment factors (constant over the run) ---
  const ws = config.windSpeedKmh
  const windTo = (((config.windFromDeg + 180) % 360) * Math.PI) / 180
  const dryness = clamp((100 - config.humidityPct) / 100, 0, 1)
  const humFactor = 0.25 + 1.5 * Math.pow(dryness, 1.5)
  const tempFactor = clamp(0.6 + 0.025 * (config.temperatureC - 15), 0.45, 1.6)
  const rainFactor = 1 / (1 + 1.4 * config.precipMmH)
  const slopeMult = TERRAIN_SLOPE_MULT[config.terrain]
  const inten = INTENSITY[config.intensity]
  const BASE = 0.22
  const common = BASE * humFactor * tempFactor * rainFactor * inten.mult

  // pre-compute wind factor per neighbour offset
  const windF = NEIGHBOURS.map(([dx, dy]) => {
    const bearing = Math.atan2(dx, -dy) // radians clockwise from north (row increases to the south)
    return Math.exp(0.045 * ws * Math.cos(bearing - windTo))
  })
  const dist = NEIGHBOURS.map(([dx, dy]) => (dx !== 0 && dy !== 0 ? Math.SQRT2 : 1))

  const spotRate = ws > 14 ? 0.0028 * Math.pow((ws - 10) / 10, 1.5) * (0.4 + dryness) : 0
  const spotDx = Math.sin(windTo)
  const spotDy = -Math.cos(windTo)

  // --- initial ignition ---
  let burning: number[] = []
  const ox = origin % cols
  const oy = Math.floor(origin / cols)
  for (let dy = -inten.radius; dy <= inten.radius; dy++)
    for (let dx = -inten.radius; dx <= inten.radius; dx++) {
      const x = ox + dx
      const y = oy + dy
      if (x < 0 || y < 0 || x >= cols || y >= rows) continue
      const i = y * cols + x
      if (grid.kind[i] === 0 || ig[i] !== -1) continue
      ig[i] = 0
      burnout[i] = burnSteps(fuel[i], grid.kind[i])
      burning.push(i)
    }

  for (let s = 0; s < steps; s++) {
    const next: number[] = []
    const stillBurning: number[] = []
    for (const c of burning) {
      if (burnout[c] > s + 1) stillBurning.push(c)
      const cx = c % cols
      const cy = (c / cols) | 0
      const src = SOURCE_STRENGTH[grid.kind[c]]
      for (let k = 0; k < 8; k++) {
        const x = cx + NEIGHBOURS[k][0]
        const y = cy + NEIGHBOURS[k][1]
        if (x < 0 || y < 0 || x >= cols || y >= rows) continue
        const j = y * cols + x
        if (ig[j] !== -1) continue
        const f = fuel[j]
        if (f <= 0) continue
        const g = ((grid.elev[j] - grid.elev[c]) / (cellM * dist[k])) * slopeMult
        const slopeF = Math.exp(clamp(g * 3.2, -1.2, 1.4))
        const p = Math.min(0.97, (common * windF[k] * slopeF * f * src) / (dist[k] === 1 ? 1 : 1.35))
        if (hash3(seed, c * 8 + k, s) < p) {
          ig[j] = s + 1
          burnout[j] = s + 1 + burnSteps(f, grid.kind[j])
          next.push(j)
        }
      }
      // ember spotting (vegetation fires only)
      if (spotRate > 0 && src === 1 && hash3(seed + 1, c, s) < spotRate) {
        const d = 3 + Math.floor(hash3(seed + 2, c, s) * (ws / 5))
        const ang = (hash3(seed + 3, c, s) - 0.5) * 0.8
        const ca = Math.cos(ang)
        const sa = Math.sin(ang)
        const vx = spotDx * ca - spotDy * sa
        const vy = spotDx * sa + spotDy * ca
        const x = Math.round(cx + vx * d)
        const y = Math.round(cy + vy * d)
        if (x >= 0 && y >= 0 && x < cols && y < rows) {
          const j = y * cols + x
          const accept = grid.kind[j] === 1 ? 0.05 : 0.35 + 0.5 * fuel[j]
          if (ig[j] === -1 && fuel[j] > 0 && hash3(seed + 4, c, s) < accept) {
            ig[j] = s + 1
            burnout[j] = s + 1 + burnSteps(fuel[j], grid.kind[j])
            next.push(j)
          }
        }
      }
    }
    burning = stillBurning.concat(next)
  }

  const series = computeSeries(grid, ig, burnout, steps, origin)
  const impacts = computeImpacts(grid, ig, settlements)
  return { config, grid, stepMin: STEP_MIN, steps, ignitionStep: ig, burnoutStep: burnout, originCell: origin, series, impacts }
}

function computeSeries(grid: Grid, ig: Int16Array, burnout: Int16Array, steps: number, origin: number): StepStat[] {
  const { cols, rows, cellM } = grid
  const T = steps + 2
  const cntKind = [0, 1, 2, 3, 4].map(() => new Float64Array(T))
  const burnDiff = new Float64Array(T + 1)
  const perDiff = new Float64Array(T + 1)
  const radiusMax = new Float64Array(T)
  const sx = new Float64Array(T)
  const sy = new Float64Array(T)
  const sn = new Float64Array(T)
  const ox = origin % cols
  const oy = Math.floor(origin / cols)
  const NB4: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]]

  for (let i = 0; i < cols * rows; i++) {
    const t = ig[i]
    if (t < 0) continue
    const x = i % cols
    const y = (i / cols) | 0
    cntKind[grid.kind[i]][t]++
    burnDiff[t]++
    burnDiff[Math.min(T, Math.max(t, burnout[i]))]--
    const dxm = (x - ox) * cellM
    const dym = (oy - y) * cellM
    radiusMax[t] = Math.max(radiusMax[t], Math.hypot(dxm, dym))
    sx[t] += dxm
    sy[t] += dym
    sn[t]++
    for (const [dx, dy] of NB4) {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue // map edge: not counted as perimeter
      const j = ny * cols + nx
      if (grid.kind[j] === 0) continue // water edge isn't a fire front
      const tj = ig[j]
      if (tj === -1) {
        perDiff[t]++
      } else if (tj > t) {
        perDiff[t]++
        perDiff[tj]--
      }
    }
  }

  const ha = (cells: number) => (cells * cellM * cellM) / 10000
  const out: StepStat[] = []
  let cum = [0, 0, 0, 0, 0]
  let burning = 0
  let per = 0
  let rMax = 0
  const rHist: number[] = []
  for (let t = 0; t <= steps; t++) {
    cum = cum.map((v, k) => v + cntKind[k][t])
    burning += burnDiff[t]
    per += perDiff[t]
    rMax = Math.max(rMax, radiusMax[t])
    rHist.push(rMax)
    const back = Math.max(0, t - 6)
    const ros = t === 0 ? 0 : ((rMax - rHist[back]) / (((t - back) * STEP_MIN) / 60)) || 0
    let wx = 0
    let wy = 0
    let wn = 0
    for (let b = Math.max(0, t - 2); b <= t; b++) {
      wx += sx[b]
      wy += sy[b]
      wn += sn[b]
    }
    const heading = wn >= 3 ? ((Math.atan2(wx / wn, wy / wn) * 180) / Math.PI + 360) % 360 : null
    const total = cum[1] + cum[2] + cum[3] + cum[4]
    out.push({
      step: t,
      minutes: t * STEP_MIN,
      burningHa: ha(burning),
      affectedHa: ha(total),
      forestHa: ha(cum[3] + cum[4]),
      pineHa: ha(cum[4]),
      maquisHa: ha(cum[3]),
      sparseHa: ha(cum[1] + cum[2]),
      perimeterKm: (per * cellM) / 1000,
      rosMh: ros,
      maxRadiusKm: rMax / 1000,
      headingDeg: heading,
    })
  }
  return out
}

function computeImpacts(grid: Grid, ig: Int16Array, settlements: Settlement[]): SettlementImpact[] {
  return settlements.map((st) => {
    const reach = st.radiusM + 300
    let first = Infinity
    let total = 0
    let burned = 0
    // scan the bounding box only
    const rc = reach / grid.cellM + 1
    const c0 = Math.floor((st.pos[1] - grid.lon0) / grid.dLon)
    const r0 = Math.floor((grid.lat0 - st.pos[0]) / grid.dLat)
    for (let r = Math.max(0, r0 - Math.ceil(rc)); r <= Math.min(grid.rows - 1, r0 + Math.ceil(rc)); r++)
      for (let c = Math.max(0, c0 - Math.ceil(rc)); c <= Math.min(grid.cols - 1, c0 + Math.ceil(rc)); c++) {
        const i = r * grid.cols + c
        if (grid.kind[i] === 0) continue
        if (haversineM(cellCenter(grid, i), st.pos) > reach) continue
        total++
        if (ig[i] >= 0) {
          burned++
          if (ig[i] < first) first = ig[i]
        }
      }
    return {
      id: st.id,
      arrivalMin: Number.isFinite(first) ? first * STEP_MIN : null,
      exposurePct: total ? (burned / total) * 100 : 0,
    }
  })
}
