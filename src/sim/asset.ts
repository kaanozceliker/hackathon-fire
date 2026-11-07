import { regionById, defaultConfig } from '../data/regions'
import { getInfrastructure } from '../data/infrastructure'
import { getGrid } from './gridCache'
import { fuelOf, runSimulation } from './engine'
import { existingFor, towerSeeing } from './existing'
import { findRoute } from './planner'
import { polygonCells } from './drill'
import { cellCenter, cellOf } from './terrain'
import { compass, haversineM, type LatLon } from './geo'
import { SECTORS, type Grid, type Sector } from './types'

/**
 * Varlık Kalkanı: wildfire exposure of a single asset (a house, a business, a facility) drawn on the map.
 * Looks at the land around it in three rings and eight directions – vegetation and fuel, slope towards the asset,
 * how often the wind blows from each side (7-day forecast plus the area's typical fire-season wind), road access and
 * the nearest fire station, water and earlier burns – and runs a few test fires from the riskiest directions.
 */

export type AssetKind = 'ev' | 'isyeri' | 'tesis' | 'tarim'
export const ASSET_KIND_LABEL: Record<AssetKind, string> = { ev: 'Ev', isyeri: 'İşyeri / şirket', tesis: 'Tesis / depo', tarim: 'Tarım yapısı' }

export const RINGS = [
  { label: 'Yakın çevre', fromM: 0, toM: 150 },
  { label: 'Orta kuşak', fromM: 150, toM: 500 },
  { label: 'Geniş çevre', fromM: 500, toM: 2000 },
] as const

export interface RingStat {
  label: string
  fromM: number
  toM: number
  forestHa: number
  shrubHa: number
  openHa: number
  builtHa: number
  waterHa: number
  /** Mean fuel of the burnable land, 0–1. */
  fuel: number
}

export interface SectorRisk {
  sector: Sector
  bearing: number
  /** Forest and shrub within 2 km, ha. */
  fuelHa: number
  /** Forest and shrub within 300 m, ha. */
  nearFuelHa: number
  /** Mean rise from the land in this direction up to the asset, % (positive: fire would run uphill to it). */
  upslopePct: number
  /** Share of the expected wind that blows from this direction towards the asset, 0–1. */
  windShare: number
  score: number
}

export interface WeatherDay {
  date: string
  tmax: number
  rhMin: number
  windMax: number
  windFrom: number
}

export interface AssetProfile {
  areaId: string
  name: string
  kind: AssetKind
  centroid: LatLon
  areaHa: number
  assetElev: number
  rings: RingStat[]
  sectors: SectorRisk[]
  weather: { source: 'forecast' | 'typical'; days: WeatherDay[]; typicalFrom: number; typicalKmh: number; dangerDays: number }
  access: { roadM: number | null; roadClass: string; station: { name: string; km: number; etaMin: number } | null; waterM: number | null; waterName: string | null }
  existing: { burnScarHa: number; tower: string | null }
  fireTests: { sector: Sector; startKm: number; arrivalMin: number | null; burnedHa: number }[]
  score: number
  level: RiskLevel
}

export type RiskLevel = 'dusuk' | 'orta' | 'yuksek' | 'cok_yuksek'
export const LEVEL_LABEL: Record<RiskLevel, string> = { dusuk: 'Düşük', orta: 'Orta', yuksek: 'Yüksek', cok_yuksek: 'Çok yüksek' }
export const LEVEL_COLOR: Record<RiskLevel, string> = { dusuk: '#3fa564', orta: '#e3d23a', yuksek: '#ee7a2b', cok_yuksek: '#e5483d' }
export const levelOf = (score: number): RiskLevel => (score >= 70 ? 'cok_yuksek' : score >= 50 ? 'yuksek' : score >= 30 ? 'orta' : 'dusuk')

const bearingDeg = (a: LatLon, b: LatLon) => {
  const dy = b[0] - a[0]
  const dx = (b[1] - a[1]) * Math.cos((a[0] * Math.PI) / 180)
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360
}
const sectorOf = (deg: number) => Math.round(deg / 45) % 8
const ROAD_CLASS = ['yol yok', 'tali yol / orman yolu', 'ara yol', 'ana yol']

/** 7-day forecast at the asset (Open-Meteo); null when it cannot be reached. */
export async function fetchAssetWeather(p: LatLon): Promise<WeatherDay[] | null> {
  try {
    const u = `https://api.open-meteo.com/v1/forecast?latitude=${p[0].toFixed(4)}&longitude=${p[1].toFixed(4)}&daily=temperature_2m_max,relative_humidity_2m_min,wind_speed_10m_max,wind_direction_10m_dominant&timezone=Europe%2FIstanbul&forecast_days=7`
    const r = await fetch(u)
    if (!r.ok) return null
    const j = await r.json()
    const d = j.daily
    return (d.time as string[]).map((date, i) => ({ date, tmax: d.temperature_2m_max[i], rhMin: d.relative_humidity_2m_min[i], windMax: d.wind_speed_10m_max[i], windFrom: d.wind_direction_10m_dominant[i] }))
  } catch {
    return null
  }
}

export function analyseAsset(areaId: string, polygon: LatLon[], name: string, kind: AssetKind, days: WeatherDay[] | null): AssetProfile {
  const grid = getGrid(areaId)
  const region = regionById(areaId)
  const infra = getInfrastructure(region)
  const ex = existingFor(areaId)
  const haC = (grid.cellM * grid.cellM) / 10000
  const centroid: LatLon = [polygon.reduce((a, p) => a + p[0], 0) / polygon.length, polygon.reduce((a, p) => a + p[1], 0) / polygon.length]
  let assetCells = polygonCells(grid, polygon)
  if (!assetCells.length) {
    const c = cellOf(grid, centroid[0], centroid[1])
    assetCells = c >= 0 ? [c] : []
  }
  const assetElev = assetCells.reduce((a, c) => a + grid.elev[c], 0) / Math.max(1, assetCells.length)
  const assetPts = assetCells.map((c) => cellCenter(grid, c))
  // land around the asset, by distance from its nearest part
  const R = Math.ceil(2100 / grid.cellM)
  const c0 = cellOf(grid, centroid[0], centroid[1])
  const rings: RingStat[] = RINGS.map((r) => ({ ...r, forestHa: 0, shrubHa: 0, openHa: 0, builtHa: 0, waterHa: 0, fuel: 0 }))
  const fuelSum = [0, 0, 0]
  const fuelN = [0, 0, 0]
  const sec = SECTORS.map((s, k) => ({ sector: s, bearing: k * 45, fuelHa: 0, nearFuelHa: 0, rise: 0, riseN: 0 }))
  const inAsset = new Set(assetCells)
  if (c0 >= 0)
    for (let dy = -R; dy <= R; dy++)
      for (let dx = -R; dx <= R; dx++) {
        const x = (c0 % grid.cols) + dx
        const y = ((c0 / grid.cols) | 0) + dy
        if (x < 0 || y < 0 || x >= grid.cols || y >= grid.rows) continue
        const i = y * grid.cols + x
        if (inAsset.has(i)) continue
        const p = cellCenter(grid, i)
        let d = Infinity
        for (const a of assetPts) d = Math.min(d, haversineM(a, p))
        const ring = rings.findIndex((r) => d >= r.fromM && d < r.toM)
        if (ring < 0) continue
        const k = grid.kind[i]
        const st = rings[ring]
        if (k === 0) st.waterHa += haC
        else if (k === 1) st.builtHa += haC
        else if (k === 2) st.openHa += haC
        else if (k === 3) st.shrubHa += haC
        else st.forestHa += haC
        if (k >= 2) {
          fuelSum[ring] += fuelOf(grid, i, 1)
          fuelN[ring]++
        }
        const s = sec[sectorOf(bearingDeg(centroid, p))]
        if (k >= 3) {
          s.fuelHa += haC
          if (d < 300) s.nearFuelHa += haC
        }
        // slope towards the asset from 150 m out (closer cells share the asset's own ground)
        if (k !== 0 && d < 1200 && d > 150) {
          s.rise += ((assetElev - grid.elev[i]) / d) * 100
          s.riseN++
        }
      }
  rings.forEach((r, k) => (r.fuel = fuelN[k] ? fuelSum[k] / fuelN[k] : 0))

  // wind: the days ahead weighted by their strength, plus the area's typical fire-season wind (twice the weight of a day)
  const typical = region.weather
  const wind = new Array(8).fill(0)
  let wTot = 0
  for (const d of days ?? []) {
    wind[sectorOf(d.windFrom)] += d.windMax
    wTot += d.windMax
  }
  const tw = Math.max(1, (wTot / Math.max(1, days?.length ?? 1)) * 2)
  wind[sectorOf(typical.windFromDeg)] += tw
  wTot += tw
  const dangerDays = (days ?? []).filter((d) => d.tmax >= 30 && d.rhMin <= 30 && d.windMax >= 25).length

  const sectorArea = (Math.PI * 2 * 2) / 8 * 100
  const sectors: SectorRisk[] = sec.map((s, k) => {
    const upslopePct = s.riseN ? s.rise / s.riseN : 0
    const windShare = wind[k] / Math.max(1, wTot)
    const fuel = Math.min(1, s.fuelHa / (sectorArea * 0.7))
    const near = Math.min(1, s.nearFuelHa / 4)
    const up = Math.max(0, Math.min(1, upslopePct / 20))
    const score = Math.round(100 * Math.min(1, fuel * 0.38 + near * 0.27 + up * 0.15 + Math.min(1, windShare * 2.5) * 0.2))
    return { sector: s.sector, bearing: s.bearing, fuelHa: Math.round(s.fuelHa), nearFuelHa: +s.nearFuelHa.toFixed(1), upslopePct: +upslopePct.toFixed(1), windShare: +windShare.toFixed(2), score }
  })

  // access: the nearest road, the fire station by road, the nearest water
  let roadM: number | null = null
  let roadClass = ROAD_CLASS[0]
  if (ex.roads && c0 >= 0) {
    const RR = Math.ceil(3000 / grid.cellM)
    let best = Infinity
    let cls = 0
    for (let dy = -RR; dy <= RR; dy++)
      for (let dx = -RR; dx <= RR; dx++) {
        const x = (c0 % grid.cols) + dx
        const y = ((c0 / grid.cols) | 0) + dy
        if (x < 0 || y < 0 || x >= grid.cols || y >= grid.rows) continue
        const i = y * grid.cols + x
        if (!ex.roads[i]) continue
        const d = haversineM(centroid, cellCenter(grid, i))
        if (d < best) {
          best = d
          cls = ex.roads[i]
        }
      }
    if (best < Infinity) {
      roadM = Math.round(best)
      roadClass = ROAD_CLASS[cls]
    }
  }
  const junctions = infra.nodes.filter((n) => n.kind !== 'safe' && n.kind !== 'station')
  const stations = infra.nodes.filter((n) => n.kind === 'station')
  let station: AssetProfile['access']['station'] = null
  const near = junctions.reduce<(typeof junctions)[number] | null>((a, b) => (!a || haversineM(b.pos, centroid) < haversineM(a.pos, centroid) ? b : a), null)
  for (const s of stations) {
    const route = near ? findRoute(infra, new Map(), s.id, near.id, 0) : null
    const off = near ? haversineM(near.pos, centroid) / 1000 : haversineM(s.pos, centroid) / 1000
    const eta = route ? route.etaMin + (off / 20) * 60 : (haversineM(s.pos, centroid) / 1000 / 35) * 60
    if (!station || eta < station.etaMin) station = { name: s.name, km: +(haversineM(s.pos, centroid) / 1000).toFixed(1), etaMin: Math.round(eta) }
  }
  const water = infra.water.length ? infra.water.reduce((a, b) => (haversineM(b.pos, centroid) < haversineM(a.pos, centroid) ? b : a)) : null

  // earlier burns within 2 km and a lookout tower that sees the asset
  let scar = 0
  const year = new Date().getFullYear()
  if (ex.burnYear && c0 >= 0)
    for (let dy = -R; dy <= R; dy++)
      for (let dx = -R; dx <= R; dx++) {
        const x = (c0 % grid.cols) + dx
        const y = ((c0 / grid.cols) | 0) + dy
        if (x < 0 || y < 0 || x >= grid.cols || y >= grid.rows) continue
        const i = y * grid.cols + x
        if (ex.burnYear[i] && 2000 + ex.burnYear[i] < year && haversineM(centroid, cellCenter(grid, i)) <= 2000) scar += haC
      }

  // test fires from the three riskiest directions, 1.5 km out, wind blowing towards the asset
  const top = [...sectors].sort((a, b) => b.score - a.score).slice(0, 3)
  const maxWind = Math.max(typical.windSpeedKmh, ...(days ?? []).map((d) => d.windMax))
  const fireTests = top.map((s) => {
    const start = findStart(grid, centroid, s.bearing, 1500)
    if (!start) return { sector: s.sector, startKm: 1.5, arrivalMin: null, burnedHa: 0 }
    const cfg = { ...defaultConfig(region), ignition: start, windFromDeg: s.bearing, windSpeedKmh: Math.max(20, Math.min(45, maxWind)), humidityPct: 20, temperatureC: 35, durationH: 6, weather: undefined }
    const res = runSimulation(grid, cfg, region.settlements)
    let arr = Infinity
    const target = new Set(assetCells)
    for (const c of assetCells) {
      const x = c % grid.cols
      const y = (c / grid.cols) | 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (x + dx >= 0 && y + dy >= 0 && x + dx < grid.cols && y + dy < grid.rows) target.add((y + dy) * grid.cols + x + dx)
    }
    for (const c of target) if (res.ignitionStep[c] >= 0) arr = Math.min(arr, res.ignitionStep[c] * res.stepMin)
    return { sector: s.sector, startKm: +(haversineM(start, centroid) / 1000).toFixed(1), arrivalMin: arr < Infinity ? arr : null, burnedHa: Math.round(res.series[res.series.length - 1].affectedHa) }
  })

  // overall: the worst side counts most, then the rest, the weather ahead, a fast fire test and poor access
  const worst = Math.max(...sectors.map((s) => s.score))
  const mean = sectors.reduce((a, s) => a + s.score, 0) / 8
  const fast = fireTests.some((f) => f.arrivalMin !== null && f.arrivalMin <= 90) ? 1 : fireTests.some((f) => f.arrivalMin !== null) ? 0.5 : 0
  const accessBad = (station ? Math.min(1, station.etaMin / 45) : 1) * 0.5 + (roadM === null || roadM > 500 ? 0.5 : 0)
  const near150 = rings[0].forestHa + rings[0].shrubHa
  const score = Math.round(Math.min(100, worst * 0.45 + mean * 0.15 + (dangerDays / 7) * 10 + fast * 15 + accessBad * 8 + Math.min(1, near150 / 3) * 10))
  return {
    areaId,
    name,
    kind,
    centroid,
    areaHa: +(polygonAreaM2(polygon) / 10000).toFixed(2),
    assetElev: Math.round(assetElev),
    rings: rings.map((r) => ({ ...r, forestHa: +r.forestHa.toFixed(1), shrubHa: +r.shrubHa.toFixed(1), openHa: +r.openHa.toFixed(1), builtHa: +r.builtHa.toFixed(1), waterHa: +r.waterHa.toFixed(1), fuel: +r.fuel.toFixed(2) })),
    sectors,
    weather: { source: days ? 'forecast' : 'typical', days: days ?? [], typicalFrom: typical.windFromDeg, typicalKmh: typical.windSpeedKmh, dangerDays },
    access: { roadM, roadClass, station, waterM: water ? Math.round(haversineM(water.pos, centroid)) : null, waterName: water?.name ?? null },
    existing: { burnScarHa: Math.round(scar), tower: towerSeeing(areaId, centroid)?.name ?? null },
    fireTests,
    score,
    level: levelOf(score),
  }
}

/** A burnable cell about `distM` from the asset in a direction (searching a little around it). */
function findStart(grid: Grid, from: LatLon, bearing: number, distM: number): LatLon | null {
  const b = (bearing * Math.PI) / 180
  for (const f of [1, 0.8, 1.2, 0.6, 1.4]) {
    const p: LatLon = [from[0] + (distM * f * Math.cos(b)) / 111320, from[1] + (distM * f * Math.sin(b)) / (111320 * Math.cos((from[0] * Math.PI) / 180))]
    const c = cellOf(grid, p[0], p[1])
    if (c >= 0 && fuelOf(grid, c, 1) >= 0.25) return p
  }
  return null
}

function polygonAreaM2(poly: LatLon[]): number {
  const k = Math.cos((poly[0][0] * Math.PI) / 180) * 111320
  let a = 0
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][1] * k) * (poly[i][0] * 111320) - (poly[i][1] * k) * (poly[j][0] * 111320)
  return Math.abs(a / 2)
}

// ---------------------------------------------------------------- the report

export interface AssetReport {
  risk_level: RiskLevel
  headline: string
  summary: string
  priority_sectors: { sector: Sector; level: RiskLevel; reason: string }[]
  actions: { title: string; where: string; when: 'hemen' | 'sezon_oncesi' | 'yangin_sezonu' | 'surekli'; effort: 'dusuk' | 'orta' | 'yuksek'; reason: string }[]
  emergency: string[]
  access_note: string
  caveats: string
}

export const WHEN_LABEL: Record<AssetReport['actions'][number]['when'], string> = { hemen: 'Hemen', sezon_oncesi: 'Sezon öncesi', yangin_sezonu: 'Yangın sezonunda', surekli: 'Sürekli' }
export const EFFORT_LABEL: Record<AssetReport['actions'][number]['effort'], string> = { dusuk: 'Kolay', orta: 'Orta', yuksek: 'Kapsamlı' }

/** The numbers the AI reads. */
export function assetContext(p: AssetProfile) {
  return {
    asset: { name: p.name, type: ASSET_KIND_LABEL[p.kind], area_ha: p.areaHa, elevation_m: p.assetElev, region: regionById(p.areaId).name },
    computed_risk: { score: p.score, level: LEVEL_LABEL[p.level] },
    rings: p.rings.map((r) => ({ ring: `${r.fromM}–${r.toM} m`, forest_ha: r.forestHa, shrub_ha: r.shrubHa, open_ha: r.openHa, built_ha: r.builtHa, mean_fuel_0_1: r.fuel })),
    directions: p.sectors.map((s) => ({ from: s.sector, forest_and_shrub_within_2km_ha: s.fuelHa, within_300m_ha: s.nearFuelHa, upslope_to_asset_pct: s.upslopePct, wind_share: s.windShare, score: s.score })),
    weather: { next_7_days: p.weather.days.map((d) => ({ date: d.date, tmax_c: d.tmax, rh_min_pct: d.rhMin, wind_max_kmh: d.windMax, wind_from: compass(d.windFrom) })), typical_fire_season_wind: `${p.weather.typicalKmh} km/sa ${compass(p.weather.typicalFrom)}`, days_30_30_30: p.weather.dangerDays },
    access: { nearest_road_m: p.access.roadM, road_type: p.access.roadClass, fire_station: p.access.station, nearest_water_m: p.access.waterM, nearest_water: p.access.waterName },
    existing: { burned_within_2km_since_2018_ha: p.existing.burnScarHa, lookout_tower: p.existing.tower },
    test_fires: p.fireTests.map((f) => ({ from: f.sector, start_km: f.startKm, reaches_asset_after_min: f.arrivalMin, burned_ha_in_6h: f.burnedHa })),
  }
}

/** Rule fallback when the AI cannot be reached. */
export function ruleAssetReport(p: AssetProfile): AssetReport {
  const top = [...p.sectors].sort((a, b) => b.score - a.score).slice(0, 3)
  const fastest = p.fireTests.filter((f) => f.arrivalMin !== null).sort((a, b) => a.arrivalMin! - b.arrivalMin!)[0]
  const why = (s: SectorRisk) => [s.fuelHa > 60 ? `${s.fuelHa} ha orman ve maki` : null, s.nearFuelHa > 0.5 ? `300 m içinde ${s.nearFuelHa} ha bitki` : null, s.upslopePct > 4 ? `yapıya doğru %${s.upslopePct} yokuş` : null, s.windShare > 0.2 ? 'hakim rüzgar bu yönden' : null].filter(Boolean).join(', ')
  const n0 = p.rings[0].forestHa + p.rings[0].shrubHa
  const actions: AssetReport['actions'] = []
  if (n0 > 0.2) actions.push({ title: 'Yapının çevresindeki ilk 30 m\'yi yanmaz alan yapın', where: 'Yakın çevre', when: 'hemen', effort: 'orta', reason: `150 m içinde ${n0.toFixed(1)} ha orman ve maki var.` })
  actions.push({ title: `${top[0].sector} cephesinde 30–100 m kuşakta yakıt azaltın`, where: `${top[0].sector} cephesi`, when: 'sezon_oncesi', effort: 'orta', reason: why(top[0]) || 'En riskli yön.' })
  actions.push({ title: 'Çatı, oluk ve havalandırma açıklıklarını kora karşı koruyun', where: 'Yapı', when: 'sezon_oncesi', effort: 'dusuk', reason: 'Yapıların çoğu alevle değil, uçan korla tutuşur.' })
  if (!p.access.roadM || p.access.roadM > 300) actions.push({ title: 'İtfaiye aracının yanaşabileceği bir giriş yolu açın', where: 'Giriş', when: 'sezon_oncesi', effort: 'yuksek', reason: `En yakın yol ${p.access.roadM ?? '3000+'} m uzakta.` })
  if (!p.access.waterM || p.access.waterM > 1500) actions.push({ title: 'Yangın suyu deposu ve hortum hattı kurun', where: 'Yapı çevresi', when: 'sezon_oncesi', effort: 'orta', reason: 'Yakın su kaynağı yok.' })
  actions.push({ title: '30-30-30 günlerinde (30 °C, %30 nem, 30 km/sa rüzgar) açık ateş yakmayın, tahliye çantası hazır tutun', where: 'Tüm alan', when: 'yangin_sezonu', effort: 'dusuk', reason: `Önümüzdeki 7 günde ${p.weather.dangerDays} böyle gün var.` })
  return {
    risk_level: p.level,
    headline: `${top[0].sector} yönü öncelikli: ${why(top[0]) || 'en yüksek yakıt'}.`,
    summary: `Varlığın yangın riski ${LEVEL_LABEL[p.level].toLowerCase()} (${p.score}/100). ${fastest ? `${fastest.sector} yönünden ${fastest.startKm} km öteden çıkan bir yangın yaklaşık ${Math.round(fastest.arrivalMin! / 6) / 10} saatte yapıya ulaşıyor.` : 'Test yangınları 6 saat içinde yapıya ulaşmadı.'} En yakın itfaiye ${p.access.station ? `${p.access.station.name}, yolla ~${p.access.station.etaMin} dk` : 'bulunamadı'}.`,
    priority_sectors: top.map((s) => ({ sector: s.sector, level: levelOf(s.score), reason: why(s) || 'Diğer yönlere göre daha fazla yakıt.' })),
    actions,
    emergency: ['Tahliye yolunu ve ikinci bir çıkışı önceden belirleyin.', 'Yangın görürseniz 112\'yi arayın; yapıyı savunmaya çalışmayın, zamanında çıkın.', 'Değerli belgeleri ve ilaçları içeren bir tahliye çantası hazır tutun.'],
    access_note: p.access.station ? `${p.access.station.name} yolla ~${p.access.station.etaMin} dk; en yakın yol ${p.access.roadM ?? '–'} m (${p.access.roadClass}).` : 'Yakında itfaiye istasyonu bulunamadı.',
    caveats: 'Kural tabanlı değerlendirme. 110 m çözünürlüklü arazi verisine dayanır; bahçe, çit ve yapı malzemesi sahada incelenmelidir.',
  }
}
