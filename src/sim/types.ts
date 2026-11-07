import type { LatLon } from './geo'

export type Intensity = 'low' | 'medium' | 'high'
export type TerrainType = 'coastal-plain' | 'rolling-hills' | 'steep-mountain'

export interface SimConfig {
  areaId: string
  ignition: LatLon
  intensity: Intensity
  /** Whole hours, 1–72. */
  durationH: number
  temperatureC: number
  humidityPct: number
  windSpeedKmh: number
  /** Meteorological convention: direction the wind blows FROM, degrees clockwise from north. */
  windFromDeg: number
  precipMmH: number
  terrain: TerrainType
  /** Multiplier on vegetation density (fuel load). */
  fuelLoad: number
  /**
   * Hourly weather that changes over the run (and across the grid). When absent the single values above hold for
   * the whole run everywhere.
   */
  weather?: WeatherSeries
}

export interface WeatherSeries {
  source: 'open-meteo-forecast' | 'open-meteo-archive' | 'custom'
  /** Local start hour, Europe/Istanbul, e.g. "2026-07-28T13:00". Hour 0 of the run. */
  startIso: string
  /** 3×3 sample points, row-major from north-west to south-east. */
  points: LatLon[]
  /** Values per [point][hour]; hour 0 = startIso, at least durationH + 1 hours. */
  temperatureC: number[][]
  humidityPct: number[][]
  windSpeedKmh: number[][]
  /** Direction the wind blows FROM, degrees clockwise from north. */
  windFromDeg: number[][]
  precipMmH: number[][]
}

export interface Settlement {
  id: string
  name: string
  pos: LatLon
  population: number
  radiusM: number
}

/** 0 water, 1 urban, 2 sparse/agricultural, 3 maquis shrubland, 4 pine forest */
export type CoverKind = 0 | 1 | 2 | 3 | 4

export interface Grid {
  areaId: string
  cols: number
  rows: number
  cellM: number
  lat0: number // north edge
  lon0: number // west edge
  dLat: number // degrees per cell (positive)
  dLon: number
  elev: Float32Array // metres
  veg: Float32Array // 0..1
  kind: Uint8Array
}

export interface StepStat {
  step: number
  minutes: number
  burningHa: number
  affectedHa: number
  forestHa: number
  pineHa: number
  maquisHa: number
  sparseHa: number
  perimeterKm: number
  rosMh: number
  maxRadiusKm: number
  headingDeg: number | null
}

export interface SettlementImpact {
  id: string
  arrivalMin: number | null
  exposurePct: number
}

export interface SimResult {
  config: SimConfig
  grid: Grid
  stepMin: number
  steps: number
  /** Step at which each cell ignites, -1 if never. */
  ignitionStep: Int16Array
  burnoutStep: Int16Array
  originCell: number
  series: StepStat[]
  impacts: SettlementImpact[]
}
