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
  /** Leave out the protection that already exists (roads, fire breaks, burn scars, towers, ponds); default false. */
  ignoreExisting?: boolean
  /** How terrain and fuelLoad were worked out automatically (src/sim/landAuto.ts); null = set by hand. */
  landAuto?: import('./landAuto').LandAuto | null
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
  /** Estimated tree/shrub species per cell (src/data/vegetation.ts), 0 = none. */
  species: Uint8Array
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
  /** Ember spot fires (step, source cell, landing cell). */
  spots?: { step: number; from: number; to: number }[]
  /** Present when the run was fought by the response commander. */
  response?: ResponseRecord
}

// ---------- response (Komuta Merkezi) ----------

/** Eight compass sectors around the ignition point, clockwise from north. */
export const SECTORS = ['K', 'KD', 'D', 'GD', 'G', 'GB', 'B', 'KB'] as const
export type Sector = (typeof SECTORS)[number]

export type ResourceKind = 'crew' | 'dozer' | 'heli' | 'plane'
export type ResourceStatus = 'unavailable' | 'idle' | 'enroute' | 'mopping' | 'attacking' | 'building' | 'holding' | 'dropping' | 'retreated' | 'grounded'

export interface CommanderAction {
  type: 'attack' | 'establish_line' | 'assign_line' | 'air_drop' | 'evacuate' | 'withdraw' | 'hold'
  candidate: 'A' | 'B' | 'C' | null
  line_id: string | null
  sector: Sector | null
  resource_id: string | null
  settlement_id: string | null
  rationale: string
}

export interface CommanderOutput {
  assessment: string
  phase: string
  actions: CommanderAction[]
}

export interface Decision {
  step: number
  trigger: string
  source: 'ai' | 'rules' | 'human'
  /** Why the rules ran instead of the AI, when they did. */
  fallbackReason?: string
  output: CommanderOutput
  /** One line per action: what the engine did with it. */
  applied: string[]
}

export interface ResponseEvent {
  step: number
  kind: 'arrive' | 'retreat' | 'breach' | 'line_done' | 'evac_start' | 'evac_done' | 'evac_risk' | 'grounded' | 'airborne' | 'drop' | 'out'
  text: string
}

export interface ResponseRecord {
  startStep: number
  decisions: Decision[]
  events: ResponseEvent[]
  lines: {
    id: string
    level: number
    hoursAhead: number
    createdStep: number
    cells: number[]
    sectorOf: number[]
    /** Step each cell was cleared, -1 if never. */
    builtStep: number[]
    /** Step each sector was first crossed by the fire, null if held. */
    breachedStep: (number | null)[]
  }[]
  tracks: {
    id: string
    name: string
    kind: ResourceKind
    points: { step: number; lat: number; lon: number; status: ResourceStatus }[]
    /** Each trip: the road path driven (or flown) between two steps, at even speed. */
    moves: { fromStep: number; toStep: number; path: LatLon[] }[]
  }[]
  drops: { step: number; lat: number; lon: number }[]
  evacuations: { settlementId: string; name: string; population: number; startStep: number; doneStep: number; atRisk: boolean; to: string; geom: LatLon[] }[]
  /** The same fire with no response, for comparison. */
  baseline: { affectedHa: number; forestHa: number; settlementsReached: number; steps: number }
  extinguishedStep: number | null
}
