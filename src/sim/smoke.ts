import { STEP_MIN, fuelOf } from './engine'
import { cellWeather, type CellWeather } from './weather'
import type { LatLon } from './geo'
import type { SimResult } from './types'
import { regionById } from '../data/regions'

/**
 * Smoke, emissions and air quality. ILLUSTRATIVE ONLY – a screening model, not a validated dispersion model.
 *
 * Emissions (Seiler & Crutzen): burned biomass × emission factor. Biomass consumed per cell depends on land cover
 * and fuel; it is released evenly while the cell burns. Emission factors, g per kg dry matter, from Andreae & Merlet
 * (2001): extratropical forest CO2 1569, CO 107, PM2.5 13.0; savanna and grassland CO2 1613, CO 65, PM2.5 5.4.
 *
 * Transport: a 550 m grid three times the fire grid's size in each direction. Each 10-minute step adds emissions,
 * moves the smoke with that hour's wind (semi-Lagrangian advection) and spreads it a little sideways. Smoke is
 * mixed evenly up to the mixing height, which is low at night (~400 m, smoke stays near the ground) and high in the
 * afternoon (~1500 m). Part of the smoke of a large fire is lofted above that layer (20–75 % with the burning
 * area) and does not reach the ground nearby. Chemistry and deposition are ignored.
 */

export const SMOKE_FACTOR = 5 // smoke cell = 5 × 5 fire cells

/** Consumed dry biomass, kg/m², at full fuel (scaled by the cell's fuel 0–1). Built-up land: gardens and structures. */
const CONSUMED_KG_M2 = [0, 1.0, 0.8, 2.0, 3.0]
const EF = {
  forest: { co2: 1569, co: 107, pm: 13.0 },
  open: { co2: 1613, co: 65, pm: 5.4 },
}
const efFor = (kind: number) => (kind === 2 ? EF.open : EF.forest)

/** US EPA AQI breakpoints for PM2.5 (2024 revision), µg/m³; strictly 24-hour averages, used here hour by hour. */
export const AQI = [
  { max: 9, name: 'İyi', color: '#3fa564' },
  { max: 35.4, name: 'Orta', color: '#e3d23a' },
  { max: 55.4, name: 'Hassas gruplar için sağlıksız', color: '#ee7a2b' },
  { max: 125.4, name: 'Sağlıksız', color: '#e5483d' },
  { max: 225.4, name: 'Çok sağlıksız', color: '#9b4fb0' },
  { max: Infinity, name: 'Tehlikeli', color: '#8a1a3a' },
] as const
export const aqiOf = (pm: number) => AQI.find((a) => pm <= a.max)!

/** mg/m³ of CO to ppm at 25 °C. */
const CO_PPM_PER_MGM3 = 24.45 / 28.01

export interface SettlementSmoke {
  id: string
  /** Ground-level PM2.5, µg/m³, per step. */
  pm: Float32Array
  /** Ground-level CO, ppm, per step. */
  coPpm: Float32Array
}

export interface SmokeResult {
  cols: number
  rows: number
  cellM: number
  lat0: number
  lon0: number
  dLat: number
  dLon: number
  /** Ground-level PM2.5, µg/m³, per step (index 0 … steps). */
  pm: Float32Array[]
  /** Cumulative emissions up to each step, tonnes. */
  co2T: Float64Array
  coT: Float64Array
  pmT: Float64Array
  biomassT: Float64Array
  /** Mixing height used at each step, m. */
  mixingM: Float32Array
  settlements: SettlementSmoke[]
}

/** Mixing height by local hour: shallow night inversion, deep afternoon boundary layer. */
export function mixingHeight(localHour: number): number {
  const h = ((localHour % 24) + 24) % 24
  if (h < 7 || h >= 21) return 400
  if (h < 14) return 400 + ((h - 7) / 7) * 1100
  if (h < 18) return 1500
  return 1500 - ((h - 18) / 3) * 1100
}

/** Local clock hour of the run's start: from the weather series, else an early-afternoon start. */
export function startHour(res: SimResult): number {
  const iso = res.config.weather?.startIso
  return iso ? Number(iso.slice(11, 13)) : 13
}

const cache = new WeakMap<SimResult, SmokeResult>()

export function computeSmoke(res: SimResult): SmokeResult {
  const hit = cache.get(res)
  if (hit) return hit
  const g = res.grid
  const F = SMOKE_FACTOR
  const fcols = g.cols
  const frows = g.rows
  const cols = Math.ceil(fcols / F) * 3
  const rows = Math.ceil(frows / F) * 3
  const offC = Math.ceil(fcols / F)
  const offR = Math.ceil(frows / F)
  const cellM = g.cellM * F
  const area = cellM * cellM
  const n = cols * rows
  const steps = res.steps

  // --- emissions per fire cell: total kg and the steps it releases them over ---
  const fn = fcols * frows
  const emitStart = new Int16Array(fn).fill(-1)
  const emitEnd = new Int16Array(fn)
  const biomass = new Float32Array(fn) // kg released per step
  for (let i = 0; i < fn; i++) {
    const t = res.ignitionStep[i]
    if (t < 0) continue
    const end = Math.max(t + 1, res.burnoutStep[i])
    const kind = g.kind[i]
    const fuel = kind === 1 ? 1 : fuelOf(g, i, res.config.fuelLoad)
    const kg = CONSUMED_KG_M2[kind] * fuel * g.cellM * g.cellM
    emitStart[i] = t
    emitEnd[i] = end
    biomass[i] = kg / (end - t)
  }
  const smokeCell = (i: number) => (Math.floor(i / fcols / F) + offR) * cols + Math.floor((i % fcols) / F) + offC

  // --- wind per smoke cell, sampled from the fire grid (clamped at its edges), refreshed every hour ---
  const u = new Float32Array(n)
  const v = new Float32Array(n)
  let hourNow = -1
  const enterHour = (h: number) => {
    if (h === hourNow) return
    hourNow = h
    const w: CellWeather = cellWeather(g, res.config, h)
    for (let r = 0; r < rows; r++) {
      const fr = Math.min(frows - 1, Math.max(0, Math.floor((r - offR + 0.5) * F)))
      for (let c = 0; c < cols; c++) {
        const fc = Math.min(fcols - 1, Math.max(0, Math.floor((c - offC + 0.5) * F)))
        const j = fr * fcols + fc
        u[r * cols + c] = w.windSpeedKmh[j] * Math.sin(w.windToRad[j])
        v[r * cols + c] = w.windSpeedKmh[j] * Math.cos(w.windToRad[j])
      }
    }
  }

  // smoke cells moved per step for 1 km/h
  const moveCells = ((1000 / 3600) * STEP_MIN * 60) / cellM
  const SPREAD = 0.18 // share of a cell's smoke handed to each of its 4 neighbours per pass
  const SPREAD_PASSES = 3

  let mPm = new Float32Array(n)
  let mCo = new Float32Array(n)
  let tmpPm = new Float32Array(n)
  let tmpCo = new Float32Array(n)
  const pmField: Float32Array[] = []
  const co2T = new Float64Array(steps + 1)
  const coT = new Float64Array(steps + 1)
  const pmT = new Float64Array(steps + 1)
  const biomassT = new Float64Array(steps + 1)
  const mixingM = new Float32Array(steps + 1)
  const h0 = startHour(res)

  const sPos: { id: string; pos: LatLon }[] = regionById(res.config.areaId).settlements
  const sOut: SettlementSmoke[] = sPos.map((s) => ({ id: s.id, pm: new Float32Array(steps + 1), coPpm: new Float32Array(steps + 1) }))
  const sample = (field: Float32Array, lat: number, lon: number) => {
    const x = (lon - (g.lon0 - offC * F * g.dLon)) / (F * g.dLon) - 0.5
    const y = (g.lat0 + offR * F * g.dLat - lat) / (F * g.dLat) - 0.5
    return bilinear(field, cols, rows, x, y)
  }

  let cCo2 = 0
  let cCo = 0
  let cPm = 0
  let cBio = 0
  for (let s = 0; s <= steps; s++) {
    enterHour(Math.floor((s * STEP_MIN) / 60))
    // 1. emissions released during step s. A large, intense fire lofts part of its smoke above the mixed layer
    //    (plume rise); that part is counted in the totals but does not reach the ground near the fire.
    const burningHa = res.series[Math.min(s, res.series.length - 1)].burningHa
    const ground = 1 - Math.min(0.75, 0.2 + burningHa / 1500)
    for (let i = 0; i < fn; i++) {
      if (emitStart[i] < 0 || s < emitStart[i] || s >= emitEnd[i]) continue
      const kg = biomass[i]
      const ef = efFor(g.kind[i])
      const k = smokeCell(i)
      mPm[k] += (kg * ef.pm * ground) / 1000
      mCo[k] += (kg * ef.co * ground) / 1000
      cCo2 += (kg * ef.co2) / 1e6
      cCo += (kg * ef.co) / 1e6
      cPm += (kg * ef.pm) / 1e6
      cBio += kg / 1000
    }
    co2T[s] = cCo2
    coT[s] = cCo
    pmT[s] = cPm
    biomassT[s] = cBio

    // 2. advection: each cell takes the smoke found upwind of it
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const k = r * cols + c
        const x = c - u[k] * moveCells
        const y = r + v[k] * moveCells // rows run south
        tmpPm[k] = bilinear(mPm, cols, rows, x, y)
        tmpCo[k] = bilinear(mCo, cols, rows, x, y)
      }
    ;[mPm, tmpPm] = [tmpPm, mPm]
    ;[mCo, tmpCo] = [tmpCo, mCo]

    // 3. sideways spreading (eddies and wind meander widen the plume; ~1.5 km after an hour of travel)
    for (let pass = 0; pass < SPREAD_PASSES; pass++)
    for (const [m, t] of [[mPm, tmpPm], [mCo, tmpCo]] as const) {
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
          const k = r * cols + c
          let gain = 0
          if (c > 0) gain += m[k - 1]
          if (c < cols - 1) gain += m[k + 1]
          if (r > 0) gain += m[k - cols]
          if (r < rows - 1) gain += m[k + cols]
          t[k] = m[k] * (1 - 4 * SPREAD) + gain * SPREAD
        }
      m.set(t)
    }

    // 4. ground-level concentration
    const H = mixingHeight(h0 + (s * STEP_MIN) / 60)
    mixingM[s] = H
    const field = new Float32Array(n)
    const toUg = 1e9 / (area * H) // kg per cell -> µg/m³
    for (let k = 0; k < n; k++) field[k] = mPm[k] * toUg
    pmField.push(field)
    for (let j = 0; j < sPos.length; j++) {
      const [lat, lon] = sPos[j].pos
      sOut[j].pm[s] = sample(field, lat, lon)
      const coMgM3 = sample(mCo, lat, lon) * (1e6 / (area * H))
      sOut[j].coPpm[s] = coMgM3 * CO_PPM_PER_MGM3
    }
  }

  const out: SmokeResult = {
    cols,
    rows,
    cellM,
    lat0: g.lat0 + offR * F * g.dLat,
    lon0: g.lon0 - offC * F * g.dLon,
    dLat: F * g.dLat,
    dLon: F * g.dLon,
    pm: pmField,
    co2T,
    coT,
    pmT,
    biomassT,
    mixingM,
    settlements: sOut,
  }
  cache.set(res, out)
  return out
}

function bilinear(f: Float32Array, cols: number, rows: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x > cols - 1 || y > rows - 1) return 0
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = Math.min(cols - 1, x0 + 1)
  const y1 = Math.min(rows - 1, y0 + 1)
  const tx = x - x0
  const ty = y - y0
  return (f[y0 * cols + x0] * (1 - tx) + f[y0 * cols + x1] * tx) * (1 - ty) + (f[y1 * cols + x0] * (1 - tx) + f[y1 * cols + x1] * tx) * ty
}

/** PM2.5 (µg/m³) at a point and step, 0 outside the smoke grid. */
export function pmAt(sm: SmokeResult, step: number, lat: number, lon: number): number {
  const f = sm.pm[Math.min(step, sm.pm.length - 1)]
  return bilinear(f, sm.cols, sm.rows, (lon - sm.lon0) / sm.dLon - 0.5, (sm.lat0 - lat) / sm.dLat - 0.5)
}

export interface Exposure {
  id: string
  peakPm: number
  peakStep: number
  peakCoPpm: number
  /** First step at or above "unhealthy for sensitive groups" (35.5) and "unhealthy" (55.5); null if never. */
  firstSensitiveStep: number | null
  firstUnhealthyStep: number | null
  hoursSensitive: number
  hoursUnhealthy: number
  hoursVeryUnhealthy: number
  hoursCoAbove9: number
  /** Still at or above 35.5 µg/m³ when the run ends. */
  ongoing: boolean
}

export function exposures(sm: SmokeResult): Exposure[] {
  const h = STEP_MIN / 60
  return sm.settlements.map((s) => {
    let peak = 0
    let peakStep = 0
    let peakCo = 0
    let fs: number | null = null
    let fu: number | null = null
    let hs = 0
    let hu = 0
    let hv = 0
    let hc = 0
    for (let t = 0; t < s.pm.length; t++) {
      const p = s.pm[t]
      if (p > peak) { peak = p; peakStep = t }
      peakCo = Math.max(peakCo, s.coPpm[t])
      if (p > 35.4) { hs += h; fs ??= t }
      if (p > 55.4) { hu += h; fu ??= t }
      if (p > 125.4) hv += h
      if (s.coPpm[t] > 9) hc += h
    }
    return { id: s.id, peakPm: peak, peakStep, peakCoPpm: peakCo, firstSensitiveStep: fs, firstUnhealthyStep: fu, hoursSensitive: hs, hoursUnhealthy: hu, hoursVeryUnhealthy: hv, hoursCoAbove9: hc, ongoing: s.pm[s.pm.length - 1] > 35.4 }
  })
}
