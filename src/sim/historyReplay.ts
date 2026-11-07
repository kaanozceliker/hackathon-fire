import type { HistoryFire } from '../data/historyTypes'
import type { Grid, SimResult } from './types'

/**
 * Turns a past fire's satellite snapshots into a smooth spread to play back with the simulation's fire layer.
 * ESTIMATED: the satellite only shows the burned area once a day, so each cell's ignition time between two passes is
 * interpolated from its distance (through the burned area) to what had burned before: from the estimated ignition
 * point for the first pass, from the previous burned area for later passes. No response, no physics.
 */

export const REPLAY_STEP_MIN = 10
/** Ignition time is not reported; assumed midday on the start date. */
export const ASSUMED_START_HOUR = 12
const BURN_STEPS = 12 // a cell glows for ~2 h, then shows as burned
const LATE_CAP_H = 24 // later passes mostly add edges burned soon after the previous pass

export interface Replay {
  grid: Grid
  result: SimResult
  /** Minutes from the start of the weather series (00:00 the day before) to the assumed ignition. */
  startOffsetMin: number
  ignition: [number, number]
  endMin: number
}

export function buildReplay(f: HistoryFire): Replay {
  const { cols, rows } = f
  const n = cols * rows
  const [[south, west], [north, east]] = f.bounds
  const dLat = (north - south) / rows
  const dLon = (east - west) / cols
  const bin = atob(f.firstPass)
  const pass = new Uint8Array(n)
  for (let i = 0; i < n; i++) pass[i] = bin.charCodeAt(i)

  const t0Iso = `${f.started}T${String(ASSUMED_START_HOUR).padStart(2, '0')}:00`
  const w = f.weather
  const startH = w.time.indexOf(t0Iso)
  // pass times in steps after ignition (passes are at ~12:10 local)
  const passStep = f.passes.map((p) => {
    const h = w.time.indexOf(`${p.date}T12:00`)
    return Math.round(((h - startH) * 60 + 10) / REPLAY_STEP_MIN)
  })

  // ignition: the most upwind cell of the first pass, using the mean wind of the first day
  let u = 0
  let v = 0
  for (let h = startH; h < startH + 24 && h < w.time.length; h++) {
    const to = ((w.windFromDeg[h] + 180) * Math.PI) / 180
    u += w.windKmh[h] * Math.sin(to)
    v += w.windKmh[h] * Math.cos(to)
  }
  const len = Math.hypot(u, v) || 1
  const ax = u / len
  const ay = -v / len // rows run south
  let ign = -1
  let best = Infinity
  for (let i = 0; i < n; i++) {
    if (pass[i] !== 1) continue
    const proj = (i % cols) * ax + ((i / cols) | 0) * ay
    if (proj < best) {
      best = proj
      ign = i
    }
  }

  const ig = new Int16Array(n).fill(-1)
  const bo = new Int16Array(n).fill(-1)
  const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
  /** Breadth-first distance (in cells, 8-neighbour, through any cell) from a source set. */
  const distFrom = (sources: number[]) => {
    const d = new Float32Array(n).fill(Infinity)
    const q: number[] = []
    for (const s of sources) {
      d[s] = 0
      q.push(s)
    }
    for (let h = 0; h < q.length; h++) {
      const c = q[h]
      const x = c % cols
      const y = (c / cols) | 0
      for (const [dx, dy] of NB) {
        const xx = x + dx
        const yy = y + dy
        if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) continue
        const j = yy * cols + xx
        const nd = d[c] + (dx && dy ? Math.SQRT2 : 1)
        if (nd < d[j] - 1e-6) {
          d[j] = nd
          q.push(j)
        }
      }
    }
    return d
  }
  let prevStep = 0
  let sources = ign >= 0 ? [ign] : []
  for (let k = 1; k <= f.passes.length; k++) {
    const cells: number[] = []
    for (let i = 0; i < n; i++) if (pass[i] === k) cells.push(i)
    if (!cells.length || !sources.length) continue
    const d = distFrom(sources)
    const maxD = Math.max(1, ...cells.map((c) => (Number.isFinite(d[c]) ? d[c] : 0)))
    const endStep = k === 1 ? passStep[0] : Math.min(passStep[k - 1], prevStep + (LATE_CAP_H * 60) / REPLAY_STEP_MIN)
    for (const c of cells) {
      const frac = Number.isFinite(d[c]) ? d[c] / maxD : 1
      ig[c] = Math.round(prevStep + frac * (endStep - prevStep))
      bo[c] = ig[c] + BURN_STEPS
    }
    prevStep = endStep
    sources = sources.concat(cells)
  }

  const grid: Grid = {
    areaId: f.id,
    cols,
    rows,
    cellM: f.cellM,
    lat0: north,
    lon0: west,
    dLat,
    dLon,
    elev: new Float32Array(n),
    veg: new Float32Array(n).fill(0.6),
    kind: new Uint8Array(n).fill(3),
    species: new Uint8Array(n),
  }
  let last = 0
  for (let i = 0; i < n; i++) last = Math.max(last, bo[i])
  const result: SimResult = {
    config: { areaId: f.id, ignition: [north - (((ign / cols) | 0) + 0.5) * dLat, west + ((ign % cols) + 0.5) * dLon], intensity: 'medium', durationH: Math.ceil((last * REPLAY_STEP_MIN) / 60), temperatureC: 30, humidityPct: 30, windSpeedKmh: 0, windFromDeg: 0, precipMmH: 0, terrain: 'rolling-hills', fuelLoad: 1 },
    grid,
    stepMin: REPLAY_STEP_MIN,
    steps: last,
    ignitionStep: ig,
    burnoutStep: bo,
    originCell: ign,
    series: [],
    impacts: [],
  }
  return { grid, result, startOffsetMin: startH * 60, ignition: result.config.ignition, endMin: last * REPLAY_STEP_MIN }
}
