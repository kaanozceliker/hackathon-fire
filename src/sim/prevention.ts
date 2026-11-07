import { compass, fmtDuration, haversineM, type LatLon } from './geo'
import { cellCenter, cellOf } from './terrain'
import { regionById } from '../data/regions'
import { towerSeeing } from './existing'
import type { Infrastructure } from '../data/infrastructure'
import type { RunOptions } from './response'
import type { SimResult } from './types'

/**
 * "Bugün ne yapabiliriz?" – prevention measures that could be put in place before the next fire, worked out from
 * how the first fire actually spread. Each measure changes the next run in a fixed way (less fuel, earlier
 * response, an extra crew base, an extra water point); the AI (or the rules) choose which to apply.
 */

export type MeasureType = 'yerlesim_temizligi' | 'emniyet_seridi' | 'aralama' | 'gozetleme' | 'on_konuslanma' | 'su_deposu'

export interface Measure {
  id: string
  type: MeasureType
  title: string
  where: string
  /** Cells whose fuel is reduced, and by how much (multiplier). */
  cells: number[]
  fuelMult: number
  point: LatLon | null
  /** Rough cost, thousand TL (illustrative). */
  costK: number
  /** Short note on what the first fire did here. */
  evidence: string
  /** Minutes earlier the response starts (detection). */
  startGainMin: number
}

export const MEASURE_INFO: Record<MeasureType, { label: string; short: string; color: string; what: string; effect: string }> = {
  yerlesim_temizligi: {
    label: 'Yerleşim çevresi yakıt temizliği',
    short: 'Yerleşim temizliği',
    color: '#7fd1ff',
    what: 'Evlerin çevresindeki 150 metrelik kuşakta çalı, kuru ot ve dallar temizlenir; ağaçların alt dalları budanır, taç araları açılır. Bahçe ve tarla kenarları yanmaz örtüyle (bağ, sulu tarım) desteklenir.',
    effect: 'Simülasyonda bu kuşakta yakıt %75 azalır: yangın yerleşime ulaştığında hızı ve kor tutuşması düşer, ekiplere savunma alanı kalır.',
  },
  emniyet_seridi: {
    label: 'Yangın emniyet şeridi',
    short: 'Emniyet şeridi',
    color: '#f2d03b',
    what: 'Yangının ana ilerleme yönüne dik, yaklaşık 330 metre genişliğinde bir şerit açılır: ağaçlar seyreltilir, alt yakıt tamamen alınır, ortasında araçların geçebileceği bir toprak yol bırakılır. Şerit her yıl bakımla temiz tutulur.',
    effect: 'Simülasyonda şeritte yakıt %88 azalır: yangın burada yavaşlar ve kor sıçraması büyük ölçüde kesilir; ekipler şeride güvenle hat kurabilir.',
  },
  aralama: {
    label: 'Aralama ve alt yakıt temizliği',
    short: 'Aralama',
    color: '#b58cff',
    what: 'Sık kızılçam meşcerelerinde ağaçların bir kısmı alınarak taçlar arası açılır, yerdeki iğne yaprak ve çalı katmanı azaltılır, alt dallar budanır. Böylece yangının tepeye çıkıp taç yangınına dönüşmesi zorlaşır.',
    effect: 'Simülasyonda bu alanda yakıt %40 azalır: yangın daha yavaş ilerler ve ilk saatlerde söndürmek kolaylaşır.',
  },
  gozetleme: {
    label: 'Gözetleme kulesi ve kamera',
    short: 'Gözetleme',
    color: '#ffffff',
    what: 'Alanı en geniş gören tepeye yaz boyunca nöbet tutulan bir gözetleme kulesi ve dumanı otomatik algılayan bir kamera kurulur; ihbar doğrudan yangın yönetim merkezine gider.',
    effect: 'Simülasyonda yangın 20 dakika erken fark edilir ve ilk müdahale o kadar erken başlar: yangın küçükken söndürme şansı artar.',
  },
  on_konuslanma: {
    label: 'Yaz ön konuşlanma noktası',
    short: 'Ön konuşlanma',
    color: '#ff8a65',
    what: 'Yangın sezonunda (Haziran–Eylül) ormanın içindeki bu kavşakta 2 arazöz ve 1 iş makinesi hazır bekletilir; ekip barınağı ve su ikmali bulunur.',
    effect: 'Simülasyonda bu ekipler müdahale başlar başlamaz buradan yola çıkar; istasyonlardan gelen ekiplere göre çok daha erken varır.',
  },
  su_deposu: {
    label: 'Yangın havuzu / su deposu',
    short: 'Yangın havuzu',
    color: '#3b9be0',
    what: 'Yanan alanın içinde, yola yakın bir noktada helikopterlerin kova doldurabileceği büyük bir havuz ve arazözler için su dolum noktası yapılır.',
    effect: 'Simülasyonda helikopterler buradan dolum yapar: uzak su kaynaklarına gidip gelme süresi kısalır, su atışı sıklaşır.',
  },
}

/** A short measure of size: area for treated areas, nothing for points. */
export function measureSize(m: Measure, cellM: number): string {
  if (!m.cells.length) return ''
  const ha = Math.round((m.cells.length * cellM * cellM) / 10000)
  return m.type === 'emniyet_seridi' ? `${ha} ha · ~${((m.cells.length / 3) * cellM / 1000).toFixed(1)} km` : `${ha} ha`
}

const HA_CELL = (cellM: number) => (cellM * cellM) / 10000
const T = (step: number) => `T+${fmtDuration(step * 10)}`

/**
 * `wide`: a programme over the whole burned area (used by the "what if" of a past fire) – fuel breaks every few
 * hours of the first fire's path and thinning in all of its forest, instead of only around the ignition.
 */
export function buildCandidates(res: SimResult, infra: Infrastructure, wide = false): Measure[] {
  const g = res.grid
  const { cols, rows, kind, elev, cellM } = g
  const ig = res.ignitionStep
  const region = regionById(res.config.areaId)
  const o = res.originCell
  const ox = o % cols
  const oy = (o / cols) | 0
  const haC = HA_CELL(cellM)
  const out: Measure[] = []
  const burnedNear = (c: number, r: number) => {
    const cx = c % cols
    const cy = (c / cols) | 0
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx
        const y = cy + dy
        if (x >= 0 && y >= 0 && x < cols && y < rows && ig[y * cols + x] >= 0) return true
      }
    return false
  }

  // 1. clear fuel 150 m around settlements the fire reached or came within 2 km of
  region.settlements.forEach((st, i) => {
    const sc = cellOf(g, st.pos[0], st.pos[1])
    if (sc < 0) return
    const reach = st.radiusM + 150
    const cells: number[] = []
    let near = false
    const R = Math.ceil(reach / cellM) + 1
    for (let dy = -R; dy <= R; dy++)
      for (let dx = -R; dx <= R; dx++) {
        const x = (sc % cols) + dx
        const y = ((sc / cols) | 0) + dy
        if (x < 0 || y < 0 || x >= cols || y >= rows) continue
        const j = y * cols + x
        const d = haversineM(cellCenter(g, j), st.pos)
        if (d > reach || d < st.radiusM * 0.8 || kind[j] < 2) continue
        cells.push(j)
        if (burnedNear(j, 18)) near = true
      }
    if (!near || cells.length < 3) return
    const arr = res.impacts[i]?.arrivalMin
    out.push({
      id: `yerlesim-${st.id}`,
      type: 'yerlesim_temizligi',
      title: `${st.name} çevresinde 150 m yakıt temizliği`,
      where: st.name,
      cells,
      fuelMult: 0.25,
      point: null,
      costK: Math.round(cells.length * haC * 25),
      evidence: arr !== null && arr !== undefined ? `İlk yangın ${st.name} sınırına ${T(Math.round(arr / 10))}'da ulaştı.` : `İlk yangın ${st.name}'e 2 km'den yakın geçti.`,
      startGainMin: 0,
    })
  })

  // 2. fuel breaks across the main spread axis, where the first fire passed ~2 h and ~4 h after ignition
  let sx = 0
  let sy = 0
  let n = 0
  for (let i = 0; i < ig.length; i++)
    if (ig[i] >= 0) {
      sx += (i % cols) - ox
      sy += ((i / cols) | 0) - oy
      n++
    }
  const len = Math.hypot(sx, sy) || 1
  const ax = sx / len
  const ay = sy / len
  const heading = ((Math.atan2(ax, -ay) * 180) / Math.PI + 360) % 360
  const lastStep = ig.reduce((a, b) => Math.max(a, b), 0)
  const stripHours = wide ? [2, 4, 6, 9, 12, 15].filter((h) => h * 6 < lastStep) : [2, 4]
  for (const [k0, hours] of stripHours.entries()) {
    const k = k0 + 1
    // distance along the axis the fire had reached by then
    let d = 0
    for (let i = 0; i < ig.length; i++)
      if (ig[i] >= 0 && ig[i] <= hours * 6) d = Math.max(d, ((i % cols) - ox) * ax + (((i / cols) | 0) - oy) * ay)
    d += 4
    const cells: number[] = []
    for (let i = 0; i < ig.length; i++) {
      if (kind[i] < 2) continue
      const px = (i % cols) - ox
      const py = ((i / cols) | 0) - oy
      const along = px * ax + py * ay
      if (Math.abs(along - d) > 1.5) continue
      if (burnedNear(i, 5)) cells.push(i)
    }
    if (cells.length < 6) continue
    out.push({
      id: `serit-${k}`,
      type: 'emniyet_seridi',
      title: `${k}. yangın emniyet şeridi (~330 m genişlik, ${((cells.length / 3) * cellM / 1000).toFixed(1)} km)`,
      where: `${compass(heading)} yönünde, tutuşma noktasından ~${((d * cellM) / 1000).toFixed(1)} km`,
      cells,
      fuelMult: 0.12,
      point: null,
      costK: Math.round(cells.length * haC * 15),
      evidence: `İlk yangın ana ekseninde (${compass(heading)}) bu çizgiye ~${hours} saatte ulaştı.`,
      startGainMin: 0,
    })
  }

  // 3. thinning and surface fuel removal in pine stands near the ignition on the downwind side
  const thin: number[] = []
  for (let i = 0; i < ig.length; i++) {
    if (kind[i] !== 4) continue
    if (wide) {
      if (burnedNear(i, 1)) thin.push(i)
      continue
    }
    const px = (i % cols) - ox
    const py = ((i / cols) | 0) - oy
    if (Math.hypot(px, py) > 10 || px * ax + py * ay < -1) continue
    thin.push(i)
  }
  if (thin.length > 10)
    out.push({
      id: 'aralama-1',
      type: 'aralama',
      title: 'Kızılçam meşcerelerinde aralama ve alt yakıt temizliği',
      where: wide ? 'Yangın alanındaki bütün orman' : 'Tutuşma noktasının 1 km çevresi, rüzgar altı',
      cells: thin,
      fuelMult: 0.6,
      point: null,
      costK: Math.round(thin.length * haC * 8),
      evidence: wide ? `Yangın ormanın ${Math.round(thin.length * haC)} hektarında taç yangınına dönüşebilecek yoğun yakıtla ilerledi.` : `Yangın bu yoğun çam alanında başladı ve ilk saatte en hızlı burada büyüdü.`,
      startGainMin: 0,
    })

  // 4. lookout tower on the highest point near the burned area: earlier detection
  let best = -1
  for (let i = 0; i < ig.length; i++) if (kind[i] !== 0 && burnedNear(i, 12) && (best < 0 || elev[i] > elev[best])) best = i
  // no new tower where an existing one already sees the fire
  if (best >= 0 && (res.config.ignoreExisting || !towerSeeing(g.areaId, cellCenter(g, o))))
    out.push({
      id: 'kule-1',
      type: 'gozetleme',
      title: 'Gözetleme kulesi ve yangın kamerası',
      where: `En yüksek tepe (${Math.round(elev[best])} m)`,
      cells: [],
      fuelMult: 1,
      point: cellCenter(g, best),
      costK: 900,
      evidence: 'Erken tespit, ilk müdahalenin ~20 dakika önce başlamasını sağlar; yangın küçükken söndürülebilir.',
      startGainMin: 20,
    })

  // 5. summer pre-positioning base at the road junction nearest the burned area
  const burnedCentre: LatLon = cellCenter(g, cellOf(g, cellCenter(g, o)[0], cellCenter(g, o)[1]))
  const junctions = infra.nodes.filter((x) => x.kind === 'junction')
  const jn = junctions.reduce((a, b) => (haversineM(b.pos, burnedCentre) < haversineM(a.pos, burnedCentre) ? b : a), junctions[0])
  if (jn)
    out.push({
      id: 'onkonus-1',
      type: 'on_konuslanma',
      title: 'Yaz dönemi ön konuşlanma noktası (2 arazöz, 1 iş makinesi)',
      where: jn.name,
      cells: [],
      fuelMult: 1,
      point: jn.pos,
      costK: 1500,
      evidence: `İlk yangında en yakın istasyondan varış uzun sürdü; bu nokta tutuşma alanına ${(haversineM(jn.pos, burnedCentre) / 1000).toFixed(1)} km.`,
      startGainMin: 0,
    })

  // 6. a fire pond next to a road in the burned area, far from existing water
  let pond: LatLon | null = null
  let far = 0
  for (const x of junctions) {
    const c = cellOf(g, x.pos[0], x.pos[1])
    if (c < 0 || !burnedNear(c, 6)) continue
    const dw = Math.min(...infra.water.map((w) => haversineM(w.pos, x.pos)))
    if (dw > far) {
      far = dw
      pond = x.pos
    }
  }
  if (pond && far > 2500)
    out.push({
      id: 'havuz-1',
      type: 'su_deposu',
      title: 'Yangın havuzu (helikopter dolumu)',
      where: `Yanan alanın içinde, en yakın su kaynağına ${(far / 1000).toFixed(1)} km`,
      cells: [],
      fuelMult: 1,
      point: pond,
      costK: 600,
      evidence: 'Helikopterler ilk yangında uzak su kaynaklarına gidip geldi; yakın havuz su atışını sıklaştırır.',
      startGainMin: 0,
    })
  return out
}

export interface PreventionContext {
  region: string
  first_fire: { burned_ha: number; forest_ha: number; duration_h: number; settlements_reached: string[]; response_started_min: number; spreading_toward: string }
  candidates: { id: string; type: MeasureType; title: string; where: string; area_ha: number; cost_thousand_tl: number; evidence: string }[]
}

export function preventionContext(res: SimResult, cands: Measure[], responseStartMin: number): PreventionContext {
  const region = regionById(res.config.areaId)
  const f = res.series[res.series.length - 1]
  const haC = HA_CELL(res.grid.cellM)
  return {
    region: region.name,
    first_fire: {
      burned_ha: Math.round(f.affectedHa),
      forest_ha: Math.round(f.forestHa),
      duration_h: Math.round(((res.response?.extinguishedStep ?? res.steps) * 10) / 60),
      settlements_reached: res.impacts.map((im, i) => (im.arrivalMin !== null ? region.settlements[i].name : null)).filter((x): x is string => !!x),
      response_started_min: responseStartMin,
      spreading_toward: cands.find((c) => c.type === 'emniyet_seridi')?.where ?? '',
    },
    candidates: cands.map((c) => ({ id: c.id, type: c.type, title: c.title, where: c.where, area_ha: Math.round(c.cells.length * haC), cost_thousand_tl: c.costK, evidence: c.evidence })),
  }
}

export interface PreventionPlan {
  summary: string
  selected: { id: string; priority: number; rationale: string }[]
  expected_effect: string
  caveats: string
}

/** Fallback choice: protect reached settlements, cut the main axis, detect earlier, add crews. */
export function rulePrevention(ctx: PreventionContext): PreventionPlan {
  const pick = ctx.candidates
    .filter((c) => c.type !== 'aralama' || ctx.first_fire.forest_ha > 500)
    .slice(0, 7)
  return {
    summary: `İlk yangında ${ctx.first_fire.burned_ha} ha yandı. Önce yangının ulaştığı yerleşimlerin çevresi temizleniyor, ana yayılma ekseni emniyet şeritleriyle bölünüyor ve erken tespit ile ilk müdahale güçlendiriliyor.`,
    selected: pick.map((c, i) => ({ id: c.id, priority: i + 1, rationale: c.evidence })),
    expected_effect: 'Yerleşimlere ulaşma süresinin uzaması ve yanan alanın küçülmesi beklenir.',
    caveats: 'Kural tabanlı seçim; maliyetler temsilîdir.',
  }
}

/** Turns the chosen measures into run options and the earlier response start. */
export function measuresToRun(cands: Measure[], ids: string[], grid: SimResult['grid'], infra: Infrastructure): { opts: RunOptions; startGainMin: number } {
  const chosen = cands.filter((c) => ids.includes(c.id))
  const mult = new Float32Array(grid.cols * grid.rows).fill(1)
  for (const c of chosen) for (const i of c.cells) mult[i] = Math.min(mult[i], c.fuelMult)
  const base = chosen.find((c) => c.type === 'on_konuslanma')?.point ?? undefined
  const pond = chosen.find((c) => c.type === 'su_deposu')
  return {
    opts: {
      fuelMult: mult,
      extraBase: base,
      extraWater: pond?.point ? [{ id: 'havuz-yeni', name: 'Yeni yangın havuzu', pos: pond.point, kind: 'reservoir', note: 'Önlem: helikopter dolum havuzu' }] : [],
    },
    startGainMin: chosen.reduce((s, c) => s + c.startGainMin, 0),
  }
  void infra
}
