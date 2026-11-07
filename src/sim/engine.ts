import { hash3 } from './rng'
import { speciesById } from '../data/vegetation'
import { cellCenter, cellOf } from './terrain'
import { haversineM } from './geo'
import { cellWeather, type CellWeather } from './weather'
import { existingFuelMult, simYear } from './existing'
import type { Grid, SettlementImpact, SimConfig, SimResult, Settlement, StepStat } from './types'

/**
 * Simplified cellular-automata fire spread. ILLUSTRATIVE ONLY – not a validated wildfire model.
 *
 * - 8-neighbour Moore neighbourhood, 10 minute time step, 110 m cells.
 * - Ignition probability per burning neighbour = base × wind × slope × humidity × temperature × rain × fuel.
 * - Weather may change every hour and vary across the grid (config.weather); otherwise the fixed values apply.
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
  // species: resinous pine and maquis carry fire more readily than oak, fir or sweetgum
  const sp = grid.species?.[i] ? speciesById(grid.species[i]).flammability : 1
  return clamp(grid.veg[i] * fuelLoad * 1.15 * sp, 0.05, 1)
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
  const st = new FireStepper(grid, config)
  const steps = (config.durationH * 60) / STEP_MIN
  while (st.s < steps) st.step()
  return st.result(settlements)
}

const BASE = 0.09
/** Wind effect on spread: exp(WIND_K × km/h × cos(angle to the wind)). Head ~9.5× and back ~0.1× at 30 km/h. */
const WIND_K = 0.075

/**
 * The fire, one 10-minute step at a time. Lets a caller pause between steps (to make response decisions) and change
 * how easily cells catch fire: `resist` scales the chance of a cell igniting (firebreaks, wet lines, water drops),
 * `extinguish` puts a burning cell out.
 */
export class FireStepper {
  readonly grid: Grid
  readonly config: SimConfig
  readonly seed: number
  readonly origin: number
  /** Steps completed; the fire state is at the end of step `s`. */
  s = 0
  ig: Int16Array
  burnout: Int16Array
  burning: number[] = []
  /** Ember spot fires: where an ember from a burning cell landed and started a new fire. */
  spots: { step: number; from: number; to: number }[] = []
  /** Multiplier on the chance that a cell ignites, 1 = untouched. */
  resist: Float32Array
  private fuel: Float32Array
  private common: Float32Array
  private spotRate: Float32Array
  private windCache: Float32Array
  private wx!: CellWeather
  private hourNow = -1
  private slopeMult: number
  private dist = NEIGHBOURS.map(([dx, dy]) => (dx !== 0 && dy !== 0 ? Math.SQRT2 : 1))
  private bearing = NEIGHBOURS.map(([dx, dy]) => Math.atan2(dx, -dy)) // radians clockwise from north (rows run south)
  private inten: (typeof INTENSITY)[keyof typeof INTENSITY]

  constructor(grid: Grid, config: SimConfig, copyFrom?: FireStepper) {
    this.grid = grid
    this.config = config
    const n = grid.cols * grid.rows
    this.seed = seedFor(config)
    this.slopeMult = TERRAIN_SLOPE_MULT[config.terrain]
    this.inten = INTENSITY[config.intensity]
    this.common = new Float32Array(n)
    this.spotRate = new Float32Array(n)
    this.windCache = new Float32Array(n * 8)
    if (copyFrom) {
      this.origin = copyFrom.origin
      this.s = copyFrom.s
      this.ig = copyFrom.ig.slice()
      this.burnout = copyFrom.burnout.slice()
      this.burning = copyFrom.burning.slice()
      this.spots = copyFrom.spots.slice()
      this.resist = copyFrom.resist.slice()
      this.fuel = copyFrom.fuel
      return
    }
    this.origin = findOrigin(grid, config)
    this.ig = new Int16Array(n).fill(-1)
    this.burnout = new Int16Array(n).fill(-1)
    this.resist = new Float32Array(n).fill(1)
    this.fuel = new Float32Array(n)
    for (let i = 0; i < n; i++) this.fuel[i] = fuelOf(grid, i, config.fuelLoad)
    // existing protection: roads and fire breaks as partial fuel breaks, less fuel on recent burn scars
    if (!config.ignoreExisting) {
      const m = existingFuelMult(grid, simYear(config))
      for (let i = 0; i < n; i++) this.fuel[i] *= m[i]
    }
    // initial ignition
    const { cols, rows } = grid
    const ox = this.origin % cols
    const oy = Math.floor(this.origin / cols)
    const r = this.inten.radius
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const x = ox + dx
        const y = oy + dy
        if (x < 0 || y < 0 || x >= cols || y >= rows) continue
        const i = y * cols + x
        if (grid.kind[i] === 0 || this.ig[i] !== -1) continue
        this.ig[i] = 0
        this.burnout[i] = burnSteps(this.fuel[i], grid.kind[i])
        this.burning.push(i)
      }
  }

  /** Prevention measures: scales the fuel of each cell (1 = unchanged). Call before the first step. */
  scaleFuel(mult: Float32Array) {
    this.fuel = this.fuel.map((f, i) => f * mult[i])
  }

  /** A copy that can be run ahead (forecasts) without touching this one. */
  clone(): FireStepper {
    return new FireStepper(this.grid, this.config, this)
  }

  /** True while any cell is still burning. */
  get active(): boolean {
    return this.burning.some((c) => this.burnout[c] > this.s)
  }

  /** Puts a burning cell out now. */
  extinguish(c: number) {
    if (this.ig[c] >= 0 && this.burnout[c] > this.s) this.burnout[c] = this.s
  }

  private enterHour(h: number) {
    if (h === this.hourNow) return
    this.hourNow = h
    const n = this.grid.cols * this.grid.rows
    this.wx = cellWeather(this.grid, this.config, h)
    this.windCache.fill(0)
    for (let i = 0; i < n; i++) {
      const dryness = clamp((100 - this.wx.humidityPct[i]) / 100, 0, 1)
      const humFactor = 0.25 + 1.5 * Math.pow(dryness, 1.5)
      const tempFactor = clamp(0.6 + 0.025 * (this.wx.temperatureC[i] - 15), 0.45, 1.6)
      const rainFactor = 1 / (1 + 1.4 * this.wx.precipMmH[i])
      this.common[i] = BASE * humFactor * tempFactor * rainFactor * this.inten.mult
      const ws = this.wx.windSpeedKmh[i]
      this.spotRate[i] = ws > 14 ? 0.0028 * Math.pow((ws - 10) / 10, 1.5) * (0.4 + dryness) : 0
    }
  }

  private windF(c: number, k: number) {
    let v = this.windCache[c * 8 + k]
    if (v === 0) {
      v = Math.exp(WIND_K * this.wx.windSpeedKmh[c] * Math.cos(this.bearing[k] - this.wx.windToRad[c]))
      this.windCache[c * 8 + k] = v
    }
    return v
  }

  /** Wind of the current hour at a cell: speed km/h and the direction it blows to, radians clockwise from north. */
  windAt(c: number): { speedKmh: number; toRad: number } {
    this.enterHour(Math.floor((this.s * STEP_MIN) / 60))
    return { speedKmh: this.wx.windSpeedKmh[c], toRad: this.wx.windToRad[c] }
  }

  step() {
    const { grid, ig, burnout, fuel, resist, seed } = this
    const { cols, rows, cellM } = grid
    const s = this.s
    this.enterHour(Math.floor((s * STEP_MIN) / 60))
    const next: number[] = []
    const stillBurning: number[] = []
    for (const c of this.burning) {
      if (burnout[c] <= s) continue // put out by the response
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
        const g = ((grid.elev[j] - grid.elev[c]) / (cellM * this.dist[k])) * this.slopeMult
        const slopeF = Math.exp(clamp(g * 3.2, -1.2, 1.4))
        const p = Math.min(0.97, (this.common[c] * this.windF(c, k) * slopeF * f * src * resist[j]) / (this.dist[k] === 1 ? 1 : 1.35))
        if (hash3(seed, c * 8 + k, s) < p) {
          ig[j] = s + 1
          burnout[j] = s + 1 + burnSteps(f, grid.kind[j])
          next.push(j)
        }
      }
      // ember spotting: only from the flaming front of dense vegetation (pine, maquis), in proportion to its fuel;
      // smouldering cells, sparse grass and cells being cooled by the response do not loft embers
      const flaming = s - ig[c] <= Math.max(1, (burnout[c] - ig[c]) / 3)
      const spotP = this.spotRate[c] * fuel[c] * resist[c]
      if (spotP > 0 && src === 1 && grid.kind[c] >= 3 && flaming && fuel[c] >= 0.35 && hash3(seed + 1, c, s) < spotP) {
        const d = 3 + Math.floor(hash3(seed + 2, c, s) * (this.wx.windSpeedKmh[c] / 3.5))
        const spotDx = Math.sin(this.wx.windToRad[c])
        const spotDy = -Math.cos(this.wx.windToRad[c])
        const ang = (hash3(seed + 3, c, s) - 0.5) * 0.8
        const ca = Math.cos(ang)
        const sa = Math.sin(ang)
        const vx = spotDx * ca - spotDy * sa
        const vy = spotDx * sa + spotDy * ca
        const x = Math.round(cx + vx * d)
        const y = Math.round(cy + vy * d)
        if (x >= 0 && y >= 0 && x < cols && y < rows) {
          const j = y * cols + x
          // a cleared firebreak gives embers little to land in; a wet line damps them
          // an ember needs dry, fine fuel where it lands; most die out
          const accept = (grid.kind[j] === 1 ? 0.03 : 0.15 + 0.45 * fuel[j]) * Math.min(1, resist[j] * 2)
          if (ig[j] === -1 && fuel[j] > 0 && hash3(seed + 4, c, s) < accept) {
            ig[j] = s + 1
            burnout[j] = s + 1 + burnSteps(fuel[j], grid.kind[j])
            next.push(j)
            this.spots.push({ step: s + 1, from: c, to: j })
          }
        }
      }
    }
    this.burning = stillBurning.concat(next)
    this.s = s + 1
  }

  /** The run so far as a result (steps = steps completed). */
  result(settlements: Settlement[], configOverride?: SimConfig): SimResult {
    const steps = this.s
    const ig = this.ig.slice()
    const burnout = this.burnout.slice()
    return {
      config: configOverride ?? this.config,
      grid: this.grid,
      stepMin: STEP_MIN,
      steps,
      ignitionStep: ig,
      burnoutStep: burnout,
      originCell: this.origin,
      series: computeSeries(this.grid, ig, burnout, steps, this.origin),
      impacts: computeImpacts(this.grid, ig, settlements),
      spots: this.spots.slice(),
    }
  }
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
    // Direction the front is advancing: cells ignited in the last 3 steps, seen from the centre of everything that
    // burned before them (not from the ignition point, which would lag behind a wind shift).
    let wx = 0
    let wy = 0
    let wn = 0
    for (let b = Math.max(0, t - 2); b <= t; b++) {
      wx += sx[b]
      wy += sy[b]
      wn += sn[b]
    }
    let px = 0
    let py = 0
    let pn = 0
    for (let b = 0; b < Math.max(0, t - 2); b++) {
      px += sx[b]
      py += sy[b]
      pn += sn[b]
    }
    const cx0 = pn ? px / pn : 0
    const cy0 = pn ? py / pn : 0
    const heading = wn >= 3 ? ((Math.atan2(wx / wn - cx0, wy / wn - cy0) * 180) / Math.PI + 360) % 360 : null
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
