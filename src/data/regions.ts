import type { LatLon } from '../sim/geo'
import type { Settlement, SimConfig } from '../sim/types'

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

const s = (id: string, name: string, pos: LatLon, population: number, radiusM: number): Settlement => ({
  id,
  name,
  pos,
  population,
  radiusM,
})

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
    settlements: [
      s('marmaris', 'Marmaris', [36.8545, 28.273], 35000, 1300),
      s('armutalan', 'Armutalan', [36.8815, 28.2605], 4200, 600),
      s('siteler', 'Siteler', [36.892, 28.298], 2500, 450),
      s('beldibi', 'Beldibi', [36.8655, 28.2125], 1100, 380),
      s('icmeler', 'İçmeler', [36.8195, 28.2375], 6500, 650),
    ],
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
    settlements: [
      s('seferihisar', 'Seferihisar', [38.196, 26.838], 18000, 800),
      s('orhanli', 'Orhanlı', [38.255, 26.835], 3200, 450),
      s('ulamis', 'Ulamış', [38.205, 26.765], 2100, 380),
      s('akarca', 'Akarca', [38.268, 26.765], 1500, 330),
    ],
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
    settlements: [
      s('kemer', 'Kemer', [36.598, 30.56], 12000, 800),
      s('camyuva', 'Çamyuva', [36.555, 30.578], 2400, 420),
      s('goynuk', 'Göynük', [36.625, 30.545], 3000, 450),
      s('tekirova', 'Tekirova', [36.535, 30.555], 1800, 380),
    ],
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
    settlements: [
      s('ezine', 'Ezine', [39.785, 26.34], 9000, 600),
      s('bayramic', 'Bayramiç', [39.81, 26.61], 12000, 700),
      s('kalkim', 'Kalkım', [39.98, 26.62], 1200, 330),
      s('kirazli', 'Kirazlı', [39.93, 26.46], 900, 300),
    ],
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
    settlements: [
      s('edremit', 'Edremit', [39.596, 27.025], 50000, 1100),
      s('zeytinli', 'Zeytinli', [39.553, 26.99], 1800, 380),
      s('altinoluk', 'Altınoluk', [39.57, 26.74], 7000, 600),
      s('akcay', 'Akçay', [39.57, 26.93], 6000, 560),
    ],
  },
]

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
