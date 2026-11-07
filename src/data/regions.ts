import type { LatLon } from '../sim/geo'
import type { Settlement, SimConfig } from '../sim/types'
import { OSM } from './osm.generated'

export interface SampleWeather {
  temperatureC: number
  humidityPct: number
  windSpeedKmh: number
  windFromDeg: number
  precipMmH: number
}

export interface Region {
  id: string
  name: string
  province: string
  center: LatLon
  /** Illustrative fire danger index, 0–100. Not a real forecast. */
  risk: number
  forestKm2: number
  seed: number
  defaultIgnition: LatLon
  weather: SampleWeather
  settlements: Settlement[]
  /** Pop-up note for the map. */
  note: string
}

/** Settlements baked from OpenStreetMap (scripts/bake-osm.ts): real place nodes inside the grid. */
const osmSettlements = (id: string): Settlement[] => OSM[id]?.settlements ?? []

export const REGIONS: Region[] = [
  {
    id: 'mugla',
    name: 'Muğla / Marmaris',
    province: 'Muğla',
    center: [36.86, 28.24],
    risk: 87,
    forestKm2: 1840,
    seed: 4817,
    defaultIgnition: [36.891, 28.198],
    weather: { temperatureC: 33, humidityPct: 26, windSpeedKmh: 28, windFromDeg: 315, precipMmH: 0 },
    note: 'Marmaris koyunun ardındaki çam ve maki kaplı tepeler; kurak yazlar ve öğleden sonra esen karayel.',
    settlements: osmSettlements('mugla'),
  },
  {
    id: 'izmir',
    name: 'İzmir',
    province: 'İzmir',
    center: [38.23, 26.8],
    risk: 74,
    forestKm2: 1260,
    seed: 9021,
    defaultIgnition: [38.245, 26.77],
    weather: { temperatureC: 35, humidityPct: 22, windSpeedKmh: 24, windFromDeg: 20, precipMmH: 0 },
    note: "İzmir'in batısında, karışık çam ve maki örtülü Ege tepeleri.",
    settlements: osmSettlements('izmir'),
  },
  {
    id: 'antalya',
    name: 'Antalya',
    province: 'Antalya',
    center: [36.58, 30.52],
    risk: 79,
    forestKm2: 1520,
    seed: 2203,
    defaultIgnition: [36.60, 30.50],
    weather: { temperatureC: 36, humidityPct: 24, windSpeedKmh: 22, windFromDeg: 270, precipMmH: 0 },
    note: 'Kemer kıyısının üzerindeki Toros etekleri; dik yamaçlar ve reçineli çam.',
    settlements: osmSettlements('antalya'),
  },
  {
    id: 'canakkale',
    name: 'Çanakkale',
    province: 'Çanakkale',
    center: [39.95, 26.55],
    risk: 58,
    forestKm2: 940,
    seed: 6310,
    defaultIgnition: [39.965, 26.52],
    weather: { temperatureC: 30, humidityPct: 34, windSpeedKmh: 30, windFromDeg: 45, precipMmH: 0 },
    note: 'Biga yarımadasında çam ormanları; yazın kuvvetli poyraz.',
    settlements: osmSettlements('canakkale'),
  },
  {
    id: 'balikesir',
    name: 'Balıkesir',
    province: 'Balıkesir',
    center: [39.58, 27.0],
    risk: 66,
    forestKm2: 1130,
    seed: 1177,
    defaultIgnition: [39.59, 26.97],
    weather: { temperatureC: 32, humidityPct: 29, windSpeedKmh: 26, windFromDeg: 0, precipMmH: 0 },
    note: 'Edremit körfezi yakınında Kaz Dağları etekleri; dik arazi ve yoğun çam.',
    settlements: osmSettlements('balikesir'),
  },
]

REGIONS.push({
  id: 'menderes',
  name: 'İzmir / Menderes–Seferihisar',
  province: 'İzmir',
  center: [38.113, 26.869],
  risk: 78,
  forestKm2: 900,
  seed: 7311,
  // estimated ignition of the 29 June 2025 fire (see Geçmişteki Yangınlar)
  defaultIgnition: [38.1852, 26.8685],
  weather: { temperatureC: 34, humidityPct: 24, windSpeedKmh: 30, windFromDeg: 0, precipMmH: 0 },
  note: '29 Haziran 2025 yangınının yaşandığı Menderes–Seferihisar arasındaki çam ve maki kaplı tepeler.',
  settlements: osmSettlements('menderes'),
})

export const regionById = (id: string): Region => REGIONS.find((r) => r.id === id) ?? REGIONS[0]

export function defaultConfig(region: Region): SimConfig {
  return {
    areaId: region.id,
    ignition: region.defaultIgnition,
    intensity: 'medium',
    durationH: 12,
    temperatureC: region.weather.temperatureC,
    humidityPct: region.weather.humidityPct,
    windSpeedKmh: region.weather.windSpeedKmh,
    windFromDeg: region.weather.windFromDeg,
    precipMmH: region.weather.precipMmH,
    terrain: 'rolling-hills',
    fuelLoad: 1,
  }
}

/** Illustrative hotspots drawn on the national risk layer. Not real observations. */
export const RISK_HOTSPOTS: { pos: LatLon; risk: number }[] = [
  { pos: [36.86, 28.24], risk: 87 },
  { pos: [37.1, 28.0], risk: 76 },
  { pos: [37.0, 27.4], risk: 71 },
  { pos: [38.23, 26.8], risk: 74 },
  { pos: [38.5, 27.6], risk: 63 },
  { pos: [36.58, 30.52], risk: 79 },
  { pos: [36.9, 31.3], risk: 68 },
  { pos: [36.35, 32.3], risk: 60 },
  { pos: [39.95, 26.55], risk: 58 },
  { pos: [39.58, 27.0], risk: 66 },
  { pos: [38.0, 29.8], risk: 49 },
  { pos: [37.2, 34.5], risk: 52 },
  { pos: [41.1, 31.4], risk: 34 },
  { pos: [40.4, 29.2], risk: 42 },
]

/** Illustrative simulated active fires for the dashboard. */
export const SIMULATED_FIRES: { id: string; name: string; pos: LatLon; areaId: string; hours: number }[] = [
  { id: 'f1', name: 'Marmaris KB sırtı (demo)', pos: [36.891, 28.198], areaId: 'mugla', hours: 3.5 },
  { id: 'f2', name: 'Seferihisar batı (örnek)', pos: [38.245, 26.77], areaId: 'izmir', hours: 1.2 },
  { id: 'f3', name: 'Kemer yaylası (örnek)', pos: [36.6, 30.5], areaId: 'antalya', hours: 5.0 },
]
