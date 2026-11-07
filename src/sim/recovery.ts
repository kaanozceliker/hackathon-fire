import { compass } from './geo'
import { cellCenter } from './terrain'
import { haversineM } from './geo'
import { weatherAt } from './weather'
import { regionById } from '../data/regions'
import { SPECIES } from '../data/species.generated'
import { SECTORS, type Sector, type SimResult } from './types'

/**
 * Post-fire strategy: a summary of what burned and where (by sector of the burned area) that the AI (or the rules
 * below, as a fallback) turns into a reforestation, prevention and recovery plan.
 */

export type RecoveryAction = 'dogal_yenilenme' | 'dikim' | 'erozyon_onlemi' | 'izleme'

export const ACTION_INFO: Record<RecoveryAction, { label: string; color: string }> = {
  dogal_yenilenme: { label: 'Doğal yenilenme (koruma altına al)', color: '#3fa564' },
  dikim: { label: 'Dikim / tohumlama', color: '#e3a72f' },
  erozyon_onlemi: { label: 'Önce erozyon önlemi', color: '#e5483d' },
  izleme: { label: 'İzleme yeterli', color: '#3b9be0' },
}

export interface RecoveryZone {
  sector: Sector
  burned_ha: number
  forest_ha: number
  pine_share_pct: number
  mean_elevation_m: number
  mean_slope_pct: number
  steep_share_pct: number
  main_aspect: string
  seed_source_nearby_pct: number
  settlements_within_1km: string[]
}

export interface RecoveryContext {
  region: string
  total_burned_ha: number
  forest_burned_ha: number
  fire_duration_h: number
  month: string | null
  climate: { afternoon_temperature_c: number; afternoon_humidity_pct: number; wind_kmh: number; wind_from: string }
  zones: RecoveryZone[]
  settlements_reached: string[]
  species_recorded: { group: string; species: number; notable: string[] }[]
  response_summary: string | null
}

export interface RecoveryPlan {
  summary: string
  zones: { sector: Sector; action: RecoveryAction; species: string[]; timing: string; rationale: string }[]
  prevention: { measure: string; where: string; rationale: string }[]
  phases: { phase: 'ilk_72_saat' | 'ilk_3_ay' | 'ilk_yil' | 'yil_1_5'; actions: string[] }[]
  monitoring: string[]
  caveats: string
}

export const PHASE_LABEL: Record<RecoveryPlan['phases'][number]['phase'], string> = {
  ilk_72_saat: 'İlk 72 saat',
  ilk_3_ay: 'İlk 3 ay',
  ilk_yil: 'İlk yıl',
  yil_1_5: '1–5. yıl',
}

const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık']
const GROUP_TR = { mammal: 'memeli', bird: 'kuş', reptile: 'sürüngen', amphibian: 'amfibi' } as const

/** Sector (0 = K, clockwise) of a burned cell around the ignition point, or -1 if the cell did not burn. */
export function zoneOfCell(res: SimResult, c: number): number {
  if (c < 0 || res.ignitionStep[c] < 0) return -1
  const { cols } = res.grid
  const o = res.originCell
  const dx = (c % cols) - (o % cols)
  const dy = ((c / cols) | 0) - ((o / cols) | 0)
  if (!dx && !dy) return 0
  return Math.round((((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360) / 45) % 8
}

/** Centre of each sector's burned area (for labels), null where nothing burned. */
export function zoneCentroids(res: SimResult): ([number, number] | null)[] {
  const acc = SECTORS.map(() => [0, 0, 0])
  for (let i = 0; i < res.ignitionStep.length; i++) {
    const z = zoneOfCell(res, i)
    if (z < 0) continue
    const p = cellCenter(res.grid, i)
    acc[z][0] += p[0]
    acc[z][1] += p[1]
    acc[z][2]++
  }
  return acc.map(([a, b, n]) => (n >= 8 ? [a / n, b / n] : null))
}

export function recoveryContext(res: SimResult): RecoveryContext {
  const g = res.grid
  const { cols, rows, kind, elev, cellM } = g
  const region = regionById(res.config.areaId)
  const ig = res.ignitionStep
  const o = res.originCell
  const ha = (n: number) => Math.round((n * cellM * cellM) / 10000)
  const sectorOf = (c: number) => {
    const dx = (c % cols) - (o % cols)
    const dy = ((c / cols) | 0) - ((o / cols) | 0)
    if (!dx && !dy) return 0
    return Math.round((((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360) / 45) % 8
  }
  const z = SECTORS.map(() => ({ n: 0, forest: 0, pine: 0, elev: 0, slope: 0, steep: 0, ax: 0, ay: 0, seed: 0 }))
  for (let i = 0; i < ig.length; i++) {
    if (ig[i] < 0) continue
    const x = i % cols
    const y = (i / cols) | 0
    const e = (dx: number, dy: number) => elev[Math.min(rows - 1, Math.max(0, y + dy)) * cols + Math.min(cols - 1, Math.max(0, x + dx))]
    const gx = (e(1, 0) - e(-1, 0)) / (2 * cellM)
    const gy = (e(0, 1) - e(0, -1)) / (2 * cellM)
    const slope = Math.hypot(gx, gy) * 100
    const k = z[sectorOf(i)]
    k.n++
    k.elev += elev[i]
    k.slope += slope
    if (slope > 30) k.steep++
    // aspect: the way the slope faces (downhill), as a vector
    k.ax += -gx
    k.ay += gy
    if (kind[i] >= 3) {
      k.forest++
      if (kind[i] === 4) k.pine++
      // seed source: unburned forest within ~220 m
      let seed = false
      for (let dy = -2; dy <= 2 && !seed; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx
          const yy = y + dy
          if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) continue
          const j = yy * cols + xx
          if (ig[j] < 0 && kind[j] >= 3) { seed = true; break }
        }
      if (seed) k.seed++
    }
  }
  const zones: RecoveryZone[] = []
  z.forEach((k, s) => {
    if (k.n < 8) return
    const centre: [number, number] = [0, 0]
    let m = 0
    for (let i = 0; i < ig.length; i++)
      if (ig[i] >= 0 && sectorOf(i) === s) {
        const p = cellCenter(g, i)
        centre[0] += p[0]
        centre[1] += p[1]
        m++
      }
    centre[0] /= m
    centre[1] /= m
    zones.push({
      sector: SECTORS[s],
      burned_ha: ha(k.n),
      forest_ha: ha(k.forest),
      pine_share_pct: k.forest ? Math.round((k.pine / k.forest) * 100) : 0,
      mean_elevation_m: Math.round(k.elev / k.n),
      mean_slope_pct: Math.round(k.slope / k.n),
      steep_share_pct: Math.round((k.steep / k.n) * 100),
      main_aspect: compass(((Math.atan2(k.ax, -k.ay) * 180) / Math.PI + 360) % 360),
      seed_source_nearby_pct: k.forest ? Math.round((k.seed / k.forest) * 100) : 0,
      settlements_within_1km: region.settlements.filter((st) => haversineM(st.pos, centre) < 1000 + st.radiusM * 2).map((st) => st.name),
    })
  })
  const f = res.series[res.series.length - 1]
  const w = weatherAt(res.config, 0)
  const sp = SPECIES[res.config.areaId]
  const r = res.response
  return {
    region: region.name,
    total_burned_ha: Math.round(f.affectedHa),
    forest_burned_ha: Math.round(f.forestHa),
    fire_duration_h: Math.round(((r?.extinguishedStep ?? res.steps) * res.stepMin) / 60),
    month: res.config.weather ? MONTHS[Number(res.config.weather.startIso.slice(5, 7)) - 1] : null,
    climate: { afternoon_temperature_c: Math.round(res.config.temperatureC), afternoon_humidity_pct: Math.round(res.config.humidityPct), wind_kmh: Math.round(w.windSpeedKmh), wind_from: compass(res.config.windFromDeg) },
    zones,
    settlements_reached: res.impacts.map((im, i) => (im.arrivalMin !== null ? region.settlements[i].name : null)).filter((x): x is string => !!x),
    species_recorded: sp ? sp.classes.map((c) => ({ group: GROUP_TR[c.key], species: c.species, notable: c.top.slice(0, 3).map((t) => `${t.name ?? t.scientific} (${t.scientific}${t.iucn && t.iucn !== 'NE' ? `, IUCN ${t.iucn}` : ''})`) })) : [],
    response_summary: r ? `${r.decisions.length} karar, ${r.lines.length} güvenlik sınırı, ${r.drops.length} su atışı, ${r.evacuations.length} tahliye; müdahalesiz ${Math.round(r.baseline.affectedHa)} ha yanacaktı.` : null,
  }
}

/** Fallback plan from fixed rules, used when the AI is unavailable. */
export function ruleRecovery(ctx: RecoveryContext): RecoveryPlan {
  const zones = ctx.zones.map((z) => {
    const action: RecoveryAction = z.steep_share_pct >= 35 ? 'erozyon_onlemi' : z.forest_ha < 5 ? 'izleme' : z.pine_share_pct >= 50 && z.seed_source_nearby_pct >= 30 ? 'dogal_yenilenme' : 'dikim'
    const species = z.mean_elevation_m < 800 ? ['Kızılçam (Pinus brutia)', 'Pırnal meşesi (Quercus ilex)', 'Sandal (Arbutus andrachne)'] : z.mean_elevation_m < 1400 ? ['Karaçam (Pinus nigra)', 'Saçlı meşe (Quercus cerris)'] : ['Toros sediri (Cedrus libani)', 'Karaçam (Pinus nigra)']
    const rationale = {
      erozyon_onlemi: `Yanan alanın %${z.steep_share_pct}'i %30'dan dik; ilk yağışlarda toprak kaybı riski yüksek.`,
      izleme: 'Yanan orman alanı küçük; doğal süreç izlenmeli.',
      dogal_yenilenme: `Alan çoğunlukla kızılçam (%${z.pine_share_pct}) ve yanmamış ormana yakın (%${z.seed_source_nearby_pct}); kozalaklardan tohumla kendiliğinden yenilenir.`,
      dikim: `Tohum kaynağı uzak (%${z.seed_source_nearby_pct}) veya maki ağırlıklı; dikim/tohumlama gerekir.`,
    }[action]
    return { sector: z.sector, action, species: action === 'izleme' ? [] : species, timing: action === 'erozyon_onlemi' ? 'İlk sonbahar yağmurlarından önce; dikim sonraki kış' : action === 'dikim' ? 'İlk kış (Kasım–Mart)' : 'İlk 2–3 yıl koruma ve izleme', rationale }
  })
  return {
    summary: `${ctx.region}: ${ctx.total_burned_ha} ha yandı (${ctx.forest_burned_ha} ha orman/maki). ${zones.filter((z) => z.action === 'erozyon_onlemi').length} bölgede önce erozyon önlemi, ${zones.filter((z) => z.action === 'dogal_yenilenme').length} bölgede doğal yenilenme, ${zones.filter((z) => z.action === 'dikim').length} bölgede dikim öneriliyor.`,
    zones,
    prevention: [
      { measure: 'Yangın emniyet yolları ve şeritleri', where: 'Yerleşim–orman ara yüzü', rationale: 'Yangının yerleşimlere ulaşmasını geciktirir, ekiplere erişim sağlar.' },
      { measure: 'Yerleşim çevresinde 30 m yanıcı madde temizliği', where: ctx.settlements_reached.join(', ') || 'Tüm yerleşimler', rationale: 'Ev çevresinde yakıtı azaltmak kıvılcımla tutuşmayı önler.' },
      { measure: 'Yaz aylarında gözetleme ve erken uyarı', where: 'Hâkim tepeler', rationale: 'Erken müdahale yangını küçükken söndürmenin en etkili yolu.' },
    ],
    phases: [
      { phase: 'ilk_72_saat', actions: ['Yeniden alevlenme için soğutma ve devriye', 'Tehlikeli ağaçların yol kenarlarından temizlenmesi', 'Yaralı yaban hayvanları için ekip'] },
      { phase: 'ilk_3_ay', actions: ['Dik yamaçlarda kontur dal çitleri ve dere ıslahı', 'Yanan alana otlatma ve girişin yasaklanması', 'Zarar tespiti'] },
      { phase: 'ilk_yil', actions: ['Doğal yenilenme alanlarında fide sayımı', 'Gerekli alanlarda kış dikimi', 'Yanmış ağaçların kontrollü kesimi'] },
      { phase: 'yil_1_5', actions: ['Tamamlama dikimleri', 'Karışık ve yangına dirençli tür kuşakları', 'Yaban hayatı dönüşünün izlenmesi'] },
    ],
    monitoring: ['Sentinel-2 ile yıllık bitki örtüsü (NDVI) takibi', 'Dikim alanlarında tutma oranı', 'Erozyon ve sel olaylarının kaydı'],
    caveats: 'Kural tabanlı öneri; tür seçimi ve uygulama planı yerel orman işletmesiyle doğrulanmalıdır.',
  }
}
